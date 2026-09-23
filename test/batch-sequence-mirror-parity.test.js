// The batch surface refuses a numeric `seq`, and it has to refuse it on ALL
// THREE surfaces - production, the published `createTestServer` harness, and the
// Vite dev plugin.
//
// WHY THIS EXISTS. The refusal shipped on all three, but only production was
// pinned: `cluster-sequence-policy-real.test.js` drives the built fixture, and
// nothing anywhere passed a numeric seq to a batch on either mirror. Deleting
// the refusal from `src/testing.js` or from `src/vite.js` left the entire suite
// green. That is the exact drift this repo maintains two cross-surface oracles
// for, and neither of them covers the publish sequence lane - `surface-policy-
// parity` and `surface-differential` cover subscribe, grant and recover only.
//
// A permissive mirror is worse than a missing one: an application suite written
// against `createTestServer` would certify a batch call that stamps every entry
// with one caller-supplied seq, then production throws on the first tick. The
// mirror's own comment says it exists to stop exactly that, so it is worth a
// test that goes red when the line is removed.
//
// THE EMPTY BATCH IS PART OF THE CONTRACT, not an edge case: the refusal is a
// property of the SURFACE, so it must run before the entries are inspected. A
// mirror that checked the options after an `entries.length === 0` early return
// would accept, for an empty tick, options it rejects for a full one - and the
// contract would change shape with the data, which is the arity dependence the
// rule was rewritten to make unreachable.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { BATCH_SEQUENCE_ERROR } from '../src/runtime/handler/cluster-sequence-policy.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const itUWS = uWS ? it : it.skip;

/** Teardown registered by whichever surface a test booted. */
let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
});

const WIRE = { capability: 'fixture.mirror-parity:1', schemaVersion: 1, encode: () => null };
// The SAME contract has to hold on the stateful lane, which is a different
// entry loop with its own copy of the resolution. A `state` key is the only
// thing that selects it (`if (!wire || !wire.state)`), so a fixture without one
// silently drives the stateless lane twice and leaves the stateful sites
// unpinned - a green case proving the claim only where it drove.
const WIRE_STATEFUL = {
	capability: 'fixture.mirror-parity-stateful:1',
	schemaVersion: 1,
	state: { onAttach: () => ({}) },
	encode: () => null
};
const ENTRIES = [{ data: { n: 1 } }, { data: { n: 2 } }];

/**
 * The per-entry seq contract, against whichever surface's platform is handed
 * in: the valid per-entry spelling is ACCEPTED (dev stamps no seq, but it must
 * take the call), and an entry seq the wire cannot carry is refused - by every
 * surface, in the same shape, before anything is delivered.
 */
