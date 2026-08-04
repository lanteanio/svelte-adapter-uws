import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BATCH_SEQUENCE_ERROR,
	CLUSTER_SEQUENCE_ERROR,
	assertClusterSequenceAuthority,
	assertBatchSequenceAuthority,
	clusterSequenceAccepted,
	hasMultipleWorkers
} from '../src/runtime/handler/cluster-sequence-policy.js';

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

	// The rule is a property of the SURFACE, not of the payload: the batch takes
	// one options object and has no per-entry sequence, so a numeric seq is
	// refused before the entries are even looked at. Otherwise the contract would
	// depend on the runtime length of an array - a call that works while a tick
	// produces one update starts throwing the day it produces two, and an empty
	// batch would silently accept options a full one rejects.
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

	it('guards every production sequence-stamping entry point before mutation', () => {
		const indexSource = readFileSync(new URL('../src/runtime/index.js', import.meta.url), 'utf8');
		const source = readFileSync(new URL('../src/runtime/handler/platform.js', import.meta.url), 'utf8');
		expect(indexSource).toContain('totalWorkers: num');
		const publish = source.slice(source.indexOf('\tpublish('), source.indexOf('\n\t/**\n\t * Send a message'));
		const wire = source.slice(source.indexOf('\tpublishWire('), source.indexOf('\n\t/**\n\t * Send one wire', source.indexOf('\tpublishWire(')));
		const wireBatch = source.slice(source.indexOf('\tpublishWireBatch('), source.indexOf('\n\t/**\n\t * Multi-entry single-target', source.indexOf('\tpublishWireBatch(')));
		const loopBatch = source.slice(source.indexOf('\tbatch(messages)'), source.indexOf('\n\t/**\n\t * Publish a list', source.indexOf('\tbatch(messages)')));
		const batch = source.slice(source.indexOf('\tpublishBatched('), source.indexOf('\n\t/**', source.indexOf('\tpublishBatched(') + 20));
		expect(publish).toContain('assertClusterSequenceAuthority(options);');
		expect(wire).toContain('if (!isRelay) assertClusterSequenceAuthority(options);');
		// The batch asserts on its OWN copy of the options, not on the caller's
		// live object - a caller that mutated it after the check would otherwise
		// stamp under an authority nobody validated. The guard runs before ANY
		// mutation and before the entries are even inspected, so an empty batch
		// cannot accept options a full one refuses.
		expect(wireBatch).toContain('assertBatchSequenceAuthority(opts);');
		const beforeAssert = wireBatch.slice(0, wireBatch.indexOf('assertBatchSequenceAuthority('));
		expect(beforeAssert).toContain('const opts = options == null ? options : { ...options };');
		expect(beforeAssert, 'the batch inspects entries or fans out before its authority check')
			.not.toMatch(/stampSeq|app\.publish|captureResumeFrame|maxSeenSeq\.set|entries\.length|Array\.isArray/);
		expect(loopBatch).toContain('assertClusterSequenceAuthority(messages[i].options);');
		expect(batch).toContain('assertClusterSequenceAuthority(messages[i].options);');
	});
});
