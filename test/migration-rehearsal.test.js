import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/migration-0.5', import.meta.url));
const currentPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

function packInto(temp) {
	const packArgs = ['pack', '--json', '--pack-destination', temp];
	const command = process.platform === 'win32' ? process.execPath : 'npm';
	const args = process.platform === 'win32'
		? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...packArgs]
		: packArgs;
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

describe('0.5 to 0.6 executable migration route', () => {
	it('migrates the locked 0.5.8 consumer to the packed candidate and executes it', async () => {
		const baseline = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
		const lock = lockFields(readFileSync(path.join(fixture, 'baseline.lock'), 'utf8'));
		const rows = compatibilityRows();
		const stable = rows.find((row) => row.channel === 'stable');
		const candidate = rows.find((row) => row.current === 'true');

		expect(baseline.dependencies['svelte-adapter-uws']).toBe('0.5.8');
		expect(lock['adapter.version']).toBe(baseline.dependencies['svelte-adapter-uws']);
		expect(lock['adapter.integrity']).toBe('sha512-XG1DLduJDO+p6cK49NFd0ItJTuRXRVXhtukBNGS3ikW7NwUV2OIF+qhG0piNBP+vAVyvMfLvWM7sPVttFfBMjg==');
		const lockedNative = lock['uwebsockets.repository.scheme'] +
			lock['uwebsockets.repository.owner'] + '/' + lock['uwebsockets.repository.name'] + '#' +
			lock['uwebsockets.ref.prefix'] + lock['uwebsockets.ref.suffix'];
		expect(lockedNative).toBe(stable.uwebsockets);
		expect(candidate.adapter_version).toBe(currentPackage.version);
		expect(candidate.uwebsockets).toBe(currentPackage.optionalDependencies['uWebSockets.js']);

		const temp = mkdtempSync(path.join(tmpdir(), 'adapter-uws-migration-'));
		try {
			const consumer = path.join(temp, 'consumer');
			cpSync(fixture, consumer, { recursive: true });
			migrateConsumer(consumer);

			const tarball = packInto(temp);
			expect(existsSync(tarball)).toBe(true);
			const installed = path.join(consumer, 'node_modules', 'svelte-adapter-uws');
			mkdirSync(installed, { recursive: true });
			execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'], {
				encoding: 'utf8',
				timeout: 120000
			});

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
			expect(publishing.announce(platform, { id: 'operator-1', name: 'Alice' })).toBe(true);
			expect(sent.at(-1).options).toEqual({ seq: false });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}, 180000);
});