function assertEntrySeqContract(platform, label) {
	expect(
		() => platform.publishWireBatch('mirror-entry-room', 'update', [{ data: { n: 1 }, seq: 5 }, { data: { n: 2 } }], WIRE, { seq: false }),
		`${label}: the per-entry seq spelling must be accepted`
	).not.toThrow();

	// The whole entry table, identically on every surface: bigint is the
	// second spelling of the explicit authority, and true/false/null are
	// per-entry overrides of the shared options.
	expect(
		() => platform.publishWireBatch('mirror-entry-table', 'update', [{ data: { n: 1 }, seq: 7n }, { data: { n: 2 } }], WIRE, { seq: false }),
		`${label}: the bigint spelling must be accepted`
	).not.toThrow();
	expect(
		() => platform.publishWireBatch('mirror-entry-table', 'update',
			[{ data: { n: 1 }, seq: false }, { data: { n: 2 }, seq: null }, { data: { n: 3 }, seq: true }], WIRE, {}),
		`${label}: the per-entry override spellings must be accepted`
	).not.toThrow();

	// The first value every 1-based authority issues must be accepted.
	expect(
		() => platform.publishWireBatch('mirror-entry-table', 'update', [{ data: { n: 1 }, seq: 1 }], WIRE, { seq: false }),
		`${label}: an entry seq of 1 must be accepted`
	).not.toThrow();

	// The largest entry seq the wire carries faithfully, on both spellings.
	expect(
		() => platform.publishWireBatch('mirror-entry-table', 'update',
			[{ data: { n: 1 }, seq: Number.MAX_SAFE_INTEGER }, { data: { n: 2 }, seq: BigInt(Number.MAX_SAFE_INTEGER) }], WIRE, { seq: false }),
		`${label}: the largest carryable entry seq must be accepted`
	).not.toThrow();

	for (const bad of [0, -1, 1.5, Number.NaN, 0n, -1n, '7', {}, []]) {
		expect(
			() => platform.publishWireBatch('mirror-entry-room', 'update', [{ data: { n: 1 }, seq: bad }], WIRE, { seq: false }),
			`${label}: an entry seq of ${String(bad)} must be refused`
		).toThrow(TypeError);
	}

	// One bad value refuses the WHOLE batch, so the message has to say which
	// entry carried it - otherwise a caller handing over hundreds gets one
	// throw and no way to find the offender. Third entry, so a message that
	// hardcoded 0 or reported a count rather than a position fails here. Run
	// against BOTH lanes: each has its own entry loop and its own copy of the
	// resolution, so one lane's coverage says nothing about the other's.
	for (const [wire, lane] of [[WIRE, 'stateless'], [WIRE_STATEFUL, 'stateful']]) {
		expect(
			() => platform.publishWireBatch('mirror-entry-room', 'update', [
				{ data: { n: 1 }, seq: 5 }, { data: { n: 2 } }, { data: { n: 3 }, seq: '7' }, { data: { n: 4 } }
			], wire, { seq: false }),
			`${label}/${lane}: a refusal must name the entry's position`
		).toThrow(/batch entry 2:/);
		expect(
			() => platform.publishWireBatch('mirror-entry-room', 'update', [
				{ data: { n: 1 } }, { data: { n: 2 }, seq: 2 ** 53 }
			], wire, { seq: false }),
			`${label}/${lane}: the position rides the magnitude refusal too`
		).toThrow(/batch entry 1: seq .*exceeds the wire/);
	}

	// Past the safe-integer range the entry lane must refuse for the SAME
	// reason the options lane does, and say so: this is the spelling the
	// clustered explicit authority actually travels on, so a lane that only
	// projected here would put a rounded id on the wire with every gate green.
	for (const over of [2 ** 53, 2n ** 53n, 2n ** 53n + 2n, 1541815603606036481n, 10n ** 400n]) {
		expect(
			() => platform.publishWireBatch('mirror-entry-room', 'update', [{ data: { n: 1 }, seq: over }], WIRE, { seq: false }),
			`${label}: an entry seq of ${String(over)} must be refused as uncarryable`
		).toThrow(/exceeds the wire/i);
	}
}

/**
 * The same four assertions against whichever surface's platform is handed in,
 * so a mirror cannot pass by refusing in a different shape than production.
 */
function assertRefusesNumericSeq(platform, label) {
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: 14, relay: false }),
		`${label}: a numeric seq must be refused`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// The bigint spelling of the same category error: one options value can no
	// more be one-seq-per-entry than one number can.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: 14n, relay: false }),
		`${label}: a bigint options seq must be refused`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// A single-entry batch is refused an options seq exactly as a multi-entry
	// one is, so the contract never depends on the length of the array.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', [{ data: { n: 1 } }], WIRE, { seq: 14, relay: false }),
		`${label}: a single-entry batch must refuse it as well`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// Before the entries are inspected - an empty batch refuses what a full one refuses.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', [], WIRE, { seq: 14, relay: false }),
		`${label}: the refusal must precede the entry inspection`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// Vacuity guard: the surface must still ACCEPT the supported shape, or a
	// mirror that threw on everything would satisfy the three assertions above.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: false }),
		`${label}: refused the supported shape`
	).not.toThrow();
}

/**
 * The options seq refused for its VALUE rather than for the topology or for the
 * one-seq-per-entry rule - a string from a JSON column, an object, a function.
 *
 * Driven on the EMPTY batch as well, and that is the case that carries the
 * claim: a non-empty batch reaches the stamping loop, which refuses these
 * anyway, so it stays green whether the gate checks them or not. The empty call
 * returns before any loop runs, so it answers `false` for a value the same
 * surface throws on the moment one entry is added - the contract changing shape
 * with the data again. It also sits after the batch has taken its egress
 * decision, which is the second reason the check belongs at the gate.
 */
