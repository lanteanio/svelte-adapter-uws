import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	BATCH_SEQUENCE_ERROR,
	CLUSTER_SEQUENCE_ERROR,
	assertClusterSequenceAuthority,
	assertClusterSequenceBatchAuthority,
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

	it('rejects one repeated numeric authority for a multi-entry wire batch', () => {
		expect(() => assertClusterSequenceBatchAuthority({ seq: 7, relay: false }, 2, cluster))
			.toThrow(BATCH_SEQUENCE_ERROR);
		expect(() => assertClusterSequenceBatchAuthority({ seq: 7, relay: false }, 1, cluster)).not.toThrow();
		expect(() => assertClusterSequenceBatchAuthority({ seq: false }, 20, cluster)).not.toThrow();
	});

	// The refusal used to be gated on hasMultipleWorkers, so the corruption it
	// exists to prevent was live on the DEFAULT single-worker deployment: stampSeq
	// returns a caller-supplied number verbatim and publishWireBatch calls it once
	// per entry, so every entry carried the same seq whatever the topology. Only
	// the clustered case was covered here, which is why it survived.
	it('rejects the repeated numeric authority off-cluster too, where the default deployment lives', () => {
		for (const solo of [null, { totalWorkers: 1 }, { totalWorkers: 1, ioWorkers: 1 }]) {
			expect(hasMultipleWorkers(solo), JSON.stringify(solo)).toBe(false);
			expect(
				() => assertClusterSequenceBatchAuthority({ seq: 7, relay: false }, 2, solo),
				JSON.stringify(solo)
			).toThrow(BATCH_SEQUENCE_ERROR);
			// A single entry is unambiguous and stays allowed off-cluster as well,
			// so this is a batch-arity rule and not a new ban on authoritative seqs.
			expect(() => assertClusterSequenceBatchAuthority({ seq: 7, relay: false }, 1, solo)).not.toThrow();
			expect(() => assertClusterSequenceBatchAuthority({ seq: false }, 20, solo)).not.toThrow();
		}
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
		// The batch asserts on its OWN copy of the options and its own pinned
		// count, not on the caller's live objects - a caller that mutated either
		// after the check would otherwise stamp under an authority nobody
		// validated. The guard still has to run before any mutation, which is
		// what the slice below pins.
		expect(wireBatch).toContain('assertClusterSequenceBatchAuthority(opts, count);');
		const beforeAssert = wireBatch.slice(0, wireBatch.indexOf('assertClusterSequenceBatchAuthority('));
		expect(beforeAssert).toContain('const opts = options == null ? options : { ...options };');
		expect(beforeAssert, 'the batch stamps or fans out before its authority check')
			.not.toMatch(/stampSeq|app\.publish|captureResumeFrame|maxSeenSeq\.set/);
		expect(loopBatch).toContain('assertClusterSequenceAuthority(messages[i].options);');
		expect(batch).toContain('assertClusterSequenceAuthority(messages[i].options);');
	});
});
