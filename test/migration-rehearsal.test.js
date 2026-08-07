import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasUWS } from './helpers/real-runtime.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/migration-0.5', import.meta.url));
const currentPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The wire half needs the native runtime; it skips VISIBLY without it (and
// helpers/real-runtime.js fails the whole file under CI when uWS is absent),
// so a pass can never mean "the real half silently did not run".
const itUWS = hasUWS ? it : it.skip;

function lockFields(source) {
	return Object.fromEntries(source.trim().split(/\r?\n/).map((line) => {
		const at = line.indexOf('=');
		return [line.slice(0, at), line.slice(at + 1)];
	}));
}

function compatibilityRows() {
	const lines = readFileSync(new URL('../docs/compatibility.v1.csv', import.meta.url), 'utf8')
		.trim().split(/\r?\n/);
	const headers = lines.shift().split(',');
	return lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
}

// Windows has no `npm` executable on PATH that execFile can spawn directly,
// so npm is driven through its own CLI entry under the running node.
function npmCommand() {
	return process.platform === 'win32' ? process.execPath : 'npm';
}

function npmArgs() {
	return process.platform === 'win32'
		? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
		: [];
}

function packInto(temp) {
	const packArgs = ['pack', '--json', '--pack-destination', temp];
	const command = npmCommand();
	const args = [...npmArgs(), ...packArgs];
	const packed = JSON.parse(execFileSync(command, args, {
		cwd: root,
		encoding: 'utf8',
		timeout: 120000
	}));
	return path.join(temp, packed[0].filename);
}

function migrateConsumer(consumer) {
	const packagePath = path.join(consumer, 'package.json');
	const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
	manifest.dependencies['svelte-adapter-uws'] = currentPackage.version;
	manifest.optionalDependencies = {
		'uWebSockets.js': currentPackage.optionalDependencies['uWebSockets.js']
	};
	writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');

	const hooksPath = path.join(consumer, 'hooks.ws.js');
	const hooks = readFileSync(hooksPath, 'utf8');
	const oldProjection = "\tkey: 'id',\n\tbinary: false,";
	const explicitProjection = "\tkey: 'id',\n\tselect: ({ id, name }) => ({ id, name }),\n\tclientUpdateFields: ['typing'],\n\tbinary: false,";
	if (!hooks.includes(oldProjection)) throw new Error('0.5 projection fixture drifted');
	writeFileSync(hooksPath, hooks.replace(oldProjection, explicitProjection));

	const publishPath = path.join(consumer, 'publish.js');
	const publish = readFileSync(publishPath, 'utf8');
	const oldPublish = "\t\tname: user.name\n\t});";
	const explicitSequence = "\t\tname: user.name\n\t}, { seq: false });";
	if (!publish.includes(oldPublish)) throw new Error('0.5 sequence fixture drifted');
	writeFileSync(publishPath, publish.replace(oldPublish, explicitSequence));
}

// Copy the locked fixture, apply the documented migration edits, and REALLY
// install the packed candidate: extracting the tarball would give the
// package's files without its declared dependency tree, so a runtime module
// importing a production dependency fails at import time and the rehearsal
// proves nothing about what a consumer actually gets. npm resolves the same
// graph a consumer would; --no-audit/--no-fund keep it offline-fast, and the
// optional native addon is omitted here - the wire half links it in
// explicitly from this repository's own tree.
function prepareMigratedConsumer(temp) {
	const consumer = path.join(temp, 'consumer');
	cpSync(fixture, consumer, { recursive: true });
	migrateConsumer(consumer);

	const tarball = packInto(temp);
	if (!existsSync(tarball)) throw new Error('npm pack produced no tarball');
	execFileSync(npmCommand(), [...npmArgs(), 'install', tarball,
		'--no-audit', '--no-fund', '--omit=optional', '--ignore-scripts'
	], {
		cwd: consumer,
		encoding: 'utf8',
		timeout: 300000
	});
	const installed = path.join(consumer, 'node_modules', 'svelte-adapter-uws');
	if (!existsSync(path.join(installed, 'package.json'))) throw new Error('tarball did not install');
	return consumer;
}

describe('0.5 to 0.6 executable migration route', () => {
	it('migrates the locked 0.5.8 consumer to the packed candidate and executes its modules', async () => {
		const baseline = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
		const lock = lockFields(readFileSync(path.join(fixture, 'baseline.lock'), 'utf8'));
		const rows = compatibilityRows();
		// Bound to the row whose adapter version IS the locked baseline's, not
		// to whichever row currently holds the stable channel: the baseline is
		// a fact about ITS era, and the binding must survive that era leaving
		// the stable slot at the next promotion.
		const era = rows.find((row) => row.adapter_version === lock['adapter.version']);
		const candidate = rows.find((row) => row.current === 'true');

		expect(baseline.dependencies['svelte-adapter-uws']).toBe('0.5.8');
		expect(lock['adapter.version']).toBe(baseline.dependencies['svelte-adapter-uws']);
		expect(lock['adapter.integrity']).toBe('sha512-XG1DLduJDO+p6cK49NFd0ItJTuRXRVXhtukBNGS3ikW7NwUV2OIF+qhG0piNBP+vAVyvMfLvWM7sPVttFfBMjg==');
		// The baseline quotes its era's native install spec WHOLE and verbatim
		// - decomposing it into pieces would hide it from the pin scanner and
		// from anyone grepping for the tag. The scanner detects it and allows
		// exactly its own era's ref, because that ref is an authenticated
		// historical compatibility fact; a baseline naming any other tag fails
		// the pin gate like a stale spec.
		expect(era, 'the compatibility manifest no longer records the baseline era').toBeTruthy();
		expect(lock['uwebsockets']).toBe(era.uwebsockets);
		expect(candidate.adapter_version).toBe(currentPackage.version);
		expect(candidate.uwebsockets).toBe(currentPackage.optionalDependencies['uWebSockets.js']);

		const temp = mkdtempSync(path.join(tmpdir(), 'adapter-uws-migration-'));
		try {
			const consumer = prepareMigratedConsumer(temp);

			const hooks = await import(pathToFileURL(path.join(consumer, 'hooks.ws.js')).href);
			const subscriptions = new Set();
			const ws = {
				getUserData: () => ({
					id: 'operator-1',
					name: 'Alice',
					role: 'admin',
					sessionToken: 'must-not-project'
				}),
				subscribe(topic) { subscriptions.add(topic); return true; },
				unsubscribe(topic) { return subscriptions.delete(topic); },
				isSubscribed(topic) { return subscriptions.has(topic); }
			};
			const sent = [];
			const platform = {
				send(_ws, topic, event, data) { sent.push({ topic, event, data }); return 1; },
				publish(topic, event, data, options) { sent.push({ topic, event, data, options }); return true; }
			};
			hooks.presence.join(ws, 'operators', platform);
			hooks.presence.flushDiffs();
			expect(hooks.presence.list('operators')).toEqual([{ id: 'operator-1', name: 'Alice' }]);
			expect(JSON.stringify(sent)).not.toContain('sessionToken');
			expect(JSON.stringify(sent)).not.toContain('admin');

			const publishing = await import(pathToFileURL(path.join(consumer, 'publish.js')).href);
			// Shape check only - the wire rehearsal below owns the publish
			// proof; this pins that the migrated source carries the documented
			// option.
			publishing.announce(platform, { id: 'operator-1', name: 'Alice' });
			expect(sent.at(-1).options).toEqual({ seq: false });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}, 180000);

	// The migrated consumer RUNS against the installed adapter, not a
	// stand-in: the fixture's own server.mjs boots the dependency's real
	// server, and the proof is what a real WebSocket client is DELIVERED. A
	// platform mock echoing its inputs back cannot fail; a wire either
	// carries the seq field or it does not. The native addon was omitted
	// from the consumer install, so the runtime is linked in from this
	// repository's own dependency tree - same package, same version the
	// suite runs everywhere else.
	itUWS('boots the migrated consumer and proves the documented edits on the wire', async () => {
		const temp = mkdtempSync(path.join(tmpdir(), 'adapter-uws-migration-wire-'));
		try {
			const consumer = prepareMigratedConsumer(temp);

			const nativeSource = path.join(root, 'node_modules', 'uWebSockets.js');
			if (!existsSync(nativeSource)) {
				throw new Error('uWebSockets.js resolves but is not at the repository root; the rehearsal cannot link it into the consumer');
			}
			symlinkSync(nativeSource, path.join(consumer, 'node_modules', 'uWebSockets.js'), 'junction');

			const app = await (await import(pathToFileURL(path.join(consumer, 'server.mjs')).href)).boot();
			let client = null;
			try {
				const { WebSocket } = await import('ws');
				client = new WebSocket(app.wsUrl);
				const frames = [];
				client.on('message', (data) => frames.push(String(data)));
				await new Promise((res, rej) => { client.on('open', res); client.on('error', rej); });

				// A ref'd subscribe, so the server ACKS it and the wait below
				// observes the confirmation instead of expiring a timer.
				client.send(JSON.stringify({ type: 'subscribe', topic: 'presence-audit', ref: 1 }));
				const parsed = () => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
				const acked = () => parsed().some((m) => m.type === 'subscribed' && m.topic === 'presence-audit');
				for (let i = 0; i < 200 && !acked(); i++) await new Promise((r) => setTimeout(r, 10));
				expect(acked(), 'the server never acknowledged the subscription').toBe(true);

				const announced = () => parsed().filter((m) => m.topic === 'presence-audit' && m.event === 'changed');
				expect(app.announce(app.platform, {
					id: 'operator-1',
					name: 'Alice',
					sessionToken: 'must-not-reach-the-wire'
				})).toBe(true);
				for (let i = 0; i < 200 && announced().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
				const delivered = announced()[0];
				expect(delivered, 'the migrated publish never reached a real subscriber').toBeTruthy();
				expect(delivered.data).toEqual({ id: 'operator-1', name: 'Alice' });
				// The documented sequence edit, observed on the wire: the
				// migrated call publishes seq-less.
				expect('seq' in delivered, 'the migrated { seq: false } publish stamped a seq anyway').toBe(false);
				expect(JSON.stringify(frames)).not.toContain('must-not-reach-the-wire');

				// Non-vacuity control: the same publish WITHOUT the documented
				// edit - what unmigrated 0.5 code does - stamps the counter on
				// a single worker, so the seq assertion above is
				// discriminating, not decorative.
				app.platform.publish('presence-audit', 'changed', { id: 'control' });
				for (let i = 0; i < 200 && announced().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
				const control = announced()[1];
				expect(control, 'the control publish never arrived').toBeTruthy();
				expect(typeof control.seq, 'an options-less publish must stamp the counter seq').toBe('number');
			} finally {
				try { client?.terminate(); } catch { /* already gone */ }
				await app.close();
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}, 180000);
});
