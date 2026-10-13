import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { EVAL_TIME_ENV, hasUWS } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const childPath = fileURLToPath(new URL('./helpers/fd-runtime-child.mjs', import.meta.url));

async function boot(soft, check) {
	const reservation = createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const assignedPort = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const env = { ...process.env };
	for (const name of EVAL_TIME_ENV) delete env[name];
	delete env.SOCKET_PATH;
	delete env.NOTIFY_SOCKET;
	Object.assign(env, { HOST: '127.0.0.1', PORT: String(assignedPort), ORIGIN: 'http://localhost' });
	const child = spawn(process.execPath, [childPath, String(soft)], {
		env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => finish(new Error(`Runtime boot timed out:\n${output}`)), 20000);
			function finish(error) {
				clearTimeout(timeout);
				child.off('exit', exited);
				child.off('error', finish);
				error ? reject(error) : resolve();
			}
			function exited(code) { finish(new Error(`Runtime exited ${code}:\n${output}`)); }
			function collect(chunk) {
				output += chunk.toString();
				if (output.includes('Ready for traffic')) finish();
			}
			child.stdout.on('data', collect);
			child.stderr.on('data', collect);
			child.once('exit', exited);
			child.once('error', finish);
		});
		const port = output.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
		expect(port, output).toBeTruthy();
		await check(`http://127.0.0.1:${port}`, () => output);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
		}
	}
}

async function scrape(url) {
	const response = await fetch(url + '/metrics');
	expect(response.status).toBe(200);
	return new Map((await response.text()).trim().split('\n').map(line => {
		const [name, value] = line.split(' ');
		return [name, Number(value)];
	}));
}

describeUWS('file-descriptor preflight and gauges on the built runtime', () => {
	beforeAll(() => { expect(buildFixtureOnce('metrics')).toBe(true); }, 400000);

	it.each([8191, 8192, 16384])('boots with soft limit %i and exports sampled descriptor gauges', async soft => {
		await boot(soft, async (url, output) => {
			const warnings = output().split('\n').filter(line => line.includes('file-descriptor preflight:'));
			expect(warnings).toHaveLength(soft < 8192 ? 1 : 0);
			if (soft < 8192) expect(warnings[0]).toContain(`soft file-descriptor limit for this process is ${soft}`);
			await expect.poll(async () => (await scrape(url)).get('open_fds'), { timeout: 15000 }).toBe(42);
			expect((await scrape(url)).get('fd_soft_limit')).toBe(soft);
		});
	}, 40000);

	it('exports native descriptor sources only where the platform supplies them', async () => {
		await boot('native', async url => {
			if (process.platform === 'linux') {
				const row = readFileSync('/proc/self/limits', 'utf8').split('\n').find(line => line.startsWith('Max open files'));
				const soft = row.trim().split(/\s{2,}/)[1];
				const metrics = await scrape(url);
				if (soft === 'unlimited') expect(metrics.has('fd_soft_limit')).toBe(false);
				else expect(metrics.get('fd_soft_limit')).toBe(Number(soft));
				await expect.poll(async () => (await scrape(url)).get('open_fds'), { timeout: 15000 }).toBeGreaterThan(0);
			} else if (process.platform === 'win32') {
				const metrics = await scrape(url);
				expect(metrics.has('open_fds')).toBe(false);
				expect(metrics.has('fd_soft_limit')).toBe(false);
			} else {
				// Other POSIX platforms expose /dev/fd and process.report limits.
				await expect.poll(async () => (await scrape(url)).get('open_fds'), { timeout: 15000 }).toBeGreaterThan(0);
				const limits = process.report.getReport().userLimits;
				const soft = (limits.open_files ?? limits.max_open_files)?.soft;
				const metrics = await scrape(url);
				if (Number.isFinite(Number(soft))) expect(metrics.get('fd_soft_limit')).toBe(Number(soft));
				else expect(metrics.has('fd_soft_limit')).toBe(false);
			}
		});
	}, 40000);
});
