// Client-side tests for createCrdtChannel: the sync-on-open two-way
// state-vector exchange (server diff applied, offline edits uploaded), local
// write forwarding with origin tagging (no echo), the binary sink path and
// the JSON-envelope path converging on one apply, pre-sync frame buffering,
// the pending-structs loss detector, read-only enforcement, facet change
// notifications, and teardown. The transport is injected (scripted sync
// replies, recorded uploads); inbound frames are driven through the singleton
// connection's mocked socket, the same harness shape as smooth-channel.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
		this.binaryType = 'blob';
		MockWebSocket._last = this;
		queueMicrotask(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.();
			}
		});
	}
	send(data) {
		this._sent.push(data);
	}
	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	emit(obj) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
	emitBinary(frame) {
		const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
		this.onmessage?.({ data: buf });
	}
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../client.js');
const { createCrdtChannel } = await import('../plugins/crdt/channel.js');
const { encodeCrdt, CRDT_SCHEMA_VERSION } = await import('../plugins/crdt/codec.js');
const { CRDT_TOPIC_PREFIX } = await import('../plugins/crdt/client.js');
const { buildBinaryFrame } = await import('../files/wire.js');

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

let topicCounter = 0;

/**
 * A scripted server: a real Y.Doc replica behind a canned transport. The sync
 * reply carries the missing-structs diff against the client's vector plus the
 * server's own vector, exactly the live wire contract.
 */
function makeServer(overrides = {}) {
	const name = 'doc-' + topicCounter++;
	const doc = new Y.Doc();
	const s = {
		name,
		doc,
		uploads: [],
		syncs: [],
		closed: 0,
		access: { read: true, write: true, comment: false },
		transport: {
			sendUpdate(bytes) {
				s.uploads.push(bytes);
				Y.applyUpdate(doc, new Uint8Array(bytes));
			},
			sync(sv) {
				s.syncs.push(sv);
				if (overrides.sync) return overrides.sync(sv);
				return Promise.resolve({
					topic: name,
					access: s.access,
					diff: Array.from(Y.encodeStateAsUpdate(doc, new Uint8Array(sv))),
					sv: Array.from(Y.encodeStateVector(doc))
				});
			},
			close() {
				s.closed++;
			}
		}
	};
	return s;
}

const wire = (s) => CRDT_TOPIC_PREFIX + s.name;

/** Encode one update as a binary crdt frame for a known wire id. */
function crdtFrame(wireId, bytes, seq = 1) {
	const payload = encodeCrdt('crdt', { op: 'update', bytes });
	return buildBinaryFrame(CRDT_SCHEMA_VERSION, wireId, seq, payload);
}

/** Capture the incremental update for one transaction on a doc. */
function captureUpdate(doc, fn) {
	let update = null;
	const grab = (u) => { update = u; };
	doc.on('update', grab);
	doc.transact(fn);
	doc.off('update', grab);
	return update;
}

beforeEach(async () => {
	try {
		clientModule.connect().close();
	} catch {
		/* no singleton yet */
	}
	MockWebSocket._last = null;
	await flush(2);
});

describe('option validation', () => {
	it('rejects a missing or malformed transport', () => {
		expect(() => createCrdtChannel()).toThrow('options object');
		expect(() => createCrdtChannel({})).toThrow('transport');
		expect(() => createCrdtChannel({ transport: { sendUpdate() {} } })).toThrow('transport');
	});
});

