import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';
import { createSmoothAuthority } from '../src/plugins/smooth/server.js';
import { hasUWS } from './helpers/real-runtime.js';

let server;
let clients;
let nonce = 0;
async function connect() {
	const ws = new WebSocket(server.wsUrl);
	const frames = [];
	ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	const client = { ws, frames };
	clients.push(client);
	return client;
}
async function command(client, operation, values = {}) {
	const id = ++nonce;
	client.ws.send(JSON.stringify({ operation, ...values, nonce: id }));
	const end = Date.now() + 2000;
	while (Date.now() < end) {
		const reply = client.frames.find(frame => frame.event === 'reply' && frame.data.nonce === id);
		if (reply) return reply.data;
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	throw new Error('authority did not answer the real socket command');
}
function batch(count, start = 1) {
	return Array.from({ length: count }, (_, index) => ({ id: start + index, cmd: { dx: 1, label: start + index } }));
}
(hasUWS ? describe : describe.skip)('smooth authority command budget over actual sockets', () => {
	beforeEach(async () => {
		clients = [];
		let authority;
		const failed = new Set();
		server = await createTestServer({ handler: {
			message(ws, { data, platform }) {
				const msg = JSON.parse(Buffer.from(data).toString());
				let result;
				if (msg.operation === 'configure') {
					try {
						authority = createSmoothAuthority({
							...msg.options,
							apply(state, cmd, ctx) {
								if (cmd.append) authority.enqueue(ctx.key, cmd.append);
								if (cmd.failOnce && !failed.has(cmd.label)) { failed.add(cmd.label); throw new Error('apply failed once'); }
								ctx.emitEvent('applied', cmd.label);
								return { x: state.x + cmd.dx, trail: [...state.trail, cmd.label] };
							},
							onMissing: msg.missing ? state => ({ x: state.x + 10, trail: [...state.trail, 'missing'] }) : undefined
						});
						result = { configured: true };
					} catch (error) { result = { error: error.message }; }
				} else if (msg.operation === 'join') result = authority.ensure(msg.key, ws, { x: 0, trail: [] });
				else if (msg.operation === 'queue') result = { accepted: authority.enqueue(msg.key, msg.commands) };
				else if (msg.operation === 'inject') result = { accepted: authority.inject(msg.key, msg.command) };
				else if (msg.operation === 'tick') {
					let tick;
					try { tick = authority.drain(); }
					catch (error) { platform.send(ws, 'probe', 'reply', { error: error.message, nonce: msg.nonce }); return; }
					for (const ack of tick.acks) platform.send(ack.ws, 'smooth', 'ack', { key: ack.key, id: ack.id, state: ack.state });
					result = {
						idle: tick.idle,
						acks: tick.acks.map(({ key, id, state }) => ({ key, id, state })),
						updates: tick.updates.map(({ key, state, commanded }) => ({ key, state, commanded })),
						events: tick.events.map(({ data, commanded }) => ({ data, commanded }))
					};
				}
				platform.send(ws, 'probe', 'reply', { ...result, nonce: msg.nonce });
			}
		} });
	});
	afterEach(async () => {
		for (const client of clients) client.ws.terminate();
		await server?.close();
	});

	it('drains each entity independently in ordered prefixes and acknowledges only applied commands', async () => {
		const first = await connect(), second = await connect();
		await command(first, 'configure', { options: { maxCommandsPerTick: 2 } });
		await command(first, 'join', { key: 'a' });
		await command(second, 'join', { key: 'b' });
		await command(first, 'queue', { key: 'a', commands: batch(5) });
		await command(second, 'queue', { key: 'b', commands: batch(3) });
		const ticks = [];
		for (let i = 0; i < 3; i++) ticks.push(await command(first, 'tick'));
		expect(ticks.map(tick => tick.acks.map(ack => [ack.key, ack.id, ack.state.x]))).toEqual([
			[['a', 2, 2], ['b', 2, 2]], [['a', 4, 4], ['b', 3, 3]], [['a', 5, 5]]
		]);
		expect(ticks.map(tick => tick.events.map(event => event.data))).toEqual([[1, 2, 1, 2], [3, 4, 3], [5]]);
		expect(ticks.every(tick => !tick.idle)).toBe(true);
		expect((await command(first, 'tick')).idle).toBe(true);
		expect(first.frames.filter(frame => frame.event === 'ack').map(frame => frame.data.id)).toEqual([2, 4, 5]);
		expect(second.frames.filter(frame => frame.event === 'ack').map(frame => frame.data.id)).toEqual([2, 3]);
	});

	it('keeps queueCap as the only drop point while newly arrived work follows the retained tail', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 1, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(3) });
		expect((await command(client, 'tick')).acks[0].id).toBe(1);
		await command(client, 'queue', { key: 'a', commands: batch(2, 4) });
		const applied = [];
		for (let i = 0; i < 3; i++) applied.push((await command(client, 'tick')).acks[0]);
		expect(applied.map(ack => ack.id)).toEqual([3, 4, 5]);
		expect(applied[2].state.trail).toEqual([1, 3, 4, 5]);
	});

	it('waits for the client tail before onMissing while server injections keep their own delivery semantics', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 1 }, missing: true });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(2) });
		await command(client, 'inject', { key: 'a', command: { dx: 100, label: 'hit' } });
		const one = await command(client, 'tick');
		expect(one.acks[0]).toMatchObject({ id: 1, state: { x: 101, trail: [1, 'hit'] } });
		expect(one.updates[0].commanded).toBe(false);
		expect(one.events).toEqual([{ data: 1, commanded: true }, { data: 'hit', commanded: false }]);
		expect((await command(client, 'tick')).acks[0]).toMatchObject({ id: 2, state: { x: 102, trail: [1, 'hit', 2] } });
		const missing = await command(client, 'tick');
		expect(missing.acks).toEqual([]);
		expect(missing.updates[0]).toMatchObject({ commanded: false, state: { x: 112 } });
	});

	it('drops a remaining old-socket tail when an entity is rebound', async () => {
		const first = await connect(), replacement = await connect();
		await command(first, 'configure', { options: { maxCommandsPerTick: 1 } });
		await command(first, 'join', { key: 'a' });
		await command(first, 'queue', { key: 'a', commands: batch(3) });
		await command(first, 'tick');
		const rebound = await command(replacement, 'join', { key: 'a' });
		expect(rebound).toMatchObject({ state: { x: 1 }, lastAckedId: 0 });
		await command(replacement, 'queue', { key: 'a', commands: [{ id: 1, cmd: { dx: 10, label: 'new' } }] });
		expect((await command(replacement, 'tick')).acks[0].state).toEqual({ x: 11, trail: [1, 'new'] });
		expect((await command(replacement, 'tick')).acks).toEqual([]);
	});

	it('preserves default draining of commands enqueued synchronously by apply', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: [{ id: 1, cmd: { dx: 1, label: 1, append: batch(1, 2) } }] });
		const tick = await command(client, 'tick');
		expect(tick.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('owns the bounded in-flight prefix when apply enqueues enough commands to evict the waiting tail', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[0].cmd.append = batch(3, 4);
		await command(client, 'queue', { key: 'a', commands });
		const one = await command(client, 'tick');
		expect(one.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		const two = await command(client, 'tick');
		expect(two.acks[0]).toMatchObject({ id: 5, state: { x: 4, trail: [1, 2, 4, 5] } });
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([1, 2, 4, 5, 6]);
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('restores the whole detached prefix after apply throws before state is committed', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[1].cmd.failOnce = true;
		await command(client, 'queue', { key: 'a', commands });
		expect((await command(client, 'tick')).error).toBe('apply failed once');
		expect(client.frames.filter(frame => frame.event === 'ack')).toEqual([]);
		const retry = await command(client, 'tick');
		expect(retry.acks[0]).toMatchObject({ id: 2, state: { x: 2, trail: [1, 2] } });
		expect((await command(client, 'tick')).acks[0]).toMatchObject({ id: 3, state: { x: 3, trail: [1, 2, 3] } });
	});

	it('keeps queueCap as the drop point when a failing callback also appends commands', async () => {
		const client = await connect();
		await command(client, 'configure', { options: { maxCommandsPerTick: 2, queueCap: 3 } });
		await command(client, 'join', { key: 'a' });
		const commands = batch(3);
		commands[1].cmd = { dx: 1, label: 2, failOnce: true, append: batch(3, 4) };
		await command(client, 'queue', { key: 'a', commands });
		expect((await command(client, 'tick')).error).toBe('apply failed once');
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([4, 5]);
		expect((await command(client, 'tick')).acks[0].state.trail).toEqual([4, 5, 6]);
		expect((await command(client, 'tick')).acks).toEqual([]);
	});

	it('preserves the default full drain', async () => {
		const client = await connect();
		await command(client, 'configure', { options: {} });
		await command(client, 'join', { key: 'a' });
		await command(client, 'queue', { key: 'a', commands: batch(32) });
		const tick = await command(client, 'tick');
		expect(tick.acks[0]).toMatchObject({ id: 32, state: { x: 32 } });
		expect(tick.events).toHaveLength(32);
	});

	it.each([0, -1, 1.5, null, '2'])('refuses an invalid configured budget %s', async maxCommandsPerTick => {
		const client = await connect();
		expect((await command(client, 'configure', { options: { maxCommandsPerTick } })).error).toMatch(/maxCommandsPerTick/);
	});
});
