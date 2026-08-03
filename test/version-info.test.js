import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS } from './helpers/real-runtime.js';
import {
	formatVersionBanner,
	readRuntimeVersionInfo
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
		expect(info.adapter).toBe(rootPackage.version);
		expect(info.protocolRevision).toBe(1);
		expect(info.realtime === null || /^\d+\.\d+\.\d+/.test(info.realtime)).toBe(true);
		expect(info.extensions === null || /^\d+\.\d+\.\d+/.test(info.extensions)).toBe(true);
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

		let output = '';
		const banner = await new Promise((resolveBanner) => {
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
				if (line) resolveBanner(line);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolveBanner(null));
			setTimeout(() => resolveBanner(null), 15000);
		});

		expect(banner, output).toBe(
			'svelte-adapter-uws ' + rootPackage.version +
			' (protocol rev 1, svelte-realtime not installed, ' +
			'svelte-adapter-uws-extensions not installed)'
		);
	}, 30000);
});