describe('sync lifecycle', () => {
	it('syncs on open, applies the server diff, binds the topic, surfaces access', async () => {
		const s = makeServer();
		s.doc.getMap('root').set('title', 'hello');
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		expect(s.syncs.length).toBe(1);
		expect(ch.topic).toBe(wire(s));
		expect(ch.synced).toBe(true);
		expect(ch.degraded).toBe(false);
		expect(ch.access).toEqual({ read: true, write: true, comment: false });
		expect(ch.readOnly).toBe(false);
		expect(ch.map().get('title')).toBe('hello');
		ch.destroy();
	});

	it('uploads pre-sync local edits as one diff (the offline flush)', async () => {
		const s = makeServer();
		s.doc.getMap('root').set('server', 1);
		const ch = createCrdtChannel({ transport: s.transport });
		// Edit before the first sync resolves: no individual frame may be
		// sent; the sync exchange uploads everything the server lacks.
		ch.map().set('local', 2);
		await flush();
		expect(ch.map().get('server')).toBe(1);
		expect(s.doc.getMap('root').get('local')).toBe(2);
		expect(s.uploads.length).toBe(1); // exactly the one merged exchange blob
		ch.destroy();
	});

	it('skips the upload entirely when the server lacks nothing', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		expect(s.uploads.length).toBe(0); // empty diff is not sent
		ch.destroy();
	});

	it('reports degraded on a failed sync and recovers on the next resync', async () => {
		let fail = true;
		const s = makeServer({
			sync(sv) {
				if (fail) return Promise.reject(new Error('boom'));
				return Promise.resolve({
					topic: s.name,
					access: s.access,
					diff: Array.from(Y.encodeStateAsUpdate(s.doc, new Uint8Array(sv))),
					sv: Array.from(Y.encodeStateVector(s.doc))
				});
			}
		});
		const states = [];
		const ch = createCrdtChannel({ transport: s.transport });
		ch.onState((st) => states.push({ ...st }));
		await flush();
		expect(ch.degraded).toBe(true);
		expect(ch.synced).toBe(false);
		fail = false;
		ch.resync();
		await flush();
		expect(ch.degraded).toBe(false);
		expect(ch.synced).toBe(true);
		expect(states.some((st) => st.degraded)).toBe(true);
		expect(states[states.length - 1]).toMatchObject({ synced: true, degraded: false });
		ch.destroy();
	});

	it('dedupes a second resync while one is in flight, and re-fires after it settles', async () => {
		let hang = false;
		let resolveHang;
		const s = makeServer({
			sync(sv) {
				if (hang) return new Promise((r) => { resolveHang = r; });
				return Promise.resolve({
					topic: s.name,
					access: s.access,
					diff: Array.from(Y.encodeStateAsUpdate(s.doc, new Uint8Array(sv))),
					sv: Array.from(Y.encodeStateVector(s.doc))
				});
			}
		});
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		expect(s.syncs.length).toBe(1); // the open sync
		// A manual resync issues sync #2 (which hangs); a second resync while
		// it is in flight on the same connection is deduped, NOT a third call.
		hang = true;
		ch.resync();
		ch.resync();
		await flush();
		expect(s.syncs.length).toBe(2);
		// Settling the in-flight sync clears the per-generation guard, so the
		// next resync fires again - the channel is never wedged behind a
		// completed (or slow) request.
		hang = false;
		resolveHang({ topic: s.name, access: s.access, diff: [], sv: [] });
		await flush();
		ch.resync();
		await flush();
		expect(s.syncs.length).toBe(3);
		ch.destroy();
	});
});

