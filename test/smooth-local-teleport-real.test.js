import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test) {
	const deadline = Date.now() + 3000;
	while (!test()) { if (Date.now() >= deadline) throw new Error('native smooth channel deadline'); await pause(2); }
}

describe('local smooth corrections over actual socket acknowledgements', () => {
	let client, runtime, createSmoothChannel, server, connection, peer, channel;
	let mono, rafs, nextRaf, sent, rendered;
	beforeEach(async () => {
		vi.resetModules(); mono = 1000; rafs = new Map(); nextRaf = 0; sent = []; rendered = [];
		vi.stubGlobal('requestAnimationFrame', callback => { const id = ++nextRaf; rafs.set(id, callback); return id; });
		vi.stubGlobal('cancelAnimationFrame', id => rafs.delete(id));
		runtime = await import('../src/client-runtime.js');
		runtime.setRuntimeEnv({ clock: { now: () => mono, monotonic: () => mono } });
		client = await import('../src/client.js');
		({ createSmoothChannel } = await import('../src/plugins/smooth/client.js'));
		server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await new Promise(resolve => server.once('listening', resolve));
		vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:' + server.address().port } });
		server.on('connection', socket => {
			peer = socket;
			socket.on('message', bytes => {
				const message = JSON.parse(bytes.toString());
				if (message.kind === 'commands') sent.push(...message.batch);
				if (message.kind === 'sync') socket.send(JSON.stringify({ topic: 'sync-reply', event: 'reply', data: {
					topic: 'teleport', t: mono, you: 'me', ack: 0, states: [{ key: 'me', state: { x: 0, y: 0 } }]
				} }));
			});
		});
		connection = client.connect({ url: 'ws://127.0.0.1:' + server.address().port, maxReconnectAttempts: 0 });
		await client.ready();
	});
	afterEach(async () => {
		channel?.destroy(); connection?.close(); runtime?.resetRuntimeEnv();
		for (const socket of server.clients) socket.terminate();
		await new Promise(resolve => server.close(resolve));
		vi.unstubAllGlobals();
	});
	function frame() {
		const callbacks = [...rafs.values()]; rafs.clear();
		for (const callback of callbacks) callback(mono);
		return rendered.at(-1);
	}
	async function open(options = {}) {
		channel = createSmoothChannel({
			apply: (state, command) => ({ x: state.x + command.dx, y: state.y + (command.dy || 0) }),
			initial: { x: 0, y: 0 }, cmdRate: 0, smoothTimeMs: 100,
			transport: {
				sendCommand: batch => connection.send({ kind: 'commands', batch }),
				sync: () => new Promise(resolve => {
					let stop = () => {};
					stop = client.on('sync-reply').subscribe(event => { if (event) { stop(); resolve(event.data); } });
					connection.send({ kind: 'sync' });
				})
			}, ...options
		});
		channel.onFrame(local => rendered.push(local));
		await waitFor(() => channel.self === 'me'); frame();
	}
	async function submit(dx = 2, dy = 0) {
		mono += 16;
		const id = channel.command({ dx, dy }); frame();
		await waitFor(() => sent.some(command => command.id === id));
		return id;
	}
	async function ack(id, x, y = 0, remaining = 0) {
		peer.send(JSON.stringify({ topic: '__smooth:teleport', event: 'ack', data: { id, state: { x, y }, t: mono } }));
		await waitFor(() => channel.windowSize === remaining);
		return frame();
	}
	async function warm(options) {
		await open(options);
		for (let i = 1; i <= 4; i++) await ack(await submit(), i * 2);
	}

	it('snaps a respawn-sized correction on the ordinary acknowledgement cadence', async () => {
		await warm();
		const id = await submit();
		const local = await ack(id, 165, -20);
		expect(channel.predicted).toEqual({ x: 165, y: -20 });
		expect(local).toEqual({ x: 165, y: -20 });
		expect(channel.stats().correcting).toBe(false);
	});
	it('clears the old render sweep while preserving the unacknowledged replay tail', async () => {
		await warm();
		const acknowledged = await submit();
		const pending = await submit(2, 1);
		const local = await ack(acknowledged, 165, -20, 1);
		expect(channel.predicted).toEqual({ x: 167, y: -19 });
		expect(local).toEqual({ x: 167, y: -19 });
		expect(channel.windowSize).toBe(1);
		await ack(pending, 167, -19);
		expect(frame()).toEqual({ x: 167, y: -19 });
	});
	it('keeps ordinary small corrections visually continuous', async () => {
		await warm();
		const id = await submit(); const before = frame();
		const local = await ack(id, 12);
		expect(channel.predicted.x).toBe(12);
		expect(local.x).toBeCloseTo(before.x, 8);
		expect(channel.stats().correcting).toBe(true);
	});
	it('honors the explicit speed-snap escape hatch', async () => {
		await warm({ snapSpeedPerSec: 0 });
		const local = await ack(await submit(), 165, -20);
		expect(channel.predicted.x).toBe(165);
		expect(local.x).toBeLessThan(20);
		expect(channel.stats().correcting).toBe(true);
	});
	it('uses a configured absolute ceiling for a correction below the automatic motion bound', async () => {
		await warm({ snapSpeedPerSec: 100 });
		const local = await ack(await submit(), 60);
		expect(local.x).toBe(60);
		expect(channel.stats().correcting).toBe(false);
	});
	it('does not erase ordinary predicted fast motion when authority agrees', async () => {
		await warm();
		const id = await submit(160);
		await ack(id, 168);
		expect(channel.predicted.x).toBe(168);
		expect(channel.stats().correcting).toBe(false);
		mono += 10; const moving = frame().x; expect(moving).toBeGreaterThan(8); expect(moving).toBeLessThan(168);
	});
	it('snaps a placement after stationary commanded motion', async () => {
		await open();
		for (let i = 0; i < 4; i++) await ack(await submit(0), 0);
		expect(await ack(await submit(0), 155)).toEqual({ x: 155, y: 0 });
		expect(channel.stats().correcting).toBe(false);
	});
	it('uses an absolute ceiling before command cadence is known', async () => {
		await open({ snapSpeedPerSec: 100 });
		expect(await ack(await submit(), 155)).toEqual({ x: 155, y: 0 });
		expect(channel.stats().correcting).toBe(false);
	});
	it('does not invent an automatic speed baseline on the first command', async () => {
		await open();
		expect((await ack(await submit(), 155)).x).toBe(2);
		expect(channel.stats().correcting).toBe(true);
	});
	it('keeps same-instant catch-up commands from inflating the automatic baseline', async () => {
		await warm();
		channel.command({ dx: 2 });
		const id = channel.command({ dx: 2 }); frame();
		await waitFor(() => sent.some(command => command.id === id));
		expect(await ack(id, 165)).toEqual({ x: 165, y: 0 });
	});
	it('forgets stale fast motion once the recent command window is stationary', async () => {
		await warm();
		await ack(await submit(160), 168);
		for (let i = 0; i < 32; i++) await ack(await submit(0), 168);
		expect(await ack(await submit(0), 323)).toEqual({ x: 323, y: 0 });
	});
	it('clears the old motion baseline on a full sync', async () => {
		await warm();
		await channel.resync();
		await waitFor(() => channel.predicted.x === 0);
		expect((await ack(await submit(), 155)).x).toBe(2);
		expect(channel.stats().correcting).toBe(true);
	});

	it('does not turn one measured interval into an automatic baseline with a same-instant burst', async () => {
		await open(); await ack(await submit(0), 0); await ack(await submit(0), 0);
		const id = channel.command({ dx: 0 }); frame();
		await waitFor(() => sent.some(command => command.id === id));
		expect((await ack(id, 155)).x).toBe(0);
		expect(channel.stats().correcting).toBe(true);
	});
	it('does not evict recent measured fast motion with same-instant stationary commands', async () => {
		await warm(); await ack(await submit(160), 168);
		let id;
		for (let i = 0; i < 32; i++) id = channel.command({ dx: 0 });
		frame(); await waitFor(() => sent.some(command => command.id === id));
		expect((await ack(id, 323)).x).toBeLessThan(169);
		expect(channel.stats().correcting).toBe(true);
	});

	it('emits the final sweep position once before returning to idle', async () => {
		await warm();
		await ack(await submit(160), 168);
		const count = rendered.length;
		mono += 100;
		expect(frame()).toEqual({ x: 168, y: 0 });
		expect(rendered.length).toBe(count + 1);
		mono += 16; frame();
		expect(rendered.length).toBe(count + 1);
	});
	it('emits the final correction position once before returning to idle', async () => {
		await warm({ snapSpeedPerSec: 0 });
		await ack(await submit(), 12);
		expect(channel.stats().correcting).toBe(true);
		const count = rendered.length;
		mono += 1000;
		expect(frame()).toEqual({ x: 12, y: 0 });
		expect(channel.stats().correcting).toBe(false);
		expect(rendered.length).toBe(count + 1);
		mono += 16; frame();
		expect(rendered.length).toBe(count + 1);
	});

});
