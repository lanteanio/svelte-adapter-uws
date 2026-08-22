// Two registry entries whose conditions nothing reached:
// ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED and ADAPTER-ERR-PRESSURE-RATE-LISTENER.
//
// ADAPTER-ERR-ADMIN-HANDLER belongs to the same group and is NOT here: only the
// production admin route emits it, and `createTestServer` answers the same 500
// without a record, so a case here would have asserted the harness rather than
// the entry. It is driven against the built runtime in
// test/error-registry-hook-crash.test.js instead.
//
// Each is an application-supplied function misbehaving, and each entry makes a
// claim about CONTAINMENT that the failure itself cannot demonstrate: the
// blast radius is what the reader is being promised, so the case has to show
// both that the failure was reported and that the thing the entry says stayed
// up did stay up. A case that only proves the line printed would leave the
// load-bearing half of every one of these entries unchecked.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer } from '../src/testing.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { ADAPTER_ERROR_IDS, adapterErrorDefinition } from '../src/runtime/error-registry.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { REAL_BOOT_BUDGET_MS } from './helpers/real-runtime.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @type {Array<{ close(): void | Promise<void> }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
	setOperationalEventSink(null);
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(20);
	for (const s of servers.splice(0)) { try { await s.close(); } catch { /* closed */ } }
	vi.restoreAllMocks();
});

/** Capture every operational record this case produces, in order. */
function records() {
	/** @type {any[]} */
	const seen = [];
	setOperationalEventSink((record) => { seen.push(record); });
	return seen;
}

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

describe('ADAPTER-ERR-WS-SHUTDOWN-HOOK-UNSETTLED', () => {
	it('stops waiting when the budget expires, and says the flush did not finish', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const previousBudget = process.env.SHUTDOWN_TIMEOUT;
		process.env.SHUTDOWN_TIMEOUT = '1';
		let sawSignal = null;
		let abortedAt = 0;
		try {
			const server = await boot({
				handler: {
					// Never settles, and records whether the abort the entry's
					// nextAction promises actually fires.
					shutdown({ signal }) {
						sawSignal = signal;
						signal?.addEventListener('abort', () => { abortedAt = Date.now(); });
						return new Promise(() => {});
					}
				}
			});
			servers.length = 0; // closed here, deliberately, as the case's subject

			const startedAt = Date.now();
			await server.close();
			const waited = Date.now() - startedAt;

			// Matched on the REGISTRY's own prefix and id tag rather than on a
			// hand-copied string: that is what keeps the emitted line and the
			// indexed entry the same bytes, and it fails if either is reworded
			// without the other.
			const prefix = adapterErrorDefinition(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED).messagePrefix;
			const printed = error.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
			expect(printed, 'a hook still running at the budget must say so').toHaveLength(1);
			expect(String(printed[0][0])).toContain('[' + ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED + ']');
			expect(String(printed[0][0]), 'the line names what was lost, not merely that time passed')
				.toContain('did NOT finish');

			// "None by design: the budget exists so a wedged hook cannot hold the
			// process open." The close returned; that is the claim.
			expect(waited, 'close must not wait indefinitely on a hook that never settles').toBeLessThan(15000);
			// "The hook receives a `signal` that aborts when the budget expires -
			// honoring it turns this into a clean early return." A nextAction
			// naming a signal that never fires is advice that cannot be taken.
			expect(sawSignal, 'the hook is handed a signal').not.toBeNull();
			expect(sawSignal.aborted).toBe(true);
			expect(abortedAt).toBeGreaterThan(0);
		} finally {
			if (previousBudget === undefined) delete process.env.SHUTDOWN_TIMEOUT;
			else process.env.SHUTDOWN_TIMEOUT = previousBudget;
		}
	}, 30000);

	it('says nothing for a hook that finishes inside the budget', async () => {
		// The other side, and the one that decides whether the line means
		// anything: an entry that printed for every shutdown would be noise an
		// operator learns to skip.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const previousBudget = process.env.SHUTDOWN_TIMEOUT;
		process.env.SHUTDOWN_TIMEOUT = '5';
		try {
			let ran = false;
			const server = await boot({ handler: { async shutdown() { await sleep(10); ran = true; } } });
			servers.length = 0;
			await server.close();
			expect(ran, 'the hook must actually have been awaited').toBe(true);
			const prefix = adapterErrorDefinition(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_UNSETTLED).messagePrefix;
			expect(error.mock.calls.filter((c) => String(c[0]).startsWith(prefix))).toHaveLength(0);
		} finally {
			if (previousBudget === undefined) delete process.env.SHUTDOWN_TIMEOUT;
			else process.env.SHUTDOWN_TIMEOUT = previousBudget;
		}
	}, REAL_BOOT_BUDGET_MS);
});

