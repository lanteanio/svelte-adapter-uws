import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { hasUWS } from './helpers/real-runtime.js';

const run = promisify(execFile);

it.skipIf(!hasUWS)('sends a ready finite SSR body before a pipelined parser refusal in plain Node', async () => {
	const source = `
import net from 'node:net';
import { startRealRuntime } from './test/helpers/real-runtime.js';
const server = await startRealRuntime();
const results = [];
try {
	for (const cookie of ['', 'Cookie: session=test\\r\\n']) {
		results.push(await new Promise((resolve, reject) => {
			let raw = '';
			const socket = net.connect(server.port, '127.0.0.1');
			const timer = setTimeout(() => { socket.destroy(); reject(new Error('response did not close')); }, 5000);
			socket.on('data', chunk => { raw += chunk.toString('latin1'); });
			socket.on('error', reject);
			socket.on('close', () => { clearTimeout(timer); resolve(raw); });
			socket.on('connect', () => socket.write('GET /big-shared?kb=64&after=10 HTTP/1.1\\r\\nHost: localhost\\r\\n' + cookie + '\\r\\nGET /healthz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n'));
		}));
	}
} finally { await server.stop(); }
console.log('READINESS_RESULT ' + JSON.stringify(results));
`;
	const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', source], {
		cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 60000, maxBuffer: 1024 * 1024
	});
	const line = stdout.split(/\r?\n/).find(line => line.startsWith('READINESS_RESULT '));
	expect(line, stdout).toBeDefined();
	const results = JSON.parse(line.slice('READINESS_RESULT '.length));
	expect(results).toHaveLength(2);
	for (const raw of results) {
		const split = raw.indexOf('\r\n\r\n');
		expect(raw.slice(0, split)).toMatch(/^HTTP\/1\.1 200/);
		expect(raw.slice(0, split)).toMatch(/content-length: 65536/i);
		expect(raw.slice(split + 4, split + 4 + 65536)).toBe('c'.repeat(65536));
		expect(raw.slice(split + 4 + 65536)).toMatch(/^HTTP\/1\.1 505/);
	}
}, 90000);
