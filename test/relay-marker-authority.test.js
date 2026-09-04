// The relay re-entry marker is not something an application can reach.
//
// WHY THIS EXISTS. publishWire has an origin side and a relay side, and ONE
// boolean picks between them. The relay side skips the cluster sequence-
// authority check, skips the seq value check, skips the egress decision, skips
// the publish counter and the max-seen record, stamps the number it was handed
// instead of drawing the topic counter, and does not relay - all correct for a
// frame a sibling worker already published, counted and fanned out.
//
// That boolean was first read from two ordinary option keys, `_isRelay` and
// `_relaySeq`, on the same caller-supplied object every other publish option
// arrives on, so an application could set them and publish an arbitrary number
// as a topic's seq: off the publish ledger, past an armed egress ceiling, and
// out through the cluster relay the authority rule exists to keep unallocated
// numbers out of.
//
// Naming the key with a Symbol did not close it. A marker read as a PROPERTY is
// unspellable but not unforgeable: a caller never has to name the key, only to
// pass an object that answers for every key - `new Proxy({}, { get: () => x })`,
// or a getter inherited from a prototype - and it takes the relay arm without
// knowing what the key is called. So the marker is not a key at all now. It is
// an argument compared by identity against a token the module never hands out,
// and there is no property lookup left for such an object to answer.
//
// WHAT MAKES THESE CASES ABLE TO FAIL. The stamp is the observable projection
// of that one boolean: a frame carrying the topic counter's number took the
// ORIGIN arm, and every other guard sits on the same arm. So the forgery cases
// assert the seq the client received, and the ceiling case adds the one
// refusal a caller observes directly - a publish that answers false.

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';

/** The number a forgery tries to stamp. Far above any counter these cases draw. */
const FORGED_SEQ = 4242;

/** A codec that declines every frame, so each publish takes the JSON envelope a plain client can read. */
const DECLINING_CODEC = {
	capability: 'test.relay-marker:1',
	schemaVersion: 1,
	encode: () => null
};

/**
 * Guesses at a key: the two the relay half actually used to carry, two
 * plausible spellings of the constant, and the Symbol forms - the registry
 * lookup a later edit could reintroduce by reaching for `Symbol.for`, and a
 * same-description own Symbol built after reading the source. None of these
 * names any documented option, so the seq a delivery carries must come from
 * the topic counter.
 */
function namedForgeries() {
	return [
		{ _isRelay: true, _relaySeq: FORGED_SEQ },
		{ _relaySeq: FORGED_SEQ },
		{ relayOriginSeq: FORGED_SEQ },
		{ RELAY_ORIGIN_SEQ: FORGED_SEQ },
		{ [Symbol.for('adapter-uws.relay-origin-seq')]: FORGED_SEQ },
		{ [Symbol.for('adapter-uws.relay-receive')]: FORGED_SEQ },
		{ [Symbol('adapter-uws.relay-receive')]: FORGED_SEQ }
	];
}

/**
 * Objects that guess nothing and answer for EVERY key, which is what satisfies
 * a property-shaped marker without naming it. A Proxy and a plain prototype
 * getter both, since the second needs no exotic object and a design that only
 * worried about Proxy would still be open.
 *
 * Their seq is not the discriminator, and this is worth being exact about: an
 * object that answers every key also answers `seq`, so `get: () => null` is a
 * caller asking for no seq and `get: () => 4242` is a caller passing an
 * explicit authority - both DOCUMENTED, both allowed, and neither says
 * anything about which arm the call took. The armed-ceiling case is where these
 * shapes are held to account, because a refusal can only come from the origin
 * arm.
 */
function answeringForgeries() {
	return [
		new Proxy({}, { get: () => null }),
		new Proxy({}, { get: () => FORGED_SEQ }),
		Object.create(new Proxy({}, { get: () => null })),
		// The key-echoing family, which is what separates "cannot name the key"
		// from "cannot produce the value": a `get` trap is HANDED the key it is
		// asked for, so echoing it satisfies any test comparing the value to
		// the key. Symbols only - echoing string keys hands `seq` back a string
		// and the call is refused for THAT, which looks like the guard working
		// and is not.
		new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) }),
		Object.create(new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? key : undefined) }))
	];
}

/** Every shape, for the assertions that hold for all of them. */
function forgedOptions() {
	return [...namedForgeries(), ...answeringForgeries()];
}