describe('ADAPTER-ERR-PRESSURE-RATE-LISTENER', () => {
	it('reports the throwing listener, keeps it registered, and leaves the rate accounting alone', async () => {
		// Driven at the sampler seam: the emission lives inside the 1 Hz
		// pressure sampler and fires only when a topic crosses its publish-rate
		// threshold, which no wire-level workload can be made to do on cue.
		// The BUILT modules, not the sources: pressure-metrics.js reaches config.js,
		// which reads a build-time placeholder, so the source tree cannot be imported
		// in a unit run at all. The built pair is the same instance a running server
		// uses.
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');
		const state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);
		const { startPressureSampling, stopPressureSampling } = await import(pathToFileURL(path.join(builtDir, 'pressure-metrics.js')).href);
		const seen = records();

		const boom = new Error('rate listener exploded');
		let calls = 0;
		/** @param {any[]} over */
		const listener = (over) => {
			calls++;
			expect(over.some((e) => e.topic === 'rate-entry-topic'), 'the listener is handed the topics that crossed').toBe(true);
			throw boom;
		};
		state.publishRateListeners.add(listener);

		try {
			for (let round = 1; round <= 2; round++) {
				// Well past any plausible threshold for a 1 s window.
				state.topicPublishStats.set('rate-entry-topic', { m: 100000, b: 100000000, d: 100000 });
				// 100 ms is the sampler's own floor - anything smaller is silently
				// replaced by the 1 s default, and the case would then wait for a
				// sample that never came inside its own budget.
				startPressureSampling({ sampleIntervalMs: 100, topicPublishRatePerSec: 10 }, undefined);
				await sleep(400);
				stopPressureSampling();

				const reports = seen.filter((r) => r.event === 'pressure.publish-rate-listener-failed');
				expect(reports.length, `round ${round} must have reported at least once`).toBeGreaterThanOrEqual(round);
				const entry = adapterErrorDefinition(ADAPTER_ERROR_IDS.PRESSURE_RATE_LISTENER);
				expect(reports[0].severity).toBe(entry.severity);
				expect(reports[0].component).toBe(entry.component);
				expect(JSON.stringify(reports[0].attributes)).toContain('rate listener exploded');
			}

			// "Yes. The listener stays registered and is called again." Two
			// rounds, two calls, from a listener that threw the first time -
			// dropping a throwing callback is the more common implementation and
			// is what this entry promises the adapter does NOT do.
			expect(calls).toBeGreaterThanOrEqual(2);
			expect(state.publishRateListeners.has(listener)).toBe(true);

			// "Rate accounting is unaffected." The sampler drains the per-topic
			// counters whether or not the notification landed, so a listener
			// throw must not leave the window's counts behind to be counted
			// twice - which would inflate the next window's rate.
			expect(state.topicPublishStats.has('rate-entry-topic')).toBe(false);
		} finally {
			stopPressureSampling();
			state.publishRateListeners.delete(listener);
			state.topicPublishStats.clear();
		}
	}, 30000);
});
