// publishWireBatch read the caller's entries again AFTER application code had
// already run inside the call.
//
// completeEnvelope runs JSON.stringify, so a payload's toJSON executes in the
// middle of the stamping loop while the batch is half-built. Everything read
// after that point - the exclusion target in the delivery walk, the payload the
// binary encode receives, the entry count - came back out of the caller's array,
// so one entry's toJSON could change what a LATER read of an EARLIER entry saw.
//
// Two consequences are observable from outside, and this file pins both against
// the real built runtime:
//   1. the JSON envelope and the binary frame carry different payloads under the
//      same seq, so two subscribers disagree about one sequenced frame;
//   2. an exclusion the caller set is dropped, so the excluded socket is served
//      the entry anyway.
//
// LIMIT, deliberately not tested as a fix: mutating the payload object's own
// fields (rather than replacing the reference) still reaches the binary encode,
// because every path holds the same object by reference and deep-copying a
// payload on a per-message path is not a trade this adapter makes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { WS_SUBSCRIPTIONS, WS_CAPS } from '../src/runtime/utils/ws-symbols.js';

const describeUWS = hasUWS ? describe : describe.skip;

const CAP = 'probe.aliasing:1';

describeUWS('publishWireBatch reads each caller entry once', () => {
	let server;
	let state;
	let platform;

	beforeAll(async () => {
		server = await startRealRuntime();
		state = await import('./fixture/build/handler/state.js');
		({ platform } = await import('./fixture/build/handler/platform.js'));
		// What a client's `hello` does when it advertises the capability. Without
		// it publishWireBatch takes the JSON fast path and never reaches the
		// per-socket walk this exercises.
		state.capCounts.adjust(null, [CAP]);
	}, 400000);

	afterAll(async () => {
		state?.capCounts.adjust([CAP], null);
		await server?.stop();
	});

	/** A connection scripted into the live set, as the wire suites do. */
	function scriptedWs(topic, caps) {
		const ud = {};
		ud[WS_SUBSCRIPTIONS] = new Set([topic]);
		ud[WS_CAPS] = new Set(caps);
		const sent = { text: [], binary: [] };
		return {
			sent,
			envelopes() { return sent.text.map((t) => JSON.parse(t)); },
			getUserData() { return ud; },
			send(payload, isBinary) {
				if (isBinary) sent.binary.push(new Uint8Array(payload));
				else sent.text.push(String(payload));
				return 1;
			},
			close() { /* the harness closes real connections; this is not one */ }
		};
	}

	function withSockets(topic, run) {
		const capable = scriptedWs(topic, [CAP]);
		const plain = scriptedWs(topic, []);
		state.wsConnections.add(capable);
		state.wsConnections.add(plain);
		try {
			return run(capable, plain);
		} finally {
			state.wsConnections.delete(capable);
			state.wsConnections.delete(plain);
		}
	}

	it('serves the binary and JSON subscribers the same payload under one seq', () => {
		const topic = 'wire-batch-aliasing-payload';
		/** @type {any[]} */
		const encoded = [];
		const wire = {
			capability: CAP,
			schemaVersion: 1,
			// A per-connection wire state, as ensureWireState expects: without an
			// onAttach the state resolves null and every socket is served JSON.
			state: { onAttach: () => ({ schemaVersion: 1 }) },
			encode(event, data) {
				// Snapshot what the codec was handed, at the moment it was handed it.
				encoded.push(JSON.parse(JSON.stringify(data)));
				return new Uint8Array([1]);
			}
		};

		withSockets(topic, (capable, plain) => {
			const entries = [{ data: { v: 'original' } }, { data: null }];
			// Runs while the batch is half-built: entry 0's envelope is already a
			// string, entry 1's has yet to be written.
			entries[1].data = {
				toJSON() {
					entries[0].data = { v: 'swapped' };
					return { v: 'trigger' };
				}
			};

			platform.publishWireBatch(topic, 'update', entries, wire, { seq: false });

			// The batch must have reached the per-socket walk; the JSON fast path
			// would never call the codec and the assertion below would pass vacuously.
			expect(state.capCounts.has(CAP), 'capability not counted: the batch took the JSON fast path').toBe(true);
			expect(encoded.length, 'the codec was never asked to encode this batch').toBeGreaterThan(0);
			const jsonFirst = plain.envelopes()[0];
			expect(jsonFirst.data).toEqual({ v: 'original' });
			// The batch encode is called once with every entry's payload.
			const updates = encoded[0]?.updates ?? [];
			expect(updates[0], 'binary subscriber received a different payload than the JSON subscriber for the same entry')
				.toEqual(jsonFirst.data);
		});
	});

	it('honours an exclusion that application code clears mid-batch', () => {
		const topic = 'wire-batch-aliasing-exclude';
		const wire = {
			capability: CAP,
			schemaVersion: 1,
			// A per-connection wire state, as ensureWireState expects: without an
			// onAttach the state resolves null and every socket is served JSON.
			state: { onAttach: () => ({ schemaVersion: 1 }) },
			encode() { return new Uint8Array([1]); }
		};

		withSockets(topic, (capable, plain) => {
			const entries = [{ data: { v: 'first' }, excludeWs: capable }, { data: null }];
			entries[1].data = {
				toJSON() {
					// The caller excluded `capable` from entry 0. Clearing it here is
					// after the exclusion was counted but before the walk reads it.
					entries[0].excludeWs = undefined;
					return { v: 'trigger' };
				}
			};

			platform.publishWireBatch(topic, 'update', entries, wire, { seq: false });

			// The excluded socket may receive entry 1, never entry 0.
			const texts = capable.sent.text.join('|');
			expect(texts.includes('"first"'), 'the excluded socket was served the entry it was excluded from')
				.toBe(false);
			// The included socket still gets both, so this is not "delivered nothing".
			expect(plain.sent.text.length + plain.sent.binary.length).toBeGreaterThan(0);
		});
	});
});
