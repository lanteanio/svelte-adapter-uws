// The pressure snapshot presented un-sampled placeholders as readings.
//
// Every field is initialised to 0 and the sampler overwrites them on its first
// ~1 Hz fold, so between process start and that fold a consumer - introspect(),
// an onPressure listener, an ops dashboard reading the admin route - got a fully
// populated object of zeros with nothing in the shape marking it as unmeasured.
// `0` is a legitimate value for every field except rss, so the only way to be
// honest was to hard-code "rss can never be 0", which does not generalise.
//
// `sampledAt` is that missing signal: null until the first fold completes, the
// wall-clock stamp of the most recent one afterwards. These tests pin both ends
// on the real runtime, plus the two surfaces that never sample at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import uws from '../src/vite.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describe('surfaces that never sample say so permanently', () => {
	it('the Vite dev platform reports null, not a zero reading', () => {
		uws();
		const dev = globalThis.__uws_dev_platform;

		// Dev runs no sampler at all, so this is not a startup window that later
		// closes - the zeros below are placeholders for the process lifetime, and
		// sampledAt is what distinguishes them from a measured idle worker.
		expect(dev.pressure.sampledAt).toBe(null);
		expect(dev.pressure.memoryMB).toBe(0);
		expect(dev.introspect().pressure.sampledAt).toBe(null);
	});
});

describeUWS('createTestServer never samples either', () => {
	let server = null;

	afterAll(async () => {
		await server?.close();
	});

	it('reports null through both the getter and introspect', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		// The harness fabricates the snapshot (its own docs say it runs no
		// pressure sampler), so a test asserting on pressure NUMBERS here is
		// asserting on placeholders. This is the field that makes that visible
		// rather than leaving it to be rediscovered.
		expect(server.platform.pressure.sampledAt).toBe(null);
		expect(server.platform.introspect().pressure.sampledAt).toBe(null);
	});
});

describeUWS('the real runtime moves from placeholder to reading', () => {
	let server = null;
	let state = null;
	let platform = null;
	let sampledAtBeforeBoot;
	let memoryMBBeforeBoot;

	beforeAll(async () => {
		// Read the module's own initial state BEFORE booting: importing it does
		// not start the sampler, so this IS the window the defect lived in.
		state = await import('./fixture/build/handler/state.js');
		sampledAtBeforeBoot = state.pressureSnapshot.sampledAt;
		memoryMBBeforeBoot = state.pressureSnapshot.memoryMB;

		server = await startRealRuntime();
		({ platform } = await import('./fixture/build/handler/platform.js'));
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('starts null while the numbers already read as zero', () => {
		expect(sampledAtBeforeBoot, 'un-sampled snapshot claimed a sample time').toBe(null);
		// The other half of the defect: this zero was indistinguishable from a
		// reading, and no live Node process has an rss of 0.
		expect(memoryMBBeforeBoot).toBe(0);
	});

	it('carries the sampler stamp once a fold completes, and a real rss with it', async () => {
		const deadline = Date.now() + 15000;
		while (state.pressureSnapshot.sampledAt === null && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const sampledAt = state.pressureSnapshot.sampledAt;
		expect(sampledAt, 'the sampler never stamped the snapshot').not.toBe(null);
		expect(typeof sampledAt).toBe('number');
		// One stamp, not two clocks: the snapshot and the freshness gauge date
		// the same fold, so an operator comparing them can never see them differ.
		expect(sampledAt).toBe(state.counters.lastSampleWallMs);
		// What the field is FOR: after the stamp, the numbers are measurements.
		expect(state.pressureSnapshot.memoryMB).toBeGreaterThan(0);
		expect(platform.introspect().pressure.sampledAt).toBe(sampledAt);
	});
});
