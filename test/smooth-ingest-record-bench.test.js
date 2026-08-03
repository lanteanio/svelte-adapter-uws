import { describe, expect, it } from 'vitest';
import {
	consumeCurrentSmoothPayload,
	consumeFixedSmoothAccessor,
	consumeFlatIntSmoothPayload,
	makeSmoothIngestCorpus,
	runSmoothIngestDecisionBench,
	smoothIngestDecision
} from '../bench/36-smooth-ingest-record-ab.mjs';

describe('smooth ingest record decision bench', () => {
	it('feeds equivalent commands through all three representations', () => {
		const corpus = makeSmoothIngestCorpus(8);
		const expected = consumeCurrentSmoothPayload(corpus.current);

		expect(consumeFlatIntSmoothPayload(corpus.flat)).toBe(expected);
		expect(consumeFixedSmoothAccessor(corpus.fixed)).toBe(expected);
	});

	it('rejects a fixed record whose declared length does not match', () => {
		const { fixed } = makeSmoothIngestCorpus(2);

		expect(() => consumeFixedSmoothAccessor(fixed.subarray(0, -1)))
			.toThrow('fixed smooth payload length mismatch');
	});

	it('uses the declared seventy-percent gap-closure gate', () => {
		expect(smoothIngestDecision(100, 20, 44)).toMatchObject({
			gapClosure: 0.7,
			decision: 'record-diet'
		});
		expect(smoothIngestDecision(100, 20, 45)).toMatchObject({
			gapClosure: 0.6875,
			decision: 'standalone-accessor'
		});
	});

	it('reports finite medians and encoded sizes without asserting wall-clock policy', () => {
		const result = runSmoothIngestDecisionBench({
			counts: [8],
			iterations: 2,
			samples: 3
		});
		const [row] = result.rows;

		expect(result).toMatchObject({ iterations: 2, samples: 3, threshold: 0.7 });
		expect(row.count).toBe(8);
		expect(row.bytes.current).toBeGreaterThan(row.bytes.flatInt);
		expect(row.bytes.accessor).toBeGreaterThan(0);
		expect(Object.values(row.nsPerCommand).every(Number.isFinite)).toBe(true);
		expect(['record-diet', 'standalone-accessor']).toContain(row.decision);
	});
});
