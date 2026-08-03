import { describe, expect, it } from 'vitest';
import {
	buildDivergenceDiagnostic,
	createDivergenceDiagnosticStore,
	divergenceStreamId,
	summarizeTopicSequences
} from '../src/runtime/divergence-diagnostics.js';

const key = (byte) => new Uint8Array(32).fill(byte);

describe('state-divergence cold-path diagnostics', () => {
	it('uses stable process-keyed identifiers without retaining the raw topic', () => {
		const topic = 'private:tenant-42:room-7';
		const first = divergenceStreamId(key(1), topic);
		expect(first).toMatch(/^h1:[A-Za-z0-9_-]{22}$/);
		expect(first).not.toContain('tenant');
		expect(divergenceStreamId(key(1), topic)).toBe(first);
		expect(divergenceStreamId(key(2), topic)).not.toBe(first);
	});

	it('collects a deterministic bounded sequence subset', () => {
		const seen = new Map();
		for (let index = 0; index < 100; index++) seen.set('topic:' + index, index);
		const a = summarizeTopicSequences(seen, key(3), 5);
		const b = summarizeTopicSequences(new Map([...seen].reverse()), key(3), 5);
		expect(a).toEqual(b);
		expect(a.totalStreams).toBe(100);
		expect(a.streams).toHaveLength(5);
		expect(a.truncated).toBe(true);
		expect(JSON.stringify(a)).not.toContain('topic:');
	});

	it('identifies a tail sequence gap and its lower bound', () => {
		const streamId = divergenceStreamId(key(4), 'room');
		const diagnostic = buildDivergenceDiagnostic({
			diagnosticId: 'diag-1',
			epoch: 9,
			observedAt: 123,
			expectedThreadIds: [1, 2, 3],
			minorityThreadIds: [2],
			reports: [
				{ threadId: 1, summary: { streams: [{ streamId, sequence: 12 }], totalStreams: 1, truncated: false } },
				{ threadId: 2, summary: { streams: [{ streamId, sequence: 10 }], totalStreams: 1, truncated: false } },
				{ threadId: 3, summary: { streams: [{ streamId, sequence: 12 }], totalStreams: 1, truncated: false } }
			]
		});
		expect(diagnostic.complete).toBe(true);
		expect(diagnostic.explainedBySequenceSummary).toBe(true);
		expect(diagnostic.affectedStreams).toEqual([{
			streamId,
			classification: 'tail-sequence-gap',
			gapLowerBound: 2,
			workers: [
				{ threadId: 1, role: 'majority', sequence: 12 },
				{ threadId: 2, role: 'minority', sequence: 10 },
				{ threadId: 3, role: 'majority', sequence: 12 }
			]
		}]);
	});

	it('does not over-claim frame loss from missing or incomplete evidence', () => {
		const streamId = divergenceStreamId(key(5), 'room');
		const diagnostic = buildDivergenceDiagnostic({
			diagnosticId: 'diag-2',
			epoch: 10,
			observedAt: 456,
			expectedThreadIds: [1, 2, 3],
			minorityThreadIds: [2],
			reports: [
				{ threadId: 1, summary: { streams: [{ streamId, sequence: 12 }], totalStreams: 1, truncated: false } },
				{ threadId: 2, summary: { streams: [], totalStreams: 0, truncated: false } }
			]
		});
		expect(diagnostic.complete).toBe(false);
		expect(diagnostic.explainedBySequenceSummary).toBe(false);
		expect(diagnostic.affectedStreams[0].classification).toBe('stream-presence-mismatch');
		expect(diagnostic.affectedStreams[0].gapLowerBound).toBeNull();
	});

	it('retains only a bounded cloned history and lists metadata only', () => {
		const store = createDivergenceDiagnosticStore(2);
		const record = (id) => ({
			diagnosticId: id,
			kind: 'state-divergence',
			observedAt: 1,
			complete: true,
			evidenceTruncated: false,
			affectedStreams: [{ streamId: divergenceStreamId(key(6), id) }]
		});
		store.set(record('a'));
		store.set(record('b'));
		store.set(record('c'));
		expect(store.size).toBe(2);
		expect(store.get('a')).toBeNull();
		const copy = store.get('c');
		copy.affectedStreams.length = 0;
		expect(store.get('c').affectedStreams).toHaveLength(1);
		expect(store.list()).toEqual([
			{ diagnosticId: 'c', kind: 'state-divergence', observedAt: 1, complete: true, affectedStreamCount: 1, evidenceTruncated: false },
			{ diagnosticId: 'b', kind: 'state-divergence', observedAt: 1, complete: true, affectedStreamCount: 1, evidenceTruncated: false }
		]);
	});
});
