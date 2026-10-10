import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Socket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	static all = [];
	constructor() { this.readyState = 0; Socket.all.push(this); }
	send() {}
	open() { this.readyState = 1; this.onopen?.(); }
	close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}
let client, runtime, connection;
const value = store => { let result; const stop = store.subscribe(v => { result = v; }); stop(); return result; };
beforeEach(async () => {
	vi.resetModules(); vi.useFakeTimers(); Socket.all = [];
	vi.stubGlobal('WebSocket', Socket);
	vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173' } });
	runtime = await import('../src/client-runtime.js');
	runtime.setRuntimeEnv({ rng: { float: () => 0.5 } });
	client = await import('../src/client.js');
});
afterEach(() => { connection?.close(); runtime.resetRuntimeEnv(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('throttling preserves the reconnect attempt budget', () => {
	it.each([1, 3, 5])('allows %i retries after an auth 429, honoring Retry-After each time', async (budget) => {
		const fetch = vi.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => '1' } }));
		vi.stubGlobal('fetch', fetch);
		connection = client.connect({ auth: true, maxReconnectAttempts: budget, reconnectInterval: 1, maxReconnectInterval: 10 });
		await vi.advanceTimersByTimeAsync(0);
		expect(value(connection._permaClosed)).toBe(false);
		expect(value(connection.failure).class).toBe('THROTTLE');
		await vi.advanceTimersByTimeAsync(999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		if (budget > 1) await vi.advanceTimersByTimeAsync((budget - 1) * 1000);
		expect(fetch).toHaveBeenCalledTimes(budget + 1);
		expect(value(connection._permaClosed)).toBe(true);
		expect(value(connection.failure).class).toBe('EXHAUSTED');
		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).toHaveBeenCalledTimes(budget + 1);
	});
	it('backs off after 4429 but spends only the real retry, and resets on success', async () => {
		connection = client.connect({ maxReconnectAttempts: 1, reconnectInterval: 10, maxReconnectInterval: 1000 });
		const first = Socket.all[0]; first.open(); first.close(4429);
		expect(value(connection._permaClosed)).toBe(false);
		expect(value(connection.failure).class).toBe('THROTTLE');
		await vi.advanceTimersByTimeAsync(100);
		expect(Socket.all).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(Socket.all).toHaveLength(2);
		Socket.all[1].open(); Socket.all[1].close(1006);
		await vi.advanceTimersByTimeAsync(10);
		expect(Socket.all).toHaveLength(3);
		expect(value(connection._permaClosed)).toBe(false);
		Socket.all[2].close(1006);
		expect(value(connection._permaClosed)).toBe(true);
		expect(value(connection.failure).class).toBe('EXHAUSTED');
	});
});
