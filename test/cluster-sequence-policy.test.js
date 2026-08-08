import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BATCH_SEQUENCE_ERROR,
	BATCH_ENTRY_SEQUENCE_ERROR,
	CLUSTER_SEQUENCE_ERROR,
	assertClusterSequenceAuthority,
	assertClusterSequenceAuthorityValues,
	assertBatchSequenceAuthority,
	assertBatchEntrySequenceAuthority,
	clusterSequenceAccepted,
	clusterSequenceValuesAccepted,
	hasMultipleWorkers
} from '../src/runtime/handler/cluster-sequence-policy.js';
import { stampSeq, stampSeqValue } from '../src/runtime/utils/epoch.js';

describe('cluster sequence authority policy', () => {
	const cluster = { totalWorkers: 3, ioWorkers: 2 };

	it('accepts implicit counters only outside a multi-worker process', () => {
		expect(hasMultipleWorkers(null)).toBe(false);
		expect(hasMultipleWorkers({ totalWorkers: 1 })).toBe(false);
		expect(hasMultipleWorkers(cluster)).toBe(true);
		expect(clusterSequenceAccepted(undefined, null)).toBe(true);
		expect(clusterSequenceAccepted(undefined, { totalWorkers: 1 })).toBe(true);
		expect(clusterSequenceAccepted(undefined, cluster)).toBe(false);
	});

	it('requires either no seq or an external numeric seq with built-in relay disabled', () => {
		for (const accepted of [
			{ seq: false },
			{ seq: false, relay: false },
			{ seq: 41, relay: false }
		]) expect(clusterSequenceAccepted(accepted, cluster), JSON.stringify(accepted)).toBe(true);

		for (const rejected of [
			undefined, {}, { relay: false }, { seq: true }, { seq: 41 }, { seq: 41, relay: true },
			{ seq: 0, relay: false }, { seq: -1, relay: false }, { seq: 1.5, relay: false },
			{ seq: Number.NaN, relay: false }, { seq: Number.POSITIVE_INFINITY, relay: false }
		]) {
			expect(clusterSequenceAccepted(rejected, cluster), JSON.stringify(rejected)).toBe(false);
			expect(() => assertClusterSequenceAuthority(rejected, cluster)).toThrow(CLUSTER_SEQUENCE_ERROR);
		}
	});

	it('rejects a numeric authority on the batch surface whatever it is publishing', () => {
		expect(() => assertBatchSequenceAuthority({ seq: 7, relay: false }, cluster))
			.toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: false }, cluster)).not.toThrow();
	});

	// The refusal used to be gated on hasMultipleWorkers, so the corruption it
	// exists to prevent was live on the DEFAULT single-worker deployment: stampSeq
	// returns a caller-supplied number verbatim and publishWireBatch calls it once
	// per entry, so every entry carried the same seq whatever the topology. Only
	// the clustered case was covered here, which is why it survived.
	it('rejects the numeric authority off-cluster too, where the default deployment lives', () => {
		for (const solo of [null, { totalWorkers: 1 }, { totalWorkers: 1, ioWorkers: 1 }]) {
			expect(hasMultipleWorkers(solo), JSON.stringify(solo)).toBe(false);
			expect(
				() => assertBatchSequenceAuthority({ seq: 7, relay: false }, solo),
				JSON.stringify(solo)
			).toThrow(BATCH_SEQUENCE_ERROR);
			expect(() => assertBatchSequenceAuthority({ seq: false }, solo)).not.toThrow();
		}
	});

	// The rule is a property of the SURFACE, not of the payload: one options
	// object cannot carry one-seq-per-entry (that form lives on the entries),
	// so a numeric OPTIONS seq is refused before the entries are even looked
	// at. Otherwise the contract would depend on the runtime length of an
	// array - a call that works while a tick produces one update starts
	// throwing the day it produces two, and an empty batch would silently
	// accept options a full one rejects.
	it('does not let the entry count decide whether the contract holds', () => {
		expect(() => assertBatchSequenceAuthority({ seq: 7, relay: false })).toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: 1, relay: false })).toThrow(BATCH_SEQUENCE_ERROR);
		// The signature carries no count at all, so no caller can reintroduce one.
		// EXACTLY one: `data` has a default and so is not counted, leaving
		// `options` as the only positional parameter. `<= 2` was the same
		// assertion with one parameter of slack - precisely the count slot it
		// claimed to exclude - so the bounced `(options, count, data = workerData)`
		// passed it at length 2 and the pin proved nothing.
		expect(assertBatchSequenceAuthority.length).toBe(1);
	});

	// An entry carrying an explicit seq is the per-entry twin of
	// publishWire({ seq: N }) and takes the same clustered rule: the external
	// allocator must also be the fan-out, and relay: false is the observable
	// proof the built-in multi-origin relay is off. Off-cluster the entry form
	// is unconditionally welcome - the counter and an external authority
	// cannot interleave across workers when there is only one.
	it('admits clustered per-entry authority only with the relay renounced', () => {
		for (const solo of [null, { totalWorkers: 1 }]) {
			for (const options of [undefined, {}, { seq: false }, { relay: true }]) {
				expect(() => assertBatchEntrySequenceAuthority(options, solo)).not.toThrow();
			}
		}
		for (const accepted of [{ relay: false }, { seq: false, relay: false }]) {
			expect(() => assertBatchEntrySequenceAuthority(accepted, cluster), JSON.stringify(accepted)).not.toThrow();
		}
		for (const rejected of [undefined, {}, { seq: false }, { relay: true }]) {
			expect(() => assertBatchEntrySequenceAuthority(rejected, cluster), JSON.stringify(rejected))
				.toThrow(BATCH_ENTRY_SEQUENCE_ERROR);
		}
	});

	// The hot lanes judge captured VALUES while colder callers judge the options
	// OBJECT. The object form delegates to the values form, and this matrix is
	// the proof the two spellings cannot drift: every (seq, relay) shape answers
	// identically through both, in both topologies.
	it('the values form and the options form agree on every shape', () => {
		const shapes = [
			[undefined, undefined], [false, undefined], [true, undefined],
			[7, undefined], [7, false], [7, true], [0, false], [-1, false],
			[1.5, false], [false, false], [Number.NaN, false]
		];
		for (const data of [null, { totalWorkers: 1 }, cluster]) {
			for (const [seq, relay] of shapes) {
				expect(clusterSequenceValuesAccepted(seq, relay, data), `${String(seq)}/${String(relay)}`)
					.toBe(clusterSequenceAccepted({ seq, relay }, data));
			}
			expect(clusterSequenceValuesAccepted(undefined, undefined, data))
				.toBe(clusterSequenceAccepted(undefined, data));
			expect(() => assertClusterSequenceAuthorityValues(7, undefined, cluster))
				.toThrow(CLUSTER_SEQUENCE_ERROR);
		}
	});

	it('the stampSeq value form and options form agree on every shape', () => {
		for (const seq of [undefined, false, true, 3, 'x']) {
			const a = new Map();
			const b = new Map();
			const call = (fn) => { try { return { value: fn() }; } catch (error) { return { threw: error.constructor.name }; } };
			const viaOptions = call(() => stampSeq(seq === undefined ? undefined : { seq }, a, 't'));
			const viaValue = call(() => stampSeqValue(seq, b, 't'));
			expect(viaValue, String(seq)).toEqual(viaOptions);
			expect([...b.entries()]).toEqual([...a.entries()]);
		}
	});

	it('guards every production sequence-stamping entry point before mutation', () => {
		const indexSource = readFileSync(new URL('../src/runtime/index.js', import.meta.url), 'utf8');
		const source = readFileSync(new URL('../src/runtime/handler/platform.js', import.meta.url), 'utf8');
		expect(indexSource).toContain('totalWorkers: num');
		const publish = source.slice(source.indexOf('\tpublish('), source.indexOf('\n\t/**\n\t * Send a message'));
		const wire = source.slice(source.indexOf('\tpublishWire('), source.indexOf('\n\t/**\n\t * Register a plugin', source.indexOf('\tpublishWire(')));
		const wireBatch = source.slice(source.indexOf('\tpublishWireBatch('), source.indexOf('\n\t/**\n\t * Multi-entry single-target', source.indexOf('\tpublishWireBatch(')));
		const loopBatch = source.slice(source.indexOf('\tbatch(messages)'), source.indexOf('\n\t/**\n\t * Wire-batching implementation', source.indexOf('\tbatch(messages)')));
		const batch = source.slice(source.indexOf('\tpublishBatched('), source.indexOf('\n\t/**', source.indexOf('\tpublishBatched(') + 20));
		// The single lanes follow the one-read rule the batch pioneered: every
		// option field is read into a local BEFORE the authority check, and the
		// check judges the locals - so a stateful accessor cannot answer the
		// refusal with one value and hand the stamp another. The pins below
		// require the values-form assert AND exactly one read site per field
		// (the capture line itself) in each lane body.
		expect(publish).toContain('assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		expect(publish.indexOf('options.seq'), 'publish must capture before judging')
			.toBeLessThan(publish.indexOf('assertClusterSequenceAuthorityValues('));
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.jitterMs']) {
			expect(publish.split(field).length, `publish reads ${field} exactly once`).toBe(2);
		}
		expect(wire).toContain('if (!isRelay) assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		// The wire slice runs on into the batch surfaces; the one-read counts
		// must cover exactly the publishWire body, which ends at the next JSDoc.
		const wireBody = wire.slice(0, wire.indexOf('\n\t/**'));
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.excludeWs', 'options._relaySeq']) {
			expect(wireBody.split(field).length, `publishWire reads ${field} exactly once`).toBe(2);
		}
		// The batch asserts on its OWN copy of the options, not on the caller's
		// live object - a caller that mutated it after the check would otherwise
		// stamp under an authority nobody validated. The guard runs before ANY
		// mutation and before the entries are even inspected, so an empty batch
		// cannot accept options a full one refuses.
		expect(wireBatch).toContain('assertBatchSequenceAuthority(opts);');
		const beforeAssert = wireBatch.slice(0, wireBatch.indexOf('assertBatchSequenceAuthority('));
		// Field reads, not a spread: the copy the assert vets and the copy the
		// stamping reads must be the same one read of the caller's object, and
		// a spread would let an inherited or accessor-carried numeric seq
		// vanish from the copy and slip the refusal.
		expect(beforeAssert).toContain(': { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs };');
		expect(beforeAssert, 'the batch inspects entries or fans out before its authority check')
			.not.toMatch(/stampSeq|app\.publish|captureResumeFrame|maxSeenSeq\.set|entries\.length|Array\.isArray/);
		// The per-entry authority check runs inside the batch too - in BOTH
		// branches (the stateless reroute pre-reads and the stateful snapshot
		// pass), before anything is stamped or fanned out: the last call site
		// precedes the first counter stamp and the first per-entry publish.
		expect(wireBatch.split('assertBatchEntrySequenceAuthority(opts)').length, 'both batch branches vet per-entry authority')
			.toBe(3);
		// Source order: the stateless branch's check (first occurrence) sits in
		// its pre-read loop, before the first per-entry publish; the stateful
		// branch's (last occurrence) sits in the snapshot pass, before the
		// first counter stamp.
		expect(wireBatch.indexOf('assertBatchEntrySequenceAuthority(opts)'),
			'the stateless reroute must vet per-entry authority before it publishes')
			.toBeLessThan(wireBatch.indexOf('this.publishWire('));
		expect(wireBatch.lastIndexOf('assertBatchEntrySequenceAuthority(opts)'),
			'the stateful branch must vet per-entry authority before it stamps')
			.toBeLessThan(wireBatch.indexOf('stampSeqValue(opts'));
		expect(wireBatch).toContain('throwInvalidSeq(');
		// batch() snapshots each message's option fields once and judges the
		// snapshot, then hands publish() the SAME snapshot - so the atomic
		// pre-pass and the per-message stamp cannot disagree.
		expect(loopBatch).toContain(': { seq: o.seq, relay: o.relay, compress: o.compress, jitterMs: o.jitterMs };');
		expect(loopBatch).toContain('assertClusterSequenceAuthority(snap);');
		expect(loopBatch.indexOf('assertClusterSequenceAuthority(snap);'),
			'batch must vet every snapshot before the first publish')
			.toBeLessThan(loopBatch.indexOf('platform.publish('));
		expect(loopBatch).toContain('platform.publish(topic, event, data, snapshots[i])');
		// publishBatched captures per-message seq/relay/jitter into arrays in
		// its atomic pre-pass; the stamp, the monotone-max branch, and the
		// relay filter all consume the captured values.
		expect(batch).toContain('assertClusterSequenceAuthorityValues(seqOption, relayOption);');
		expect(batch).toContain('stampSeqValue(msgSeqs[i]');
		expect(batch).toContain('typeof msgSeqs[i] === \'number\'');
		expect(batch).toContain('msgRelays[i] !== false');
		expect(batch.split('messages[i].options').length, 'publishBatched reads each message options object in the pre-pass only')
			.toBe(2);
	});
});
