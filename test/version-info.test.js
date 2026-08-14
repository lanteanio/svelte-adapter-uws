import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS } from './helpers/real-runtime.js';
import {
	formatVersionBanner,
	readRuntimeVersionInfo,
	resolvedPackageVersion
} from '../src/runtime/version-info.js';
import { createTestServer } from '../src/testing.js';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');
const describeNative = hasUWS ? describe : describe.skip;

let child = null;

afterEach(async () => {
	if (child && !child.killed) {
		try { child.kill(); } catch {}
	}
	child = null;
});

describe('runtime version identity', () => {
	it('reads adapter/protocol metadata instead of duplicating literals', () => {
		const info = readRuntimeVersionInfo();
		const shape = (value) =>
			value === null || value === 'unresolvable' || /^\d+\.\d+\.\d+/.test(value);
		expect(info.adapter).toBe(rootPackage.version);
		expect(info.protocolRevision).toBe(1);
		expect(shape(info.realtime)).toBe(true);
		expect(shape(info.extensions)).toBe(true);
		expect(formatVersionBanner({
			adapter: '1.2.3',
			protocolRevision: 7,
			realtime: '4.5.6',
			extensions: null
		})).toBe(
			'svelte-adapter-uws 1.2.3 (protocol rev 7, svelte-realtime 4.5.6, ' +
			'svelte-adapter-uws-extensions not installed)'
		);
	});

	it('distinguishes an absent sibling from a present but unreadable one', () => {
		// Absence is only what the resolver calls absence. The second probe
		// reaches this package itself through an unexported subpath - the
		// present-but-unreadable shape - which must not print as absence.
		expect(resolvedPackageVersion('a-package-that-does-not-exist-anywhere', 'x')).toBe(null);
		expect(resolvedPackageVersion(
			'svelte-adapter-uws/definitely-not-exported',
			'svelte-adapter-uws'
		)).toBe('unresolvable');
		expect(formatVersionBanner({
			adapter: '1.2.3',
			protocolRevision: 7,
			realtime: 'unresolvable',
			extensions: null
		})).toContain('svelte-realtime unresolvable');
	});
});

describeNative('runtime version diagnostics', () => {
	beforeAll(() => {
		expect(buildFixtureOnce()).toBe(true);
	}, 400000);

	it('includes the same tuple in platform introspection', async () => {
		const server = await createTestServer();
		try {
			expect(server.platform.introspect().versions).toEqual(readRuntimeVersionInfo());
		} finally {
			await server.close();
		}
	});

	it('ships runtime metadata and prints one boot banner without inlining sibling versions', async () => {
		const adapterMeta = JSON.parse(
			readFileSync(path.join(fixtureDir, 'build', 'meta', 'svelte-adapter-uws', 'package.json'), 'utf8')
		);
		const protocolMeta = JSON.parse(
			readFileSync(path.join(fixtureDir, 'build', 'meta', 'protocol.schema.json'), 'utf8')
		);
		const runtimeSource = readFileSync(path.join(fixtureDir, 'build', 'version-info.js'), 'utf8');
		expect(adapterMeta.version).toBe(rootPackage.version);
		expect(protocolMeta.$id).toMatch(/revision-1$/);
		expect(runtimeSource).toContain('import.meta.resolve(specifier)');
		expect(runtimeSource).not.toContain(rootPackage.version);

		const { banner, output } = await spawnForBanner();
		expect(banner, output).toBe(
			'svelte-adapter-uws ' + rootPackage.version +
			' (protocol rev 1, svelte-realtime not installed, ' +
			'svelte-adapter-uws-extensions not installed)'
		);
	}, 30000);

	it('resolves a genuinely installed sibling from the built runtime', async () => {
		// The absence expectations above cannot tell a working resolver from a
		// broken one: a bundling change that left import.meta.resolve throwing
		// on every call would still print a non-version. A stub package makes
		// the positive path falsifiable - if resolution stops working after
		// bundling, the banner stops carrying this version and this fails.
		const stubDir = path.join(fixtureDir, 'node_modules', 'svelte-realtime');
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
			name: 'svelte-realtime',
			version: '0.0.0-resolution-probe',
			type: 'module',
			exports: { '.': './index.js' }
		}) + '\n');
		writeFileSync(path.join(stubDir, 'index.js'), 'export {};\n');
		try {
			const { banner, output } = await spawnForBanner();
			expect(banner, output).toBe(
				'svelte-adapter-uws ' + rootPackage.version +
				' (protocol rev 1, svelte-realtime 0.0.0-resolution-probe, ' +
				'svelte-adapter-uws-extensions not installed)'
			);
		} finally {
			rmSync(stubDir, { recursive: true, force: true });
		}
	}, 30000);
});

function spawnForBanner() {
	let output = '';
	return new Promise((resolveBanner) => {
		child = spawn(process.execPath, [builtEntry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CLUSTER_WORKERS: '' }
		});
		const scan = (chunk) => {
			output += chunk.toString();
			const line = output.split(/\r?\n/).find((candidate) =>
				candidate.startsWith('svelte-adapter-uws ')
			);
			if (line) resolveBanner({ banner: line, output });
		};
		child.stdout.on('data', scan);
		child.stderr.on('data', scan);
		child.on('exit', () => resolveBanner({ banner: null, output }));
		setTimeout(() => resolveBanner({ banner: null, output }), 15000);
	});
}
