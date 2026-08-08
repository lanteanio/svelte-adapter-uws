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
		// The 0.70 gate is the ADOPTED decision policy, recorded with the
		// verdict in source/shipped-log.md - the constant here restates that
		// record, it does not invent it.
		expect(smoothIngestDecision(100, 20, 44)).toMatchObject({
			gapClosure: 0.7,
			decision: 'record-diet'
		});
		expect(smoothIngestDecision(100, 20, 45)).toMatchObject({
			gapClosure: 0.6875,
			decision: 'standalone-accessor'
		});
	});

	it('never recommends the accessor when the measurement shows it buys nothing', () => {
		// The degenerate case the oracle once inverted: with no gap between
		// the current path and the accessor there is nothing for a standalone
		// accessor to win, so the verdict must be record-diet - recommending
		// the accessor precisely when the data refutes it was the one wrong
		// answer this function could give.
		expect(smoothIngestDecision(20, 20, 20)).toMatchObject({
			gapClosure: 1,
			decision: 'record-diet'
		});
		expect(smoothIngestDecision(20, 25, 30)).toMatchObject({
			gapClosure: 1,
			decision: 'record-diet'
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