function assertRefusesUnstampableSeq(platform, label) {
	for (const bad of ['7', {}, [], () => 1, Symbol.iterator]) {
		expect(
			() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: bad }),
			`${label}: an options seq of ${String(bad)} must be refused`
		).toThrow(TypeError);
		expect(
			() => platform.publishWireBatch('mirror-room', 'update', [], WIRE, { seq: bad }),
			`${label}: an empty batch must refuse an options seq of ${String(bad)} too`
		).toThrow(TypeError);
	}

	// Vacuity guard: every spelling the stamp takes is still accepted, empty
	// batch included, or a gate that threw on everything would pass the above.
	for (const ok of [undefined, true, false, null]) {
		expect(
			() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: ok }),
			`${label}: an options seq of ${String(ok)} must be accepted`
		).not.toThrow();
		expect(
			() => platform.publishWireBatch('mirror-room', 'update', [], WIRE, { seq: ok }),
			`${label}: an empty batch must accept an options seq of ${String(ok)}`
		).not.toThrow();
	}
}

async function bootDevPlatform() {
	const mod = await import('../src/vite.js');
	let platform = null;
	const handler = { open(ws, ctx) { platform = ctx.platform; } };
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

	const httpServer = createServer();
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	const port = httpServer.address().port;
	teardown.push(() => new Promise((r) => httpServer.close(() => r(undefined))));

	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: handler, ...handler }; }
	});

	// The dev platform is handed to the hooks, so a real connection is what
	// surfaces it - which also proves the plugin wired the handler at all.
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	teardown.push(() => { try { ws.terminate(); } catch { /* gone */ } });
	const frames = [];
	ws.on('message', (d) => frames.push(String(d)));
	for (let i = 0; i < 200 && platform === null; i++) await new Promise((r) => setTimeout(r, 10));
	expect(platform, 'the dev plugin never handed its platform to the handler').not.toBeNull();
	return { platform, ws, frames };
}

describe('the batch numeric-seq refusal holds on every surface, not just production', () => {
	itUWS('refuses it on the published createTestServer harness', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer();
		teardown.push(() => server.close());

		assertRefusesNumericSeq(server.platform, 'createTestServer');
		assertRefusesUnstampableSeq(server.platform, 'createTestServer');
		assertEntrySeqContract(server.platform, 'createTestServer');
	}, 30000);

	it('refuses it on the Vite dev plugin', async () => {
		const { platform, ws, frames } = await bootDevPlatform();

		const parsed = () => frames.map((t) => { try { return JSON.parse(t); } catch { return null; } });
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'mirror-entry-room' }));
		// Anchor on the ack rather than a fixed sleep, as the boot poll does.
		for (let i = 0; i < 200; i++) {
			if (parsed().some((e) => e && e.type === 'subscribed' && e.topic === 'mirror-entry-room')) break;
			await new Promise((r) => setTimeout(r, 10));
		}

		assertRefusesNumericSeq(platform, 'vite dev');
		assertRefusesUnstampableSeq(platform, 'vite dev');
		assertEntrySeqContract(platform, 'vite dev');

		// The accepted per-entry batch was DELIVERED, and delivered seq-less:
		// dev stamps no seq on ordinary publishes (its documented posture), so
		// an accepted `{ data, seq }` entry must not sprout one here either.
		const delivered = () => parsed()
			.filter((e) => e && e.topic === 'mirror-entry-room' && e.event === 'update');
		for (let i = 0; i < 200 && delivered().length < 2; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		await new Promise((r) => setTimeout(r, 20));
		const envelopes = delivered();
		expect(envelopes.length, 'dev delivered a different entry set than the caller committed').toBe(2);
		for (const env of envelopes) {
			expect('seq' in env, 'dev stamped a seq it documents not stamping').toBe(false);
		}
		expect(envelopes.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);
	}, 30000);
});

