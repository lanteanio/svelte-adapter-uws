// The relay receive half's re-entry marker is not a key an application can type.
//
// WHY THIS EXISTS. publishWire has an origin side and a relay side, and ONE
// boolean picks between them. The relay side skips the cluster sequence-
// authority check, skips the seq value check, skips the egress decision, skips
// the publish counter and the max-seen record, stamps the number it was handed
// instead of drawing the topic counter, and does not relay - all correct for a
// frame a sibling worker already published, counted and fanned out.
//
// That boolean used to be read from two ordinary option keys, `_isRelay` and
// `_relaySeq`, on the same caller-supplied object every other publish option
// arrives on. So an application could set them, and publish an arbitrary
// number as a topic's seq: off the publish ledger, past an armed egress
// ceiling, and out through the cluster relay the authority rule exists to keep
// unallocated numbers out of. Nothing refused it. The marker is now a Symbol
// created inside the runtime, which is a key no caller can produce rather than
// a key every lane has to remember to strip.
//
// WHAT MAKES THESE CASES ABLE TO FAIL. The stamp is the observable projection
// of that one boolean: a frame carrying the topic counter's number took the
// ORIGIN arm, and every other guard sits on the same arm. So the forgery cases
// assert the seq the client received, and the ceiling case adds the one
// refusal a caller observes directly - a publish that answers false.
//
// The two module facts the design rests on are asserted first, because neither
// is visible from a delivered frame: the Symbol is outside the cross-realm
// registry, and no export subpath reaches the module that holds it.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';
import { RELAY_ORIGIN_SEQ } from '../src/runtime/handler/cluster-sequence-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The number a forgery tries to stamp. Far above any counter these cases draw. */
const FORGED_SEQ = 4242;

/** A codec that declines every frame, so each publish takes the JSON envelope a plain client can read. */
const DECLINING_CODEC = {
	capability: 'test.relay-marker:1',
	schemaVersion: 1,
	encode: () => null
};

/**
 * Every spelling a caller could reach for. The string keys are the ones the
 * relay half actually used to carry, so they are the shipped defect; the
 * registry Symbol is the near-miss a later edit could reintroduce by reaching
 * for `Symbol.for` instead of `Symbol`, and a same-description own Symbol is
 * what a caller could build after reading the source.
 */
function forgedOptions() {
	return [
		{ _isRelay: true, _relaySeq: FORGED_SEQ },
		{ _relaySeq: FORGED_SEQ },
		{ relayOriginSeq: FORGED_SEQ },
		{ RELAY_ORIGIN_SEQ: FORGED_SEQ },
		{ [Symbol.for('adapter-uws.relay-origin-seq')]: FORGED_SEQ },
		{ [Symbol('adapter-uws.relay-origin-seq')]: FORGED_SEQ }
	];
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

describe('the relay re-entry marker cannot be named from outside the runtime', () => {
	it('is not in the cross-realm symbol registry', () => {
		// A registered Symbol is reachable by description from anywhere in the
		// process, which would make the marker a public string with extra
		// steps. Nothing else in the runtime may register it either, so the
		// registry lookup for the same description must be a DIFFERENT symbol.
		expect(Symbol.keyFor(RELAY_ORIGIN_SEQ)).toBeUndefined();
		expect(Symbol.for('adapter-uws.relay-origin-seq')).not.toBe(RELAY_ORIGIN_SEQ);
	});

	it('lives in a module no export subpath resolves to', () => {
		// The package export map is what stops an application importing the
		// module and reading the marker out of it: Node refuses a deep import
		// of a path the map does not name. Asserted over the whole map rather
		// than the one subpath, because a new entry pointing anywhere under
		// the runtime directory would hand the marker out.
		const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		const targets = [];
		for (const entry of Object.values(pkg.exports)) {
			if (typeof entry === 'string') targets.push(entry);
			else for (const target of Object.values(entry)) targets.push(target);
		}
		expect(targets.length).toBeGreaterThan(0);
		expect(targets.filter((t) => t.startsWith('./src/runtime/'))).toEqual([]);
	});
});

describe('a forged relay marker publishes as an ordinary origin frame', () => {
	it('cannot stamp its own seq: every delivery carries the topic counter', async () => {
		const server = await boot({});
		const c = await connect(server.wsUrl, 'forge');

		const forgeries = forgedOptions();
		for (const options of forgeries) {
			expect(server.platform.publishWire('forge', 'e', { n: 1 }, DECLINING_CODEC, options)).toBe(true);
		}

		await sleep(150);
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

		await sleep(150);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.map((f) => f.data.n), 'a refused publish delivered a frame').toEqual([1]);
	});

	it('the runtime-held marker is what the relay side actually reads', async () => {
		// The vacuity guard for both cases above: the same call shape, with the
		// real marker, takes the relay arm - no counter draw, the carried
		// number stamped verbatim. Without this, a publishWire that had simply
		// stopped honouring any marker at all would pass them.
		const server = await boot({});
		const c = await connect(server.wsUrl, 'forge');

		expect(server.platform.publishWire('forge', 'e', { n: 1 }, DECLINING_CODEC, {
			[RELAY_ORIGIN_SEQ]: FORGED_SEQ
		})).toBe(true);
		// A second frame, this time an ordinary origin publish: its seq proves
		// the relayed one did not draw the counter.
		expect(server.platform.publishWire('forge', 'e', { n: 2 }, DECLINING_CODEC)).toBe(true);

		await sleep(150);
		const delivered = c.frames.filter((f) => f.topic === 'forge' && f.event === 'e');
		expect(delivered.map((f) => f.seq)).toEqual([FORGED_SEQ, 1]);
	});
});
