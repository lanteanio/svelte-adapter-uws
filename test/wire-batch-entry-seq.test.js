// publishWireBatch entries may carry their own explicit seq - the
// cluster-authoritative number a replay backend already allocated for that
// frame - with exactly publishWire({ seq: N })'s rules. This file pins the
// contract against the real built runtime:
//
//   1. an explicit entry seq reaches the wire verbatim, on the stateful walk
//      and on the stateless per-entry reroute alike;
//   2. a mixed batch stamps the counter only for the entries that draw from
//      it, and an explicit seq never advances the counter;
//   3. an invalid entry seq refuses the WHOLE batch before anything is
//      stamped, serialised or delivered;
//   4. the seq is read in the snapshot pass, so application code running
//      mid-batch cannot rewrite a later entry's number;
//   5. the max-seen record matches what N publishWire calls would have left:
//      explicit seqs through the monotone-max guard, counter seqs as a bare
//      set, applied in entry order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { WS_SUBSCRIPTIONS, WS_CAPS } from '../src/runtime/utils/ws-symbols.js';

const describeUWS = hasUWS ? describe : describe.skip;

const CAP = 'probe.entry-seq:1';

describeUWS('publishWireBatch per-entry explicit seq', () => {
	let server;
	let state;
	let platform;

	beforeAll(async () => {
		server = await startRealRuntime();
		state = await import('./fixture/build/handler/state.js');
		({ platform } = await import('./fixture/build/handler/platform.js'));
		// Counted so the stateful batch takes the per-socket walk rather than
		// the native fast path, which scripted sockets cannot observe.
		state.capCounts.adjust(null, [CAP]);
	}, 400000);

	afterAll(async () => {
		state?.capCounts.adjust([CAP], null);
		await server?.stop();
	});

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
			close() { /* not a real connection */ }
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

	const statefulWire = () => ({
		capability: CAP,
		schemaVersion: 1,
		state: { onAttach: () => ({ schemaVersion: 1 }) },
		encode: () => new Uint8Array([1])
	});

	it('stamps each explicit entry seq verbatim on the stateful walk', () => {
		const topic = 'entry-seq-stateful';
		withSockets(topic, (capable, plain) => {
			platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: 10 },
				{ data: { v: 'b' }, seq: 20 }
			], statefulWire(), { seq: false });

			const envelopes = plain.envelopes();
			expect(envelopes.map((e) => e.seq)).toEqual([10, 20]);
			expect(envelopes.map((e) => e.data)).toEqual([{ v: 'a' }, { v: 'b' }]);
			// The explicit lane never touched this topic's counter.
			expect(state.topicSeqs.has(topic)).toBe(false);
		});
	});

	it('stamps explicit entry seqs through the stateless per-entry reroute', () => {
		const topic = 'entry-seq-stateless';
		// No `state`: the batch routes each entry through publishWire. Entry 0
		// also excludes the capable socket, so the walk delivers to `plain` and
		// the compound per-entry form { data, excludeWs, seq } is exercised.
		const wire = { capability: CAP, schemaVersion: 1, encode: () => null };
		withSockets(topic, (capable, plain) => {
			platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: 10, excludeWs: capable },
				{ data: { v: 'b' }, seq: 20, excludeWs: capable }
			], wire, { seq: false });

			const envelopes = plain.envelopes();
			expect(envelopes.map((e) => e.seq)).toEqual([10, 20]);
			// The excluded socket received neither entry.
			expect(capable.sent.text.filter((t) => !t.includes('"wire-id"'))).toEqual([]);
			expect(state.topicSeqs.has(topic)).toBe(false);
		});
	});

	it('mixes explicit and counter entries without the explicit lane advancing the counter', () => {
		const topic = 'entry-seq-mixed';
		withSockets(topic, (capable, plain) => {
			platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: 1000 },
				{ data: { v: 'b' } }
			], statefulWire());

			const envelopes = plain.envelopes();
			// Entry 0 verbatim; entry 1 drew the topic's FIRST counter value -
			// the explicit seq did not advance it.
			expect(envelopes.map((e) => e.seq)).toEqual([1000, 1]);
			expect(state.topicSeqs.get(topic)).toBe(1);
		});
	});

	it('omits the seq for counter entries under { seq: false } while explicit entries keep theirs', () => {
		const topic = 'entry-seq-false';
		withSockets(topic, (capable, plain) => {
			platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: 10 },
				{ data: { v: 'b' } }
			], statefulWire(), { seq: false });

			const envelopes = plain.envelopes();
			expect(envelopes[0].seq).toBe(10);
			expect('seq' in envelopes[1]).toBe(false);
			// The explicit entry is recorded; the seq-less entry records
			// NOTHING - an opted-out entry must never bare-set the topic's
			// max to the 0 sentinel.
			expect(state.maxSeenSeq.get(topic)).toBe(10);
		});
	});

	// The entry lane keys on typeof, exactly as the options lane does: only a
	// number is an explicit seq. Anything else falls through to the shared
	// options - the same absorption stampSeq applies to options.seq - so the
	// two adapters in this family answer identically for every spelling.
	it('falls through to the shared options for a non-number entry seq', () => {
		const topic = 'entry-seq-fallthrough';
		withSockets(topic, (capable, plain) => {
			platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: null },
				{ data: { v: 'b' }, seq: true },
				{ data: { v: 'c' }, seq: '5' },
				{ data: { v: 'd' } }
			], statefulWire());

			expect(plain.envelopes().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
			expect(state.topicSeqs.get(topic)).toBe(4);
		});
	});

	it('refuses the whole batch on one invalid entry seq, with nothing delivered and nothing advanced', () => {
		const topic = 'entry-seq-refused';
		withSockets(topic, (capable, plain) => {
			// The invalid seq sits on entry 1, and entry 0's payload records
			// whether it was ever serialised: a loop that validated while
			// stamping would have run entry 0's toJSON - and on the stateless
			// reroute, fanned it out - before reaching the refusal.
			let serialised = false;
			expect(() => platform.publishWireBatch(topic, 'update', [
				{ data: { toJSON() { serialised = true; return { v: 'a' }; } }, seq: 10 },
				{ data: { v: 'b' }, seq: 0 }
			], statefulWire())).toThrow(TypeError);

			expect(serialised, 'an entry was serialised before the refusal landed').toBe(false);
			expect(plain.sent.text, 'a refused batch fanned an entry out anyway').toEqual([]);
			expect(state.topicSeqs.has(topic)).toBe(false);
			expect(state.maxSeenSeq.has(topic)).toBe(false);

			// The stateless reroute takes the same refusal at the same point.
			// Entry 0 carries an exclusion so a fanned-out entry would land on
			// the per-socket walk `plain` observes, not the native fast path.
			const stateless = { capability: CAP, schemaVersion: 1, encode: () => null };
			expect(() => platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' }, seq: 10, excludeWs: capable },
				{ data: { v: 'b' }, seq: 1.5 }
			], stateless, { seq: false })).toThrow(TypeError);
			expect(plain.sent.text, 'the stateless reroute fanned an entry out before refusing').toEqual([]);
			expect(state.maxSeenSeq.has(topic), 'the stateless reroute recorded a seq for a refused batch').toBe(false);
		});
	});

	// The options copy reads fields, not own properties: a numeric seq carried
	// on a prototype or by an inherited accessor must meet the same refusal a
	// plain one does - a spread would drop it from the copy and stamp the
	// counter under an authority nobody validated.
	it('refuses a numeric seq the options carry on their prototype', () => {
		const topic = 'entry-seq-proto-options';
		withSockets(topic, (capable, plain) => {
			expect(() => platform.publishWireBatch(topic, 'update', [
				{ data: { v: 'a' } }
			], statefulWire(), Object.create({ seq: 14 }))).toThrow(TypeError);
			expect(plain.sent.text, 'a smuggled batch-level seq published anyway').toEqual([]);
		});
	});

	it('stamps the seq an entry carried at call time, not one application code substituted', () => {
		const topic = 'entry-seq-aliased';
		withSockets(topic, (capable, plain) => {
			const entries = [
				{ data: null, seq: 10 },
				{ data: { v: 'b' }, seq: 20 }
			];
			entries[0].data = {
				toJSON() {
					// Runs while the batch is half-built. The snapshot already
					// read entry 1's seq, so this rewrite reaches nobody.
					entries[1].seq = 999;
					return { v: 'a' };
				}
			};

			platform.publishWireBatch(topic, 'update', entries, statefulWire(), { seq: false });

			expect(plain.envelopes().map((e) => e.seq)).toEqual([10, 20]);
		});
	});

	it('stamps the committed seq on the stateless reroute too, whatever a toJSON rewrites', () => {
		const topic = 'entry-seq-aliased-stateless';
		// No `state`: each entry routes through publishWire, whose per-entry
		// options draw from the pre-pass snapshot. Exclusions keep delivery on
		// the walk the scripted sockets observe.
		const wire = { capability: CAP, schemaVersion: 1, encode: () => null };
		withSockets(topic, (capable, plain) => {
			const entries = [
				{ data: null, seq: 10, excludeWs: capable },
				{ data: { v: 'b' }, seq: 20, excludeWs: capable }
			];
			entries[0].data = {
				toJSON() {
					// Entry 1's publish has not happened yet; a delivery loop
					// re-reading the caller's entries would stamp this.
					entries[1].seq = 999;
					return { v: 'a' };
				}
			};

			platform.publishWireBatch(topic, 'update', entries, wire, { seq: false });

			expect(plain.envelopes().map((e) => e.seq)).toEqual([10, 20]);
		});
	});

	it('records max-seen exactly as N publishWire calls would have', () => {
		// All-explicit: each seq takes the monotone-max guard, so a lower
		// later entry cannot regress the topic's max.
		const monotone = 'entry-seq-maxseen-monotone';
		withSockets(monotone, () => {
			platform.publishWireBatch(monotone, 'update', [
				{ data: { v: 'a' }, seq: 1000 },
				{ data: { v: 'b' }, seq: 5 }
			], statefulWire(), { seq: false });
		});
		expect(state.maxSeenSeq.get(monotone)).toBe(1000);

		// Mixed, in entry order: the guard records 1000, and the counter entry
		// that follows does NOT overwrite it with 1. Same record N publishWire
		// calls leave, which is what this case is really pinning - the counter
		// lane no longer claims a topic's record just by publishing to it,
		// because the explicit seq that came first armed the monotone guard.
		// Recording 1 here moved the observed maximum backward by 999, and that
		// value is read as a fabricated divergence by the convergence hash and
		// as a dropped floor by the resume cutover.
		const mixed = 'entry-seq-maxseen-mixed';
		withSockets(mixed, () => {
			platform.publishWireBatch(mixed, 'update', [
				{ data: { v: 'a' }, seq: 1000 },
				{ data: { v: 'b' } }
			], statefulWire());
		});
		expect(state.maxSeenSeq.get(mixed)).toBe(1000);
	});
});

