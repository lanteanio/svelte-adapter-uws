// The worker pressure fold's per-connection input, driven over real sockets.
//
// counters.leaseSaturationPeak is the per-connection half of the pressure
// scalar: the worst send-gate reading since the last 1 Hz sample, folded
// worst-of into platform.pressure.value and halved after each sample. The
// server never consumes a permit from its mirror of the gate, so the only
// truthful producer is the client's own report - the optional `queued` field
// on `request-n`. These tests drive the REAL built runtime over a real ws
// client and read the fold input off the same module instance the server
// samples, pinning all three claims: an old client (no field) leaves the peak
// untouched, a reported backlog raises it by the reported fraction of the
// reference queue bound, and a hostile or malformed claim is clamped without
// disturbing the grant path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient, REAL_BOOT_BUDGET_MS } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeUWS('request-n reported backlog over the real runtime', () => {
	let server = null;
	let state = null;
	let client = null;

	beforeAll(async () => {
		state = await import('./fixture/build/handler/state.js');
		server = await startRealRuntime();
		client = await connectRealClient(server.wsUrl);
		client.send({ type: 'hello', caps: ['lease'] });
		const ok = await client.waitFor((p) => p?.type === 'lease-ok', 5000);
		expect(ok, 'the server never honoured the lease cap').not.toBe(null);
		const grant = await client.waitFor((p) => p?.type === 'lease', 5000);
		expect(grant, 'the hello grant never arrived').not.toBe(null);
	}, 400000);

	afterAll(async () => {
		client?.close();
		await server?.stop();
	});

	// Grant frames received so far. Counted, not waited-for by predicate: every
	// grant frame is identical, so a predicate wait would read an earlier grant
	// back (the waitFor helper scans the whole frame history by design).
	function grantCount() {
		let n = 0;
		for (const raw of client.frames) {
			try { if (JSON.parse(raw).type === 'lease') n++; } catch { /* not json */ }
		}
		return n;
	}

	// Send one replenish and wait for the fresh grant it must be answered with.
	async function replenish(frame) {
		const before = grantCount();
		client.send(frame);
		const deadline = Date.now() + 5000;
		while (grantCount() <= before) {
			if (Date.now() >= deadline) throw new Error('re-grant never arrived for ' + JSON.stringify(frame));
			await sleep(5);
		}
	}

	it('leaves the peak at zero for a replenish with no reported backlog', async () => {
		expect(state.counters.leaseSaturationPeak).toBe(0);
		await replenish({ type: 'request-n', n: 256 });
		// The fold input is written before the grant frame is sent, so once the
		// grant is here nothing is in flight - and decay cannot raise a zero.
		expect(state.counters.leaseSaturationPeak).toBe(0);
	}, REAL_BOOT_BUDGET_MS);

	it('folds a reported backlog into the worker peak by its fraction of the bound', async () => {
		// Poll from before the round trip completes: the peak is written before
		// the grant goes out, and the 1 Hz sampler halves it every tick, so the
		// first nonzero value seen is the written 128/256 - or that value once
		// halved on a machine loaded enough to slip a tick in between.
		const before = grantCount();
		client.send({ type: 'request-n', n: 256, queued: 128 });
		const deadline = Date.now() + 5000;
		let seen = 0;
		while (seen === 0 && Date.now() < deadline) {
			seen = state.counters.leaseSaturationPeak;
			if (seen === 0) await sleep(2);
		}
		expect([0.5, 0.25], 'first nonzero peak must be the reported 128/256, at most once-decayed').toContain(seen);
		// And the grant path answered normally.
		const grantDeadline = Date.now() + 5000;
		while (grantCount() <= before && Date.now() < grantDeadline) await sleep(5);
		expect(grantCount()).toBeGreaterThan(before);
	}, REAL_BOOT_BUDGET_MS);

	it('caps a hostile claim at 1 and still answers the grant', async () => {
		await replenish({ type: 'request-n', n: 256, queued: 999999999 });
		// Written as exactly 1 before the grant went out; at most one sampler
		// halving can land between the grant arriving and this read.
		expect([1, 0.5]).toContain(state.counters.leaseSaturationPeak);
	}, REAL_BOOT_BUDGET_MS);

	it('collapses a malformed claim to zero and still answers the grant', async () => {
		// Let the previous case's peak decay away first, so a stale nonzero
		// cannot be misread as this frame's contribution. The sampler halves
		// once a second; the wait budget covers the five halvings needed.
		const decayDeadline = Date.now() + 15000;
		while (state.counters.leaseSaturationPeak > 0.05 && Date.now() < decayDeadline) await sleep(50);
		const floor = state.counters.leaseSaturationPeak;
		expect(floor, 'the peak never decayed - is the sampler running?').toBeLessThanOrEqual(0.05);
		await replenish({ type: 'request-n', n: 256, queued: 'abc' });
		// A malformed claim contributes nothing: only decay may have moved it.
		expect(state.counters.leaseSaturationPeak).toBeLessThanOrEqual(floor);
	}, REAL_BOOT_BUDGET_MS);
});
