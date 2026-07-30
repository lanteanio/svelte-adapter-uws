// Coverage for the aggregate outbound-backpressure telemetry: the bounded
// per-connection walk-and-fold the 1 Hz pressure sampler uses to populate
// `pressureSnapshot.maxBufferedBytes` / `.backpressuredConnections`. The fold is
// extracted into a config-free pure helper so the hot-path-sensitive sample cap,
// the closed-connection-as-zero path, and the worst/count arithmetic are unit-
// testable with mock connections and no real socket or build-time config graph.

import { describe, it, expect, vi } from 'vitest';
import { foldConnectionBackpressure, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES } from '../src/runtime/utils/backpressure.js';

const T = BACKPRESSURE_SAMPLE_THRESHOLD_BYTES;
const CAP = BACKPRESSURE_SAMPLE_CAP;

/** A mock uWS connection exposing only what the walk touches. */
function conn(bufferedAmount) {
	return {
		getBufferedAmount: vi.fn(() => {
			if (typeof bufferedAmount === 'function') return bufferedAmount();
			return bufferedAmount;
		})
	};
}

describe('foldConnectionBackpressure', () => {
	it('reads zero over an empty connection set', () => {
		expect(foldConnectionBackpressure([], CAP, T)).toEqual({
			maxBufferedBytes: 0,
			backpressuredConnections: 0,
			sampled: 0
		});
	});

	it('reads zero when every connection is drained', () => {
		const conns = [conn(0), conn(0), conn(0)];
		expect(foldConnectionBackpressure(conns, CAP, T)).toEqual({
			maxBufferedBytes: 0,
			backpressuredConnections: 0,
			sampled: 3
		});
	});

	it('reports the worst queue and counts only connections over the threshold', () => {
		// 100000 and 70000 are over 64 KB; 50000 and 0 are under.
		const conns = [conn(0), conn(50000), conn(70000), conn(100000)];
		expect(foldConnectionBackpressure(conns, CAP, T)).toEqual({
			maxBufferedBytes: 100000,
			backpressuredConnections: 2,
			sampled: 4
		});
	});

	it('counts every connection when all are over the threshold', () => {
		const conns = [conn(70000), conn(80000), conn(90000)];
		expect(foldConnectionBackpressure(conns, CAP, T)).toEqual({
			maxBufferedBytes: 90000,
			backpressuredConnections: 3,
			sampled: 3
		});
	});

	it('treats the threshold as strict (a reading exactly at the threshold is not backpressured)', () => {
		expect(foldConnectionBackpressure([conn(T)], CAP, T)).toMatchObject({ maxBufferedBytes: T, backpressuredConnections: 0 });
		expect(foldConnectionBackpressure([conn(T + 1)], CAP, T)).toMatchObject({ maxBufferedBytes: T + 1, backpressuredConnections: 1 });
	});

	it('counts a connection that throws on read (closing mid-walk) as zero', () => {
		const closing = conn(() => { throw new Error('Invalid access of closed uWS.WebSocket'); });
		const conns = [closing, conn(200000)];
		expect(foldConnectionBackpressure(conns, CAP, T)).toEqual({
			maxBufferedBytes: 200000,
			backpressuredConnections: 1,
			sampled: 2
		});
	});

	it('bounds the walk at the sample cap and reads only the sampled prefix', () => {
		// The first CAP connections are drained; a single connection PAST the cap
		// holds a huge queue. A capped walk stops before it, so the read count, the
		// sampled count, and the reported max all prove the bound is honored.
		const conns = [];
		for (let i = 0; i < CAP; i++) conns.push(conn(1));
		const straggler = conn(5_000_000);
		conns.push(straggler);
		const result = foldConnectionBackpressure(conns, CAP, T);
		expect(result.sampled).toBe(CAP);
		expect(result.maxBufferedBytes).toBe(1); // the 5 MB straggler was never sampled
		expect(result.backpressuredConnections).toBe(0);
		expect(straggler.getBufferedAmount).not.toHaveBeenCalled();
		// Exactly CAP reads happened - not one more.
		const totalReads = conns.reduce((n, c) => n + c.getBufferedAmount.mock.calls.length, 0);
		expect(totalReads).toBe(CAP);
	});

	it('honors a smaller cap than the connection count', () => {
		const conns = [conn(10), conn(999999), conn(20)];
		// Cap of 1 reads only the first connection.
		const result = foldConnectionBackpressure(conns, 1, T);
		expect(result.sampled).toBe(1);
		expect(result.maxBufferedBytes).toBe(10);
		expect(conns[1].getBufferedAmount).not.toHaveBeenCalled();
	});

	it('pins the documented default threshold and cap', () => {
		expect(BACKPRESSURE_SAMPLE_THRESHOLD_BYTES).toBe(64 * 1024);
		expect(BACKPRESSURE_SAMPLE_CAP).toBe(1024);
	});
});
