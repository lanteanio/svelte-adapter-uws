// Real-wire integration tests for the cursor + presence tap channels.
//
// Unlike the mock-ws unit suites, these run a REAL uWebSockets.js server
// (createTestServer) with REAL `ws` clients, so they exercise the actual
// ws.subscribe / platform.publish delivery path - the thing a mock cannot
// model and the reason the cursor "silent no-op" and presence "dual-role
// roster freeze" bugs were invisible to the unit tests. They also verify the
// snapshot-handshake authorization end to end: a client cannot receive a tap
// channel for a topic it is not allowed to subscribe to.
//
// Wiring mirrors a zero-config app: handler.subscribe is the authorization
// gate (so platform.checkSubscribe runs it), and handler.message routes the
// snapshot / join / leave / move frames to the plugins.

import { describe, it, expect, afterEach } from 'vitest';
import { createCursor } from '../src/plugins/cursor/server.js';
import { createPresence } from '../src/plugins/presence/server.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = []; // raw frame text
	ws.on('message', (data) => { frames.push(data.toString()); });
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		send: (obj) => ws.send(JSON.stringify(obj)),
		clear: () => { frames.length = 0; },
		has: (substr) => frames.some((f) => f.includes(substr))
	};
}

describeUWS('cursor + presence tap channels over a real uWS server', () => {
	let server;
	let clients;

	afterEach(async () => {
		for (const c of clients || []) { try { c.ws.close(); } catch { /* ignore */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	async function startServer() {
		const { createTestServer } = await import('../src/testing.js');
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, name: ud.name }) });
		const cursor = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id, name: ud.name }) });
		clients = [];

		server = await createTestServer({
			handler: {
				// Identity per connection from the ?id= query.
				upgrade({ url }) {
					const id = new URL('http://x' + url).searchParams.get('id') || 'anon';
					return { id, name: id };
				},
				// Authorization gate. Used by wire-subscribes AND by
				// platform.checkSubscribe (which the snapshot handshakes call), so
				// the topic 'private' is unreachable via either path.
				subscribe(_ws, topic) {
					return topic === 'private' ? 'FORBIDDEN' : null;
				},
				message(ws, { data, platform }) {
					let m;
					try { m = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
					if (m.type === 'presence-join') { presence.join(ws, m.topic, platform); return; }
					if (m.type === 'presence-leave') { presence.hooks.unsubscribe(ws, m.topic, { platform }); return; }
					if (m.type === 'presence-snapshot') { presence.hooks.message(ws, { data, msg: m, platform }); return; }
					if (m.type === 'cursor' || m.type === 'cursor-snapshot' || m.type === 'cursor-viewport') {
						cursor.hooks.message(ws, { data, platform });
						return;
					}
				},
				close(ws, { platform }) {
					presence.leave(ws, platform);
					cursor.hooks.close(ws, { platform });
				}
			}
		});
		return server;
	}

	async function client(id) {
		const c = await connect(server.wsUrl + '?id=' + id);
		clients.push(c);
		return c;
	}

	describe('presence', () => {
		it('a co-resident sync-observer keeps receiving roster diffs after the participant role leaves', async () => {
			await startServer();
			const alice = await client('alice'); // dual-role: participant + observer of 'board'
			const bob = await client('bob');     // participant of 'board'

			alice.send({ type: 'presence-join', topic: 'board' });     // participant
			alice.send({ type: 'presence-snapshot', topic: 'board' }); // observer
			await wait(60);

			bob.send({ type: 'presence-join', topic: 'board' });
			await wait(60);
			expect(alice.has('bob')).toBe(true); // observer saw bob join

			// Alice drops her PARTICIPANT role but stays an observer.
			alice.clear();
			alice.send({ type: 'presence-leave', topic: 'board' });
			await wait(60);

			// Bob leaves -> the leave diff must still reach alice (the observer).
			// Pre-fix, alice's participant leave evicted her from __presence:board,
			// so she never saw bob's leave and her roster froze.
			bob.send({ type: 'presence-leave', topic: 'board' });
			await wait(80);
			expect(alice.has('bob')).toBe(true); // bob's leave reached the observer
		});

		it('a presence-snapshot for a topic the client cannot subscribe to delivers nothing', async () => {
			await startServer();
			const attacker = await client('attacker');
			const member = await client('member');

			// Denied: 'private' fails the authorization gate.
			attacker.clear();
			attacker.send({ type: 'presence-snapshot', topic: 'private' });
			await wait(60);
			expect(attacker.frames).toHaveLength(0); // no roster state

			// And a real participant on 'private' does not reach the attacker.
			member.send({ type: 'presence-join', topic: 'private' });
			await wait(60);
			expect(attacker.frames).toHaveLength(0);

			// Control: an allowed topic delivers the snapshot state.
			attacker.clear();
			attacker.send({ type: 'presence-snapshot', topic: 'public' });
			await wait(60);
			expect(attacker.frames.length).toBeGreaterThan(0);
		});
	});

	describe('cursor', () => {
		it('zero-config: a snapshot subscribes the socket, which then receives another client cursor', async () => {
			await startServer();
			const a = await client('a');
			const b = await client('b');

			// Both establish cursor membership via the snapshot handshake (the fix:
			// the plugin owns the subscription; the client never wire-subscribes a
			// __ topic). Pre-fix, neither was ever subscribed and cursor sync was a
			// silent no-op. A move requires a prior authorized snapshot (the move
			// path keeps its isSubscribed gate), so b snapshots before it moves.
			a.send({ type: 'cursor-snapshot', topic: 'room' });
			b.send({ type: 'cursor-snapshot', topic: 'room' });
			await wait(60);

			a.clear();
			b.send({ type: 'cursor', topic: 'room', data: { x: 7, y: 9 } });
			await wait(80);
			expect(a.frames.length).toBeGreaterThan(0); // a received b's cursor over the wire
		});

		it('a cursor-snapshot for a topic the client cannot subscribe to delivers nothing', async () => {
			await startServer();
			const attacker = await client('attacker');
			const mover = await client('mover');

			attacker.clear();
			attacker.send({ type: 'cursor-snapshot', topic: 'private' });
			await wait(60);
			expect(attacker.frames).toHaveLength(0); // no catalog / positions

			// A real mover on 'private' does not reach the attacker either.
			mover.send({ type: 'cursor', topic: 'private', data: { x: 1, y: 1 } });
			await wait(60);
			expect(attacker.frames).toHaveLength(0);

			// Control: an allowed topic delivers the snapshot.
			attacker.clear();
			attacker.send({ type: 'cursor-snapshot', topic: 'public' });
			await wait(60);
			expect(attacker.frames.length).toBeGreaterThan(0);
		});
	});
});