// The entry table's OVERRIDES, asserted on delivered envelopes rather than on
// accepted calls: an explicit entry stamps verbatim without advancing the
// counter, `true` draws this entry its own counter value, `false` and `null`
// leave the entry seq-less under a batch that opts in, and the counter is one
// continuous track across batches. Acceptance alone is satisfiable by a
// surface that ignores entry seqs entirely; what the wire carries is not.
describe('the entry overrides land on the wire, on the harness the applications certify against', () => {
	itUWS('stamps each entry by its own resolution and keeps one counter track', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const sent = [];
		const server = await createTestServer({
			__onPublish: ({ envelope }) => sent.push(JSON.parse(envelope))
		});
		teardown.push(() => server.close());

		const wire = {
			capability: 'fixture.mirror-overrides:1',
			schemaVersion: 1,
			state: { onAttach: () => ({}) },
			encode: () => null
		};
		server.platform.publishWireBatch('mirror-override-room', 'update', [
			{ data: { n: 0 }, seq: 9 },
			{ data: { n: 1 }, seq: true },
			{ data: { n: 2 }, seq: false },
			{ data: { n: 3 }, seq: null },
			{ data: { n: 4 } }
		], wire, {});
		// A second batch under a no-seq default: the lone true entry still
		// draws the counter, continuing the same track.
		server.platform.publishWireBatch('mirror-override-room', 'update', [
			{ data: { n: 5 }, seq: true },
			{ data: { n: 6 } }
		], wire, { seq: false });

		// The bigint spelling has to be checked on the DELIVERED value, not
		// only on "it did not throw": a lane that projected through Number()
		// would be indistinguishable here for a small id and would silently
		// round a real one.
		server.platform.publishWireBatch('mirror-override-room', 'update', [
			{ data: { n: 7 }, seq: 11n },
			{ data: { n: 8 }, seq: BigInt(Number.MAX_SAFE_INTEGER) }
		], wire, { seq: false });

		const seqs = sent.map((e) => ('seq' in e ? e.seq : null));
		// Entry order: explicit 9 (counter untouched), counter 1, omitted,
		// omitted, counter 2 (the batch default), then counter 3 under a
		// seq-less default and omitted for the entry that inherits it, then
		// the two bigint authorities, which leave the counter alone as well.
		expect(seqs).toEqual([9, 1, null, null, 2, 3, null, 11, Number.MAX_SAFE_INTEGER]);
		expect(sent.map((e) => e.data.n), 'delivery order must be entry order').toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	}, 30000);
});

// The batch reads the WHOLE caller array before it builds the first envelope,
// and that too shipped on production and the harness together while only
// production was pinned - the aliasing suite drives the built fixture, so
// reverting the harness hunk left the whole suite green. Same drift, same
// answer: a mirror an application suite certifies against must publish what
// production publishes.
describe('the batch reads every entry before application code runs, on the harness too', () => {
	itUWS('publishes the payload an entry held at call time, not one an earlier entry substituted', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const sent = [];
		const server = await createTestServer({
			__onPublish: ({ envelope }) => sent.push(envelope)
		});
		teardown.push(() => server.close());

		// A stateful codec, so the call takes the batched walk rather than the
		// per-entry stateless reroute, which pre-reads on every surface already.
		const wire = {
			capability: 'fixture.mirror-alias:1',
			schemaVersion: 1,
			state: { onAttach: () => ({ schemaVersion: 1 }) },
			encode: () => null
		};
		const entries = [{ data: null }, { data: { v: 'committed' } }];
		entries[0].data = {
			toJSON() {
				// Entry 1 has not been read yet by a single-pass loop.
				entries[1].data = { v: 'substituted' };
				return { v: 'first' };
			}
		};
		server.platform.publishWireBatch('mirror-alias-room', 'update', entries, wire, { seq: false });

		const payloads = sent.map((raw) => JSON.parse(raw).data);
		expect(payloads.length, 'the harness published no envelopes for this batch').toBe(2);
		expect(payloads[1], 'the harness published a payload entry 1 never committed, so it disagrees with production')
			.toEqual({ v: 'committed' });
	}, 30000);
});