describe('steady state', () => {
	it('forwards each local transaction upstream and never echoes a remote apply', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const before = s.uploads.length;
		ch.map().set('a', 1);
		expect(s.uploads.length).toBe(before + 1);
		expect(s.doc.getMap('root').get('a')).toBe(1);

		// A remote update applies to the local replica but is NOT re-sent.
		MockWebSocket._last.emit({ type: 'wire-id', topic: wire(s), id: 9 });
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(s.doc));
		const u = captureUpdate(peer, () => peer.getMap('root').set('b', 2));
		const sent = s.uploads.length;
		MockWebSocket._last.emitBinary(crdtFrame(9, u));
		await flush(2);
		expect(ch.map().get('b')).toBe(2);
		expect(s.uploads.length).toBe(sent);
		ch.destroy();
	});

	it('applies the JSON envelope path identically (poisoned/non-binary tier)', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const peer = new Y.Doc();
		const u = captureUpdate(peer, () => peer.getMap('root').set('via-json', true));
		MockWebSocket._last.emit({ topic: wire(s), event: 'crdt', data: { op: 'update', bytes: Array.from(u) } });
		await flush(2);
		expect(ch.map().get('via-json')).toBe(true);
		ch.destroy();
	});

	it('batches transact() mutations into one wire update', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const before = s.uploads.length;
		const m = ch.map();
		ch.transact(() => {
			m.set('x', 1);
			m.set('y', 2);
		});
		expect(s.uploads.length).toBe(before + 1);
		expect(s.doc.getMap('root').toJSON()).toMatchObject({ x: 1, y: 2 });
		ch.destroy();
	});

	it('buffers frames that race the first sync and replays only its own topic', async () => {
		let release;
		const s = makeServer({
			sync(sv) {
				return new Promise((resolve) => {
					release = () =>
						resolve({
							topic: s.name,
							access: s.access,
							diff: Array.from(Y.encodeStateAsUpdate(s.doc, new Uint8Array(sv))),
							sv: Array.from(Y.encodeStateVector(s.doc))
						});
				});
			}
		});
		const ch = createCrdtChannel({ transport: s.transport });
		await flush(2); // sync now in flight, topic unknown
		// A frame for OUR topic and one for a stranger topic arrive early.
		MockWebSocket._last.emit({ type: 'wire-id', topic: wire(s), id: 3 });
		MockWebSocket._last.emit({ type: 'wire-id', topic: CRDT_TOPIC_PREFIX + 'stranger', id: 4 });
		const peer = new Y.Doc();
		const mine = captureUpdate(peer, () => peer.getMap('root').set('early', 'yes'));
		const strangerDoc = new Y.Doc();
		const strangers = captureUpdate(strangerDoc, () => strangerDoc.getMap('root').set('not-ours', 1));
		MockWebSocket._last.emitBinary(crdtFrame(3, mine));
		MockWebSocket._last.emitBinary(crdtFrame(4, strangers));
		release();
		await flush();
		expect(ch.map().get('early')).toBe('yes');
		expect(ch.map().get('not-ours')).toBe(undefined);
		ch.destroy();
	});

	it('detects a dependency gap (lost frame) and resyncs', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		expect(s.syncs.length).toBe(1);
		MockWebSocket._last.emit({ type: 'wire-id', topic: wire(s), id: 5 });
		// Two sequential edits from one peer; deliver only the SECOND - its
		// dependency is missing, so the channel must schedule a resync.
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(s.doc));
		const u1 = captureUpdate(peer, () => peer.getMap('root').set('step', 1));
		const u2 = captureUpdate(peer, () => peer.getMap('root').set('step', 2));
		Y.applyUpdate(s.doc, u1);
		Y.applyUpdate(s.doc, u2);
		MockWebSocket._last.emitBinary(crdtFrame(5, u2, 2));
		await flush(2);
		expect(ch.map().get('step')).toBe(undefined); // pending, not applied
		await flush(300); // past the pending-resync debounce
		expect(s.syncs.length).toBe(2);
		expect(ch.map().get('step')).toBe(2); // the sync diff healed the gap
		ch.destroy();
	});
});

describe('read-only mounts', () => {
	it('throws on mutation, surfaces readOnly, and skips the sync upload', async () => {
		const s = makeServer();
		s.access = { read: true, write: false, comment: false };
		const ch = createCrdtChannel({ transport: s.transport });
		// a pre-sync local edit exists, but the reply says write: false - the
		// exchange must NOT upload it.
		ch.map().set('local', 1);
		await flush();
		expect(ch.readOnly).toBe(true);
		expect(s.uploads.length).toBe(0);
		expect(() => ch.map().set('x', 1)).toThrow('read-only');
		expect(() => ch.array('list').push(1)).toThrow('read-only');
		expect(() => ch.text('t').insert(0, 'a')).toThrow('read-only');
		expect(() => ch.transact(() => {})).toThrow('read-only');
		ch.destroy();
	});
});

