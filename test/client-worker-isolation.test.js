import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const specifier = file => JSON.stringify(pathToFileURL(file).href);

it('isolates client modules and application registries between files in one VM worker', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'client-worker-isolation-'));
	const client = specifier(path.join(root, 'src/client.js'));
	const runtime = specifier(path.join(root, 'src/client-runtime.js'));
	const symbols = specifier(path.join(root, 'src/runtime/utils/ws-symbols.js'));
	const vitestRoot = path.dirname(require.resolve('vitest/package.json'));
	const vitest = specifier(path.join(vitestRoot, 'dist/index.js'));
	const ws = specifier(path.join(path.dirname(require.resolve('ws/package.json')), 'wrapper.mjs'));
	try {
		writeFileSync(path.join(directory, '01-mock.test.js'), `
import { expect, it } from ${vitest};
import * as client from ${client};
import { setRuntimeEnv } from ${runtime};
import { setSubscriptionAccountingHook } from ${symbols};
it('owns an open mock singleton and injected timers', () => {
	class Socket {
		static CONNECTING = 0; static OPEN = 1;
		constructor() { this.readyState = 1; }
		send() {}
		close() { this.readyState = 3; }
	}
	globalThis.WebSocket = Socket;
	setRuntimeEnv({ timers: { set: () => null, setInterval: () => null, setImmediate: () => null, clear() {}, clearInterval() {} } });
	const connection = client.connect({ url: 'ws://mock.invalid/ws' });
	expect(connection.send({ kind: 'mock' })).toBe(true);
	setSubscriptionAccountingHook(() => {});
	globalThis[Symbol.for('adapter-uws.derived-topic-prefixes')].add('previous-file:');
	globalThis[Symbol.for('svelte-adapter-uws.dashboard-contributors')] = new Map([['previous-file', true]]);
	globalThis[Symbol.for('test.unrelated-global')] = 'preserved';
	globalThis.__uws_dev_platform = { previousFile: true };
});
`);
		writeFileSync(path.join(directory, '02-real.test.js'), `
import { expect, it } from ${vitest};
import { once } from 'node:events';
import { WebSocketServer } from ${ws};
import { setSubscriptionAccountingHook } from ${symbols};
import * as client from ${client};
it('starts connecting and delivers to its own real server', async () => {
	expect(setSubscriptionAccountingHook(() => {}), 'accounting starts without a previous file sink').toBe(false);
	setSubscriptionAccountingHook(null);
	expect(globalThis[Symbol.for('adapter-uws.derived-topic-prefixes')].has('previous-file:')).toBe(false);
	expect(globalThis[Symbol.for('svelte-adapter-uws.dashboard-contributors')]).toBeUndefined();
	expect(globalThis.__uws_dev_platform).toBeUndefined();
	expect(globalThis[Symbol.for('test.unrelated-global')]).toBe('preserved');
	delete globalThis[Symbol.for('test.unrelated-global')];
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	let connection;
	const frames = [];
	server.on('connection', socket => socket.on('message', bytes => frames.push(bytes.toString())));
	try {
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
		expect(connection.send({ kind: 'connecting' })).toBe(false);
		await client.ready();
		expect(connection.send({ kind: 'real' })).toBe(true);
		await expect.poll(() => frames.includes('{"kind":"real"}')).toBe(true);
		expect(frames).not.toContain('{"kind":"connecting"}');
	} finally {
		connection?.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
	}
});
`);
		const report = path.join(directory, 'results.json');
		const config = path.join(directory, 'vitest.config.mjs');
		writeFileSync(config, `
import base from ${specifier(path.join(root, 'vitest.config.js'))};
import { BaseSequencer } from ${specifier(require.resolve('vitest/node'))};
class Ordered extends BaseSequencer {
	sort(tests) { return tests.sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
	...base,
	root: ${JSON.stringify(root)},
	test: {
		...base.test,
		projects: undefined,
		globalSetup: [],
		include: [${JSON.stringify(path.join(directory, '*.test.js').replaceAll('\\', '/'))}],
		exclude: [],
		pool: base.test.pool,
		maxWorkers: 1,
		sequence: { ...base.test.sequence, sequencer: Ordered },
		reporters: ['json'],
		outputFile: ${JSON.stringify(report)}
	}
};
`);
		const result = await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [path.join(vitestRoot, 'vitest.mjs'), 'run', '--config', config], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			const timeout = setTimeout(() => { child.kill(); reject(new Error('Client isolation child timed out: ' + output)); }, 45000);
			child.stdout.on('data', bytes => { output += bytes; });
			child.stderr.on('data', bytes => { output += bytes; });
			child.once('error', error => { clearTimeout(timeout); reject(error); });
			child.once('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
		});
		const results = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null;
		expect(result.code, result.output + '\n' + JSON.stringify(results?.testResults, null, 2)).toBe(0);
		expect(results.numPassedTests).toBe(2);
		expect(results.numFailedTests).toBe(0);
		expect(results.numPendingTests).toBe(0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 60000);
