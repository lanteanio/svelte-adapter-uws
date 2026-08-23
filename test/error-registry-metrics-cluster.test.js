// ADAPTER-ERR-METRICS-MERGE and ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE,
// driven from the conditions they claim: the BUILT runtime's own
// metrics-snapshot module running in a real worker thread, with this test as
// the primary on the other end of the real parentPort.
//
// Both entries are containment for the cluster boundary, and both make a
// promise beyond "the line prints": the scrape is still ANSWERED, degraded and
// local-only, with the endpoint up. That resolving is load-bearing - the
// module shares one in-flight promise per worker, so a catch that ever stopped
// resolving would hang every later scrape on the worker, not one. Each case
// therefore asserts the emitted event AND the document that came back, and the
// merge case then runs a second, healthy collection through the same worker,
// because "the next scrape attempts the merge again" is the entry's recovery
// claim and a poisoned first attempt is exactly when it would break.
//
// See helpers/metrics-snapshot-worker.mjs for how each fault is injected on
// the real objects the runtime calls.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { hasUWS, REAL_BOOT_BUDGET_MS } from './helpers/real-runtime.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const workerScript = fileURLToPath(new URL('./helpers/metrics-snapshot-worker.mjs', import.meta.url));
const mergeEntry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.METRICS_MERGE);
const unreachableEntry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.METRICS_PRIMARY_UNREACHABLE);

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the cluster metrics containment entries against the built runtime', () => {
	/** @type {Worker | null} */
	let worker = null;
	/** @type {Array<any>} */
	let inbox = [];
	/** @type {Array<(msg: any) => void>} */
	let waiters = [];

	// Every request-answer round trip below has to land inside the runtime's
	// own collection deadline (metrics-snapshot.js answers degraded on its own
	// after ~2s), so the primary half answers each request the moment it
	// arrives; the waits here are generous only for the machine, not the
	// protocol.
	function nextMessage(match, timeoutMs = 15000) {
		const found = inbox.findIndex(match);
		if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
		// The symmetric fatal rule for the inbox: a worker error that fired
		// between cases (no waiter registered) must fail the next wait by name,
		// not by that wait burning its budget on a message a dead thread can
		// no longer send.
		const stranded = inbox.find((m) => m.type === 'worker-error');
		if (stranded !== undefined) return Promise.reject(new Error(stranded.error));
		return new Promise((resolve, reject) => {
			const waiter = (msg) => {
				// A worker error fails whatever is being waited on, by name -
				// otherwise it would sit in the inbox while this wait burns its
				// full budget on a message that can no longer arrive.
				if (msg.type === 'worker-error' && !match(msg)) {
					clearTimeout(timer);
					reject(new Error(msg.error));
					return true;
				}
				if (!match(msg)) return false;
				clearTimeout(timer);
				resolve(msg);
				return true;
			};
			const timer = setTimeout(() => {
				// A dead waiter must not linger: it would swallow the next
				// matching message a later case is waiting for.
				const i = waiters.indexOf(waiter);
				if (i !== -1) waiters.splice(i, 1);
				reject(new Error('timed out waiting for a worker message'));
			}, timeoutMs);
			waiters.push(waiter);
		});
	}

	beforeAll(async () => {
		expect(buildFixtureOnce('metrics'), 'fixture build must succeed').toBe(true);
		worker = new Worker(workerScript, {
			workerData: { buildDir: path.join(fixtureDir, variantOut('metrics')) }
		});
		// One dispatch for BOTH events: a worker 'error' fires no earlier than
		// the next tick, after this block has already registered its waiter, so
		// an error handler that only pushed to the inbox would never reach the
		// waiter and the failure would still surface as an opaque timeout.
		const dispatch = (msg) => {
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i](msg)) { waiters.splice(i, 1); return; }
			}
			inbox.push(msg);
		};
		worker.on('message', dispatch);
		worker.on('error', (err) => {
			dispatch({ type: 'worker-error', error: String(err && err.stack || err) });
		});
		const first = await nextMessage((m) => m.type === 'ready' || m.type === 'worker-error', 30000);
		expect(first.type, first.error ?? 'ready').toBe('ready');
	}, 400000);

	afterAll(async () => {
		if (worker) await worker.terminate();
		worker = null;
	});

	it('PRIMARY-UNREACHABLE: a dead port answers the scrape degraded, local worker only', async () => {
		worker.postMessage({ type: 'drive-unreachable' });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'unreachable');

		const hit = result.events.find((e) => e.event === 'metrics.primary-unreachable');
		expect(hit, 'the entry event must be emitted').toBeTruthy();
		expect(hit.severity).toBe('error');
		expect(hit.message).toBe(unreachableEntry.problemPrefix);

		// The containment half: the scrape is ANSWERED - the endpoint stays up
		// while the numbers describe one worker, and the document says so.
		expect(typeof result.doc).toBe('string');
		expect(result.doc).toContain('metrics_snapshot_degraded 1');
		expect(result.doc).toContain('metrics_snapshot_workers_expected 1');
	}, REAL_BOOT_BUDGET_MS);

	it('METRICS-MERGE: a collection whose combination throws still answers, degraded', async () => {
		worker.postMessage({ type: 'drive-collect', name: 'poisoned' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		worker.postMessage({ type: 'deliver-poison', id: request.id });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'poisoned');

		const hit = result.events.find((e) => e.event === 'metrics.merge-failed');
		expect(hit, 'the entry event must be emitted').toBeTruthy();
		expect(hit.severity).toBe('error');
		expect(hit.message).toBe(mergeEntry.problemPrefix);

		// "this scrape answers with the local worker only" - the promise
		// resolved, and it resolved to the degraded local document rather than
		// to nothing. Counters appearing to drop for one interval is the
		// documented shape of exactly this answer.
		expect(typeof result.doc).toBe('string');
		expect(result.doc).toContain('metrics_snapshot_degraded 1');
	}, REAL_BOOT_BUDGET_MS);

	it('and the next scrape merges again: the recovery claim, driven after the poison', async () => {
		worker.postMessage({ type: 'drive-collect', name: 'clean' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		worker.postMessage({ type: 'deliver-clean', id: request.id });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'clean');

		expect(result.events.find((e) => e.event === 'metrics.merge-failed'),
			'a healthy collection must not report a merge failure').toBeUndefined();
		expect(typeof result.doc).toBe('string');
		// The delivered collection merged: the document is NOT the degraded
		// local fallback the poisoned attempt answered with. (The bare report
		// delivered here is legitimately discounted by the completeness rule -
		// it carries no registration inventory - so the reporting count is that
		// rule's contract, pinned in its own suite, not this one's.)
		expect(result.doc).toContain('metrics_snapshot_degraded 0');
	}, REAL_BOOT_BUDGET_MS);
});