/** @type {Array<{ close(): void }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

afterEach(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(30);
	for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
	await sleep(30);
});

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

/** A real client subscribed to `topic`, recording every JSON frame it receives. */
async function connect(url, topic) {
	const ws = new WebSocket(url);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
	await sleep(120);
	return { ws, frames };
}

describe('a forged relay marker publishes as an ordinary origin frame', () => {
	it('cannot stamp its own seq: every delivery carries the topic counter', async () => {
		const server = await boot({});
		const c = await connect(server.wsUrl, 'forge');

		const forgeries = namedForgeries();
		for (const options of forgeries) {
			expect(server.platform.publishWire('forge', 'e', { n: 1 }, DECLINING_CODEC, options)).toBe(true);
		}

		await sleep(200);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.length, 'every forged publish must still be delivered').toBe(forgeries.length);
		// The counter, drawn once per call, starting from an untouched topic -
		// so the sequence is exactly 1..N and none of it is the forged number.
		expect(delivered.map((f) => f.seq)).toEqual(forgeries.map((_, i) => i + 1));
		expect(delivered.some((f) => f.seq === FORGED_SEQ)).toBe(false);
	});

	it('cannot cross an armed egress ceiling', async () => {
		// The egress decision is on the same origin arm as the stamp, and it is
		// the one a caller sees answered: a refusal returns false. One message
		// of headroom, spent by a plain publish, so every forgery below meets a
		// ceiling that is already crossed.
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 1 } } });
		const c = await connect(server.wsUrl, 'forge');

		expect(server.platform.publishWire('forge', 'e', { n: 1 }, DECLINING_CODEC)).toBe(true);
		for (const options of forgedOptions()) {
			expect(server.platform.publishWire('forge', 'e', { n: 2 }, DECLINING_CODEC, options)).toBe(false);
		}

		await sleep(200);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.map((f) => f.data.n), 'a refused publish delivered a frame').toEqual([1]);
	});

	it('cannot be reached by passing values in the token position', async () => {
		// The token is an argument now, so the argument itself is worth
		// attacking. Nothing a caller can construct is identical to a Symbol
		// this module never exported - including a registry symbol with the
		// same description, which is the near-miss `Symbol.for` would create.
		const server = await boot({});
		const c = await connect(server.wsUrl, 'forge');

		const tokens = [
			true,
			'relay',
			Symbol('adapter-uws.relay-receive'),
			Symbol.for('adapter-uws.relay-receive'),
			Symbol.iterator,
			{}
		];
		for (const token of tokens) {
			expect(server.platform.publishWire('forge', 'e', { n: 1 }, DECLINING_CODEC, undefined, token, FORGED_SEQ)).toBe(true);
		}

		await sleep(200);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.map((f) => f.seq)).toEqual(tokens.map((_, i) => i + 1));
	});

	it('the real relay path still takes the relay arm', async () => {
		// The vacuity guard for all three cases above: the legitimate internal
		// caller must still be recognised, or a publishWire that had simply
		// stopped honouring any marker would pass them. Driven through
		// relayPublishWire rather than by synthesizing a token, because the
		// token is not reachable from here - which is the point.
		const server = await boot({});
		server.platform.registerWireCodec(DECLINING_CODEC);
		const c = await connect(server.wsUrl, 'forge');

		// A capable client is what makes the relay re-encode worth entering; a
		// declining codec then sends everyone the JSON envelope, so the seq is
		// readable off the frame this plain client receives.
		const capable = new WebSocket(server.wsUrl);
		clients.push(capable);
		await new Promise((resolve, reject) => { capable.on('open', resolve); capable.on('error', reject); });
		capable.send(JSON.stringify({ type: 'hello', caps: [DECLINING_CODEC.capability] }));
		capable.send(JSON.stringify({ type: 'subscribe', topic: 'forge' }));
		await sleep(120);

		expect(server.platform.relayPublishWire('forge', 'e', { n: 1 }, DECLINING_CODEC.capability, FORGED_SEQ, false)).toBe(true);
		// An ordinary origin publish after it: its seq proves the relayed frame
		// did not draw the counter.
		expect(server.platform.publishWire('forge', 'e', { n: 2 }, DECLINING_CODEC)).toBe(true);

		await sleep(200);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.map((f) => f.seq)).toEqual([FORGED_SEQ, 1]);
	});
});
