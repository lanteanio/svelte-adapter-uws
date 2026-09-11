import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLineIndex, expectStatement, expectStatementBlockCount, expectStatementCount } from './helpers/source-pins.js';
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
		// The gate speaks stampSeq's table, spelling for spelling: null is the
		// second no-seq form and a bigint the second authority form. A spelling
		// the stamp accepts and this gate refuses would make the documented
		// forms cluster-illegal with no topology caveat anywhere.
		for (const accepted of [
			{ seq: false },
			{ seq: false, relay: false },
			{ seq: null },
			{ seq: null, relay: true },
			{ seq: 41, relay: false },
			{ seq: 1, relay: false },
			{ seq: 41n, relay: false },
			{ seq: 1n, relay: false }
		]) expect(clusterSequenceAccepted(accepted, cluster), String(accepted.seq) + '/' + String(accepted.relay)).toBe(true);

		for (const rejected of [
			undefined, {}, { relay: false }, { seq: true }, { seq: 41 }, { seq: 41, relay: true },
			{ seq: 0, relay: false }, { seq: -1, relay: false }, { seq: 1.5, relay: false },
			{ seq: Number.NaN, relay: false }, { seq: Number.POSITIVE_INFINITY, relay: false },
			{ seq: 41n }, { seq: 41n, relay: true }, { seq: 0n, relay: false }, { seq: -1n, relay: false },
			{ seq: true, relay: false }
		]) {
			expect(clusterSequenceAccepted(rejected, cluster), String(rejected && rejected.seq) + '/' + String(rejected && rejected.relay)).toBe(false);
			expect(() => assertClusterSequenceAuthority(rejected, cluster)).toThrow(CLUSTER_SEQUENCE_ERROR);
		}
	});

	it('leaves an uncarryable bigint to the stamp, so the caller reads the magnitude message', () => {
		// The gate asks a topology question and the stamp asks a value
		// question. An offset past the range the wire carries faithfully
		// satisfies the first and fails the second, and the order decides which
		// message the caller sees: with the relay renounced the topology is
		// satisfied, so the refusal must come from the stamp and must name the
		// magnitude, not relay settings and worker counters.
		const uncarryable = 1541815603606036481n;
		expect(clusterSequenceAccepted({ seq: uncarryable, relay: false }, cluster)).toBe(true);
		expect(() => stampSeq({ seq: uncarryable }, new Map(), 'room')).toThrow(/exceeds the wire/i);
		expect(() => stampSeq({ seq: uncarryable }, new Map(), 'room')).not.toThrow(/relay|worker/i);
		// With the relay left on, the topology is wrong too and is refused
		// first - a caller who fixes only the magnitude would still be wrong.
		expect(() => assertClusterSequenceAuthority({ seq: uncarryable, relay: true }, cluster))
			.toThrow(CLUSTER_SEQUENCE_ERROR);
	});

	it('rejects a numeric authority on the batch surface whatever it is publishing', () => {
		expect(() => assertBatchSequenceAuthority({ seq: 7, relay: false }, cluster))
			.toThrow(BATCH_SEQUENCE_ERROR);
		// The bigint spelling of the same category error: one options value
		// cannot be one-seq-per-entry in either spelling.
		expect(() => assertBatchSequenceAuthority({ seq: 7n, relay: false }, cluster))
			.toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: 7n }, { totalWorkers: 1 }))
			.toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertBatchSequenceAuthority({ seq: false }, cluster)).not.toThrow();
		expect(() => assertBatchSequenceAuthority({ seq: null }, cluster)).not.toThrow();
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

	// The gate also answers the VALUE question the batch would otherwise reach
	// only in its stamping loop - which runs after the batch has taken its
	// egress decision, and never at all for an empty call. Numeric keeps its own
	// refusal: a number IS stampable, and what it has to earn is the message
	// naming the per-entry spelling that replaces it.
	it('refuses an options seq the stamp could not take, whatever the entries are', () => {
		for (const bad of ['7', '', {}, [], () => 1, Symbol.iterator, Number.NaN]) {
			expect(() => assertBatchSequenceAuthority({ seq: bad }), `seq ${String(bad)}`)
				.toThrow(TypeError);
		}
		expect(() => assertBatchSequenceAuthority({ seq: '7' })).toThrow(/publish seq must be/);
		expect(() => assertBatchSequenceAuthority({ seq: Number.NaN })).toThrow(BATCH_SEQUENCE_ERROR);
		// And still takes every spelling the batch supports, or the refusals
		// above would be satisfied by a gate that threw on everything.
		for (const ok of [undefined, true, false, null]) {
			expect(() => assertBatchSequenceAuthority({ seq: ok }), `seq ${String(ok)}`).not.toThrow();
		}
		expect(() => assertBatchSequenceAuthority(undefined)).not.toThrow();
		expect(() => assertBatchSequenceAuthority(null)).not.toThrow();
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
		// LINE ENDINGS NORMALIZED ON READ. Every lane below is carved out with an
		// anchor that spans a line break (`\n\t/**\n\t * ...`), and on a CRLF
		// working tree not one of them matches: `indexOf` returns -1, `slice`
		// reads that as "one before the end", and the `publish` slice grows from
		// about 6k characters to the whole 134k file. The pins then answer about
		// a body they do not name - `options.seq` goes from one occurrence to
		// eight - so the case fails, or worse passes, for a reason unrelated to
		// the rule it states. `.gitattributes` normalizes the tree, which is why
		// this has never been seen; a single file flipped by a checkout is
		// enough to reintroduce it.
		const read = (relative) =>
			readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
		const indexSource = read('../src/runtime/index.js');
		const source = read('../src/runtime/handler/platform.js');
		expect(indexSource).toContain('totalWorkers: num');
		// Each carve-out asserts its own anchor was FOUND before it is used.
		// Normalizing removes today's cause; this removes the failure MODE, so a
		// renamed JSDoc heading or a reordered method is named here instead of
		// silently widening a slice until the pins stop meaning anything.
		// The closing anchor is searched FROM the opening one, which is what the
		// per-lane offsets in the previous shape were doing by hand.
		const carve = (label, from, to) => {
			const start = source.indexOf(from);
			expect(start, `${label}: opening anchor ${JSON.stringify(from)} not found`).toBeGreaterThan(-1);
			const end = source.indexOf(to, start);
			expect(end, `${label}: closing anchor ${JSON.stringify(to)} not found after it`).toBeGreaterThan(start);
			return source.slice(start, end);
		};
		const publish = carve('publish', '\tpublish(', '\n\t/**\n\t * Send a message');
		const wire = carve('publishWire', '\tpublishWire(', '\n\t/**\n\t * Multi-entry fan-out');
		const wireBatch = carve('publishWireBatch', '\tpublishWireBatch(', '\n\t/**\n\t * Register a plugin');
		const loopBatch = carve('batch', '\tbatch(messages)', '\n\t/**\n\t * Wire-batching implementation');
		const batch = carve('publishBatched', '\tpublishBatched(', '\n\t/**');
		// The single lanes follow the one-read rule the batch pioneered: every
		// option field is read into a local BEFORE the authority check, and the
		// check judges the locals - so a stateful accessor cannot answer the
		// refusal with one value and hand the stamp another. The pins below
		// require the values-form assert AND exactly one read site per field
		// (the capture line itself) in each lane body.
		expectStatement(publish, 'assertClusterSequenceAuthorityValues(seqOption, relayOption);', 'publish vets cluster sequence authority');
		expect(publish.indexOf('options.seq'), 'publish must capture before judging')
			.toBeLessThan(publish.indexOf('assertClusterSequenceAuthorityValues('));
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.jitterMs']) {
			expect(publish.split(field).length, `publish reads ${field} exactly once`).toBe(2);
		}
		// The VALUE question is asked ahead of the ceiling, not left to the
		// stamp. Stamping is the last step on this lane, so a seq the wire
		// cannot carry used to be answered with the shed's own `false` while a
		// budget was armed and threw only after load dropped.
		expectStatement(publish, 'assertStampableSeq(seqOption);', 'publish vets the seq value');
		expect(publish.indexOf('assertStampableSeq('), 'publish must refuse the value before it admits')
			.toBeLessThan(publish.indexOf('admitPublishEgress('));
		expectStatement(wire, 'if (!isRelay) assertClusterSequenceAuthorityValues(seqOption, relayOption);', 'publishWire vets cluster sequence authority origin-side');
		// The wire slice runs on into the batch surfaces; the one-read counts
		// must cover exactly the publishWire body, which ends at the next JSDoc.
		const wireBody = wire.slice(0, wire.indexOf('\n\t/**'));
		for (const field of ['options.seq', 'options.relay', 'options.compress', 'options.excludeWs']) {
			expect(wireBody.split(field).length, `publishWire reads ${field} exactly once`).toBe(2);
		}
		// The relay marker is NOT among them: it is an argument compared by
		// identity, so the lane reads no relay key off the caller's object at
		// all. A marker read as a property is satisfied by anything that
		// answers every key, without naming the key.
		expectStatement(wireBody, 'const isRelay = relayToken === RELAY_RECEIVE;', 'publishWire decides relay by identity');
		expect(wireBody, 'the relay marker went back to being a key on the options object')
			.not.toMatch(/options\s*\[\s*RELAY/);
		// Same ordering on the wire lane, and origin-side only: a relayed frame
		// carries its number beside the token instead, already validated where
		// it was published.
		expectStatement(wireBody, 'if (!isRelay) assertStampableSeq(seqOption);', 'publishWire vets the seq value origin-side');
		expect(wireBody.indexOf('assertStampableSeq('), 'publishWire must refuse the value before it admits')
			.toBeLessThan(wireBody.indexOf('admitPublishEgress('));
		// The batch asserts on its OWN copy of the options, not on the caller's
		// live object - a caller that mutated it after the check would otherwise
		// stamp under an authority nobody validated. The guard runs before ANY
		// mutation and before the entries are even inspected, so an empty batch
		// cannot accept options a full one refuses.
		expectStatement(wireBatch, 'assertBatchSequenceAuthority(opts);', 'publishWireBatch vets its own options copy');
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
		// pass), before anything is stamped or fanned out.
		//
		// Pinned as the BLOCK it belongs to rather than as a line with a count
		// beside it, and located in the same blanked view that counts it. Two
		// reasons, both learned from mutations that passed the pins this
		// replaces. A count in one view with `indexOf` order in another is two
		// questions: neutralized text is gone from the count and still there
		// for `indexOf`, so commenting out one call and duplicating the live
		// one satisfied both. And a call is only a guard where it STANDS - the
		// block carries the resolve that feeds it and the latch that fires it
		// once, so lifting the check out of the branch, or up into the egress
		// gate below the loop, changes these lines even though the call is
		// untouched.
		// The block spans both arms of the resolve, so it carries BOTH refusals
		// and the latch that fires the first once: the authority check in the
		// numeric arm, the counter refusal in the `true` arm. Comment lines
		// between them are skipped, so the pin survives an edit to the prose and
		// not to the code. It stops at the arm's close rather than running to
		// the end of the resolve, because the bookkeeping after it carries
		// nothing this pin is about and a pin fails on every rename it spans.
		//
		// These pins are the SECOND line of defence. What the per-entry refusal
		// actually runs is pinned behaviourally in
		// test/cluster-sequence-policy-real.test.js, against a real two-worker
		// runtime, because the refusal returns early off-cluster and no
		// in-process case can reach it.
		const entrySeqPrePass = [
			'const resolved = resolveEntrySeq(entry.seq, i);',
			'if (resolved !== undefined) {',
			'if (typeof resolved === \'number\') {',
			'if (!sawExplicitEntrySeq) {',
			'assertBatchEntrySequenceAuthority(opts);',
			'sawExplicitEntrySeq = true;',
			'}',
			'} else if (resolved === true) {',
			'assertClusterSequenceAuthorityValues(true, opts != null ? opts.relay : undefined);',
			'}'
		];
		const prePasses = expectStatementBlockCount(wireBatch, entrySeqPrePass, 2,
			'both batch branches vet per-entry authority and the entry counter draw, each in its own resolve arm');
		// The latch the numeric arm reads has to START false in both branches.
		// Flipping one initialiser leaves every line above byte-identical and
		// stops the authority check ever running on that lane.
		expectStatementCount(wireBatch, 'let sawExplicitEntrySeq = false;', 2,
			'each branch arms its own explicit-seq latch');
		// And each pre-pass has to be the body of a loop over every entry. A
		// loop bound to nothing (`i < 0`) leaves the check present and unrun,
		// and the three lines that open both loops are what say otherwise.
		const loopOpens = expectStatementBlockCount(wireBatch, [
			'for (let i = 0; i < count; i++) {',
			'const entry = entries[i];',
			'datas[i] = entry.data;'
		], 2, 'each branch walks every entry in its pre-pass');
		// One per BRANCH rather than two in the same loop. The stateless branch
		// publishes at `this.publishWire(`, so a pre-pass before that line is
		// that branch's and one after it is the stateful snapshot pass. Both
		// sides are read as line indexes of the qualifying blocks, so a
		// duplicate of the live branch cannot stand in for the dead one.
		const publishAt = codeLineIndex(wireBatch, 'this.publishWire(');
		const stampAt = codeLineIndex(wireBatch, 'stampSeqValue(opts');
		expect(publishAt, 'the stateless reroute must still publish through publishWire').toBeGreaterThan(-1);
		expect(stampAt, 'the stateful branch must still stamp through stampSeqValue').toBeGreaterThan(-1);
		expect(prePasses[0], 'the stateless reroute must vet per-entry authority before it publishes')
			.toBeLessThan(publishAt);
		expect(prePasses[1], 'the second pre-pass must be the stateful branch, not a repeat in the stateless loop')
			.toBeGreaterThan(publishAt);
		// And BEFORE the stamping loop, which is the half a per-branch count
		// cannot say: a pre-pass moved below the stamp still reads as one per
		// branch while refusing an entry whose seq is already on the wire.
		expect(prePasses[1], 'the stateful pre-pass must refuse before anything is stamped')
			.toBeLessThan(stampAt);
		// Each pre-pass inside its OWN loop, and the second one on the stateful
		// side of the branch. Position alone cannot say which branch a copy
		// belongs to - two copies in the stateless branch, one either side of
		// its publish, satisfy every bound above - so the stateful branch's own
		// exclusion state is the landmark between them.
		const statefulAt = codeLineIndex(wireBatch, 'let anyExclude = false;');
		expect(statefulAt, 'the stateful branch must still gather its exclusions').toBeGreaterThan(publishAt);
		expect(prePasses[0], 'the stateless pre-pass runs inside the stateless loop').toBeGreaterThan(loopOpens[0]);
		expect(prePasses[0], 'and stays on the stateless side of the branch').toBeLessThan(statefulAt);
		expect(prePasses[1], 'the stateful pre-pass runs inside the stateful loop').toBeGreaterThan(loopOpens[1]);
		expect(loopOpens[1], 'which is itself on the stateful side of the branch').toBeGreaterThan(statefulAt);
		// The entry-level counter draw is inside the block above, in the
		// `resolved === true` arm, so its place is pinned by the block rather
		// than by a distance: a clustered batch refuses { seq: true } on an
		// entry up front instead of diverging silently on the stateful lane or
		// half-delivering on the stateless one. The values form with `true` is
		// refused for every relay shape in the table above.
		// batch() snapshots each message's option fields once and judges the
		// snapshot, then hands publish() the SAME snapshot - so the atomic
		// pre-pass and the per-message stamp cannot disagree.
		expect(loopBatch).toContain(': { seq: o.seq, relay: o.relay, compress: o.compress, jitterMs: o.jitterMs };');
		expectStatement(loopBatch, 'assertClusterSequenceAuthority(snap);', 'batch vets every snapshot');
		expect(loopBatch.indexOf('assertClusterSequenceAuthority(snap);'),
			'batch must vet every snapshot before the first publish')
			.toBeLessThan(loopBatch.indexOf('platform.publish('));
		expect(loopBatch).toContain('platform.publish(topic, event, data, snapshots[i])');
		// The topology check above short-circuits on a single worker without
		// reading the value, so the pre-pass has to ask the value question
		// itself or the all-or-nothing promise holds only in a cluster.
		expectStatement(loopBatch, 'assertStampableSeq(snap?.seq);', 'batch asks the value question itself');
		expect(loopBatch.indexOf('assertStampableSeq('), 'batch must vet every value before the first publish')
			.toBeLessThan(loopBatch.indexOf('platform.publish('));
		// publishBatched captures per-message seq/relay/jitter into arrays in
		// its atomic pre-pass; the stamp, the monotone-max branch, and the
		// relay filter all consume the captured values.
		expectStatement(batch, 'assertClusterSequenceAuthorityValues(seqOption, relayOption);', 'publishBatched vets cluster sequence authority');
		expectStatement(batch, 'const seq = stampSeqValue(msgSeqs[i], topicSeqs, m.topic, seqBound);', 'publishBatched stamps from the captured value');
		// Same reason as batch(), and here the stamping loop is what would
		// otherwise surface a bad value - after earlier entries have advanced
		// the topic counter for a frame the call never sends.
		expectStatement(batch, 'assertStampableSeq(seqOption);', 'publishBatched vets every value before it stamps');
		expect(batch.indexOf('assertStampableSeq('), 'publishBatched must vet every value before it stamps')
			.toBeLessThan(batch.indexOf('stampSeqValue(msgSeqs[i]'));
		expect(batch).toContain('typeof msgSeqs[i] === \'number\'');
		expect(batch).toContain('msgRelays[i] !== false');
		expect(batch.split('messages[i].options').length, 'publishBatched reads each message options object in the pre-pass only')
			.toBe(2);
	});
});
