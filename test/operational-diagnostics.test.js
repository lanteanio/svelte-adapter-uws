import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createOperationalDiagnostic,
	formatOperationalDiagnostic,
	listenFailureDiagnostic,
	viteHandlerFailureDiagnostic,
	viteHandlerRecoveredDiagnostic
} from '../src/runtime/utils/operational-diagnostic.js';

function parseLine(input) {
	const line = formatOperationalDiagnostic({
		...input,
		occurredAt: '2026-08-02T12:00:00.000Z'
	});
	const json = line.indexOf('{');
	return { line, record: JSON.parse(line.slice(json)) };
}

function recordFromCalls(spy, event) {
	const line = spy.mock.calls.flat().find((value) => typeof value === 'string' && value.includes(` ${event}:`));
	if (!line) throw new Error(`missing console event ${event}`);
	return JSON.parse(line.slice(line.indexOf('{')));
}

function viteServer(ssrLoadModule) {
	return {
		httpServer: { on: vi.fn(), once: vi.fn() },
		middlewares: { use: vi.fn() },
		ssrLoadModule,
		config: {
			root: process.cwd(),
			server: { host: '127.0.0.1', port: 5173 },
			logger: { warn: vi.fn() },
			plugins: [{
				name: 'vite-plugin-sveltekit-setup',
				api: { options: { kit: { adapter: {
					name: 'adapter-uws',
					websocketHandler: './test/operational-diagnostics.test.js'
				} } } }
			}]
		}
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => vi.restoreAllMocks());

describe('action-oriented operational diagnostics', () => {
	it('makes a listen failure fatal, terminal, located, and actionable', () => {
		const { line, record } = parseLine(listenFailureDiagnostic('127.0.0.1', 3000));
		expect(line).toMatch(/^\[lantean\/diagnostic source=svelte-adapter-uws component=runtime\.listener event=runtime\.listen\.failed severity=fatal\] runtime\.listen\.failed:/);
		expect(line).toContain('; effect:');
		expect(line).toContain('; recovery:');
		expect(line).toContain('; action:');
		expect(record).toMatchObject({
			source: 'svelte-adapter-uws',
			severity: 'fatal',
			level: 'fatal',
			event: 'runtime.listen.failed',
			component: 'runtime.listener',
			dataClass: 'operational',
			attributes: {
				willRetry: false,
				host: '127.0.0.1',
				port: 3000,
				error: { name: 'Error', code: 'LISTEN_FAILED' }
			}
		});
		expect(record.attributes.effect).toContain('exits with status 1');
		expect(record.attributes.action).toContain('port conflicts');
	});

	it('distinguishes initial and reload degradation effects with retry and action', () => {
		const error = Object.assign(new Error('broken\nmodule'), { code: 'ERR_MODULE' });
		const initial = createOperationalDiagnostic({
			...viteHandlerFailureDiagnostic({ phase: 'load', source: 'websocket.handler', host: 'localhost', port: 5173, error }),
			occurredAt: '2026-08-02T12:00:00.000Z'
		});
		const reload = createOperationalDiagnostic({
			...viteHandlerFailureDiagnostic({ phase: 'reload', source: '/src/hooks.ws.js', host: 'localhost', port: 5173, error }),
			occurredAt: '2026-08-02T12:00:00.000Z'
		});

		expect(initial).toMatchObject({ level: 'error', event: 'vite.handler.load-failed' });
		expect(initial.attributes).toMatchObject({ willRetry: true, host: 'localhost', port: 5173 });
		expect(initial.attributes.effect).toContain('Vite HTTP server stays active');
		expect(initial.attributes.effect).toContain('HTTP 500');
		expect(reload).toMatchObject({ level: 'error', event: 'vite.handler.reload-failed' });
		expect(reload.attributes.effect).toContain('keep the previous handler');
		expect(reload.attributes.action).toContain('dev-server restart is not required');
		expect(reload.attributes.error.message).toBe('broken module');
	});

	it('emits an explicit recovered state with no pending retry or operator work', () => {
		const recovered = createOperationalDiagnostic({
			...viteHandlerRecoveredDiagnostic({ host: 'localhost', port: 5173, connectionsRestarted: true }),
			occurredAt: '2026-08-02T12:00:00.000Z'
		});
		expect(recovered).toMatchObject({ level: 'info', event: 'vite.handler.recovered' });
		expect(recovered.attributes).toMatchObject({ willRetry: false, error: null });
		expect(recovered.attributes.effect).toContain('code 1012');
		expect(recovered.attributes.action).toContain('No operator action is required');
	});

	it('bounds and de-controls error data before serializing it', () => {
		const long = Object.assign(new Error('x\n' + 'y'.repeat(800)), { code: 'BAD\rCODE' });
		const record = createOperationalDiagnostic({
			...viteHandlerFailureDiagnostic({ phase: 'load', source: 'test', host: null, port: null, error: long }),
			occurredAt: '2026-08-02T12:00:00.000Z'
		});
		expect(record.attributes.error.message.length).toBeLessThanOrEqual(512);
		expect(record.attributes.error.message).not.toMatch(/[\r\n]/);
		expect(record.attributes.error.code).toBe('BAD CODE');
	});

	it('keeps both fatal listener sites and all Vite transitions wired to the sink', () => {
		const lifecycle = readFileSync(new URL('../src/runtime/handler/lifecycle.js', import.meta.url), 'utf8');
		const runtime = readFileSync(new URL('../src/runtime/index.js', import.meta.url), 'utf8');
		const vite = readFileSync(new URL('../src/vite.js', import.meta.url), 'utf8');
		expect(lifecycle).toContain('emitOperationalDiagnostic(listenFailureDiagnostic(host, port))');
		expect(runtime).toContain('emitOperationalDiagnostic(listenFailureDiagnostic(host, portNum))');
		expect(vite.match(/viteHandlerFailureDiagnostic\(\{/g)).toHaveLength(2);
		expect(vite).toContain('viteHandlerRecoveredDiagnostic({');
	});

	it('reports a real initial Vite load failure and its next-update recovery', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const ssrLoadModule = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('bad handler'), { code: 'ERR_MODULE' }))
			.mockResolvedValueOnce({ message() {} });
		const server = viteServer(ssrLoadModule);
		const { default: uws } = await import('../src/vite.js');
		const plugin = uws();

		await plugin.configureServer(server);
		await settle();
		const failed = recordFromCalls(errorLog, 'vite.handler.load-failed');
		expect(failed).toMatchObject({
			level: 'error',
			attributes: { willRetry: true, host: '127.0.0.1', port: 5173 }
		});
		expect(failed.attributes.effect).toContain('WebSocket upgrades return HTTP 500');

		plugin.handleHotUpdate({ server });
		await settle();
		const recovered = recordFromCalls(infoLog, 'vite.handler.recovered');
		expect(recovered).toMatchObject({
			level: 'info',
			attributes: { willRetry: false, host: '127.0.0.1', port: 5173, error: null }
		});

		// The bounded structured record deliberately drops the stack and Vite
		// frame; the raw evidence must still reach the console beside it.
		expect(errorLog.mock.calls.flat()).toContain('[adapter-uws] handler load error detail:');
	});

	it('runs the user init on recovery from an initial load failure, exactly once', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const init = vi.fn();
		const ssrLoadModule = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('bad handler'), { code: 'ERR_MODULE' }))
			.mockResolvedValue({ message() {}, init });
		const server = viteServer(ssrLoadModule);
		const { default: uws } = await import('../src/vite.js');
		const plugin = uws();

		await plugin.configureServer(server);
		await settle();
		expect(init).not.toHaveBeenCalled();

		// Recovery must fire init: it never ran at configureServer time, and
		// the recovered event claims no operator action is required.
		plugin.handleHotUpdate({ server });
		await settle();
		await settle();
		expect(init).toHaveBeenCalledTimes(1);
		recordFromCalls(infoLog, 'vite.handler.recovered');

		// A later ordinary reload must NOT re-run a completed init.
		plugin.handleHotUpdate({ server });
		await settle();
		await settle();
		expect(init).toHaveBeenCalledTimes(1);
	});

	it('retries a failed init on the next recovery instead of latching it away', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const init = vi.fn()
			.mockRejectedValueOnce(new Error('init exploded'))
			.mockResolvedValueOnce(undefined);
		const ssrLoadModule = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('bad handler'), { code: 'ERR_MODULE' }))
			.mockResolvedValue({ message() {}, init });
		const server = viteServer(ssrLoadModule);
		const { default: uws } = await import('../src/vite.js');
		const plugin = uws();

		await plugin.configureServer(server);
		await settle();

		// First recovery attempt: init throws. That must be a LOUD reload
		// failure with the raw detail line, and no recovered event.
		plugin.handleHotUpdate({ server });
		await settle();
		await settle();
		const failed = recordFromCalls(errorLog, 'vite.handler.reload-failed');
		expect(failed.attributes.error.message).toContain('init exploded');
		expect(errorLog.mock.calls.flat()).toContain('[adapter-uws] handler reload error detail:');
		expect(() => recordFromCalls(infoLog, 'vite.handler.recovered')).toThrow();

		// Second attempt: the once-latch must NOT have burned on the throw -
		// init runs again, completes, and only now recovery is reported.
		plugin.handleHotUpdate({ server });
		await settle();
		await settle();
		expect(init).toHaveBeenCalledTimes(2);
		recordFromCalls(infoLog, 'vite.handler.recovered');
	});

	it('reports a real hot-reload failure as old-handler degradation', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const ssrLoadModule = vi.fn().mockResolvedValueOnce({ message() {} });
		const server = viteServer(ssrLoadModule);
		const { default: uws } = await import('../src/vite.js');
		const plugin = uws();

		await plugin.configureServer(server);
		await settle();
		ssrLoadModule.mockRejectedValueOnce(Object.assign(new Error('reload broke'), { code: 'ERR_RELOAD' }));
		plugin.handleHotUpdate({ server });
		await settle();
		const failed = recordFromCalls(errorLog, 'vite.handler.reload-failed');
		expect(failed).toMatchObject({
			level: 'error',
			attributes: { willRetry: true, host: '127.0.0.1', port: 5173 }
		});
		expect(failed.attributes.effect).toContain('keep the previous handler');
		expect(failed.attributes.action).toContain('save the handler');
		expect(failed.attributes.problem).not.toContain(process.cwd());
	});

	it('attributes every failure to the initial load until a handler has ever loaded', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const ssrLoadModule = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('still broken'), { code: 'ERR_MODULE' }))
			.mockRejectedValueOnce(Object.assign(new Error('still broken'), { code: 'ERR_MODULE' }))
			.mockResolvedValueOnce({ message() {} });
		const server = viteServer(ssrLoadModule);
		const { default: uws } = await import('../src/vite.js');
		const plugin = uws();

		await plugin.configureServer(server);
		await settle();

		// A module-graph retry of a handler that has never loaded is still the
		// initial load. reload-failed would tell the operator a previously
		// loaded handler keeps serving existing connections - connections that
		// cannot exist, since every upgrade has answered HTTP 500 since boot.
		plugin.handleHotUpdate({ server });
		await settle();
		const loadFailures = errorLog.mock.calls.flat().filter((value) =>
			typeof value === 'string' && value.includes(' vite.handler.load-failed:'));
		expect(loadFailures).toHaveLength(2);
		expect(() => recordFromCalls(errorLog, 'vite.handler.reload-failed')).toThrow();
		expect(errorLog.mock.calls.flat().filter((value) =>
			value === '[adapter-uws] handler load error detail:')).toHaveLength(2);

		// Once a handler has loaded, the same failure becomes a reload failure.
		plugin.handleHotUpdate({ server });
		await settle();
		await settle();
		recordFromCalls(infoLog, 'vite.handler.recovered');
		ssrLoadModule.mockRejectedValueOnce(Object.assign(new Error('reload broke'), { code: 'ERR_RELOAD' }));
		plugin.handleHotUpdate({ server });
		await settle();
		recordFromCalls(errorLog, 'vite.handler.reload-failed');
	});
});