describe('facets', () => {
	it('map onChange delivers the changed keys; reads are local-first', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const m = ch.map();
		const changes = [];
		const off = m.onChange((keys) => changes.push([...keys].sort()));
		m.set('a', 1);
		m.set('b', { nested: true });
		m.delete('a');
		expect(changes).toEqual([['a'], ['b'], ['a']]);
		expect(m.get('b')).toEqual({ nested: true });
		expect(m.has('a')).toBe(false);
		expect(m.size).toBe(1);
		expect(m.toJSON()).toEqual({ b: { nested: true } });
		off();
		m.set('c', 3);
		expect(changes.length).toBe(3);
		ch.destroy();
	});

	it('array facet keeps order and reports positional deltas', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const a = ch.array('list');
		const deltas = [];
		a.onChange((d) => deltas.push(d));
		a.push('one', 'two');
		a.insert(1, 'between');
		a.delete(0, 1);
		expect(a.toArray()).toEqual(['between', 'two']);
		expect(a.length).toBe(2);
		expect(a.at(0)).toBe('between');
		expect(deltas.length).toBe(3);
		expect(deltas[0][0]).toMatchObject({ insert: ['one', 'two'] });
		ch.destroy();
	});

	it('text facet supports character-level edits', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const t = ch.text('title');
		let fired = 0;
		t.onChange(() => fired++);
		t.insert(0, 'helo');
		t.insert(2, 'l');
		t.delete(0, 1);
		expect(t.toString()).toBe('ello');
		expect(t.length).toBe(4);
		expect(fired).toBe(3);
		ch.destroy();
	});

	it('fails fast on a container kind conflict', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		ch.map('shared');
		expect(() => ch.array('shared')).toThrow('one name, one kind');
		ch.destroy();
	});

	it('two channels over two transports converge through the server', async () => {
		const s = makeServer();
		const chA = createCrdtChannel({ transport: s.transport });
		await flush();
		// second client of the same document: its own transport, same doc
		const sB = {
			uploads: 0,
			transport: {
				sendUpdate(bytes) {
					sB.uploads++;
					Y.applyUpdate(s.doc, new Uint8Array(bytes));
				},
				sync(sv) {
					return Promise.resolve({
						topic: s.name + '-b', // distinct wire topic name (other connection)
						access: s.access,
						diff: Array.from(Y.encodeStateAsUpdate(s.doc, new Uint8Array(sv))),
						sv: Array.from(Y.encodeStateVector(s.doc))
					});
				}
			}
		};
		chA.map().set('from-a', 1);
		const chB = createCrdtChannel({ transport: sB.transport });
		await flush();
		expect(chB.map().get('from-a')).toBe(1); // B's first sync carried A's edit
		chA.destroy();
		chB.destroy();
	});
});

describe('teardown', () => {
	it('releases the server reference and stops applying', async () => {
		const s = makeServer();
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		const m = ch.map();
		ch.destroy();
		expect(s.closed).toBe(1);
		MockWebSocket._last.emit({ type: 'wire-id', topic: wire(s), id: 6 });
		const peer = new Y.Doc();
		const u = captureUpdate(peer, () => peer.getMap('root').set('late', 1));
		MockWebSocket._last.emitBinary(crdtFrame(6, u));
		await flush(2);
		expect(m.toJSON()).toEqual({});
	});

	it('does not call close when the channel never synced', async () => {
		const s = makeServer({ sync: () => Promise.reject(new Error('down')) });
		const ch = createCrdtChannel({ transport: s.transport });
		await flush();
		ch.destroy();
		expect(s.closed).toBe(0);
	});
});