// The same contract holds on the published createTestServer harness: an
// application suite written against the mirror must see the bytes production
// puts on the wire.
describeUWS('per-entry explicit seq on the createTestServer harness', () => {
	let server;
	const sent = [];

	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			__onPublish: ({ envelope }) => sent.push(envelope)
		});
	}, 400000);

	afterAll(async () => {
		await server?.close();
	});

	const wire = () => ({
		capability: 'fixture.entry-seq:1',
		schemaVersion: 1,
		state: { onAttach: () => ({ schemaVersion: 1 }) },
		encode: () => null
	});

	it('stamps explicit entry seqs and draws the counter only for entries without one', () => {
		sent.length = 0;
		server.platform.publishWireBatch('mirror-entry-seq', 'update', [
			{ data: { v: 'a' }, seq: 40 },
			{ data: { v: 'b' } }
		], wire());

		const seqs = sent.map((raw) => JSON.parse(raw).seq);
		expect(seqs).toEqual([40, 1]);
	});

	it('refuses the whole batch on an invalid entry seq, publishing nothing', () => {
		sent.length = 0;
		expect(() => server.platform.publishWireBatch('mirror-entry-seq-refused', 'update', [
			{ data: { v: 'a' }, seq: 7 },
			{ data: { v: 'b' }, seq: -1 }
		], wire(), { seq: false })).toThrow(TypeError);
		expect(sent, 'the harness fanned an entry out before refusing').toEqual([]);
	});

	it('stamps explicit entry seqs through the harness stateless reroute', () => {
		sent.length = 0;
		// No `state`: the harness routes each entry through its publishWire,
		// which must stamp the snapshot seq verbatim.
		const stateless = { capability: 'fixture.entry-seq-stateless:1', schemaVersion: 1, encode: () => null };
		server.platform.publishWireBatch('mirror-entry-seq-stateless', 'update', [
			{ data: { v: 'a' }, seq: 40 },
			{ data: { v: 'b' } }
		], stateless);

		const seqs = sent.map((raw) => JSON.parse(raw).seq);
		expect(seqs).toEqual([40, 1]);
	});
});
