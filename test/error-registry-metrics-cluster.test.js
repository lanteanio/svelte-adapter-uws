// ADAPTER-ERR-METRICS-MERGE and ADAPTER-ERR-METRICS-PRIMARY-UNREACHABLE,
// driven from the conditions they claim: the BUILT runtime's own
// metrics-snapshot module running in a real worker thread, with this test as
// the primary on the other end of the real parentPort.
//
// The conditions are the entries' own, not proxies for them. The unreachable
// entry names an instrumented port whose piggybacked context makes the real
// postMessage throw - a closed port is a silent no-op on current Node and
// cannot produce the line - so the drive installs that wrapper and the throw
// is a genuine DataCloneError from structured clone. The merge entry rules bad
// input OUT of its own cause - every deliverable report is normalized before
// the combine, which the hostile-collection case below drives across the real
// thread boundary and watches be dropped rather than thrown - and names what
// is left: a defect in the merge, or a rewrapped runtime built-in underneath
// it. So both merge drives hand across an ORDINARY deliverable report and
// rewrap a built-in instead; a report structured clone would refuse cannot
// cross the boundary at all, so handing one in on this side would prove the
// catch runs and nothing about what reaches it. Each case binds the emitted
// event to the actual error that crossed the catch, and the first also binds
// the THROWING FRAME, so a fault that relocates out of the combine reds
// rather than passing on a matching message.
//
// Both entries are containment for the cluster boundary, and both make a
// promise beyond "the line prints": the scrape is ANSWERED and the endpoint
// stays up. That resolving is the load-bearing part - the module shares one
// in-flight promise per worker, so a catch that ever stopped resolving would
// hang every later scrape on the worker, not one. What the answer CONTAINS
// degrades in two steps, and there is a case for each: a fault the recovery
// can work around is answered with the degraded local-only document, while
// one that also breaks the recovery is answered with an empty document -
// still settled, and honest that this interval carries nothing. The first
// merge case then runs a second, healthy collection through the same worker,
// because "the next scrape attempts the merge again" is the entry's recovery
// claim and a poisoned first attempt is exactly when it would break.
//
// See helpers/metrics-snapshot-worker.mjs for how each fault is injected on
// the real objects the runtime calls.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { mergeSamples } from '../src/runtime/utils/metrics-merge.js';
import { SIGNALS } from '../src/runtime/observability-manifest.js';
import { METRIC_REGISTRATIONS_SAMPLE } from '../src/runtime/utils/metrics.js';
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

	it('PRIMARY-UNREACHABLE: an instrumented port whose real post throws answers the scrape degraded, local worker only', async () => {
		worker.postMessage({ type: 'drive-unreachable' });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'unreachable');

		const hit = result.events.find((e) => e.event === 'metrics.primary-unreachable');
		expect(hit, 'the entry event must be emitted').toBeTruthy();
		expect(hit.severity).toBe('error');
		expect(hit.message).toBe(unreachableEntry.problemPrefix);
		// The throw the entry's cause names, verbatim from the platform: the
		// wrapper's piggybacked context was refused by structured clone inside
		// the REAL postMessage. An injected stub error would fail this.
		expect(hit.error?.name).toBe('DataCloneError');
		expect(hit.error?.message).toContain('could not be cloned');

		// The containment half: the scrape is ANSWERED - the endpoint stays up
		// while the numbers describe one worker, and the document says so.
		expect(typeof result.doc).toBe('string');
		expect(result.doc).toContain('metrics_snapshot_degraded 1');
		expect(result.doc).toContain('metrics_snapshot_workers_expected 1');
	}, REAL_BOOT_BUDGET_MS);

	it('METRICS-MERGE: a deliverable collection whose combine throws still answers, degraded', async () => {
		// The report handed across is ordinary and merges cleanly on every other
		// run in this file; what fails is a built-in the combine reaches from
		// inside its per-sample loop, which is the half of the entry's cause
		// that bad input cannot reach. The built-in matters: the resolve path
		// normalizes its own arguments first, so poisoning something IT calls
		// would be caught by the same catch without the combine ever running.
		worker.postMessage({ type: 'drive-collect', name: 'poisoned' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		worker.postMessage({ type: 'deliver-poison', id: request.id });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'poisoned');

		const hit = result.events.find((e) => e.event === 'metrics.merge-failed');
		expect(hit, 'the entry event must be emitted').toBeTruthy();
		expect(hit.severity).toBe('error');
		expect(hit.message).toBe(mergeEntry.problemPrefix);
		// The attached error is the one the merge actually raised - the entry's
		// "report it with the attached error" guidance carries the real cause.
		expect(hit.error?.message).toContain('__MERGE_POISON__');

		// "this scrape answers with the local worker only" - the promise
		// resolved, and it resolved to the degraded local document rather than
		// to nothing. Counters appearing to drop for one interval is the
		// documented shape of exactly this answer.
		//
		// WHERE it threw, not just that it did. Without this the fault could
		// relocate into the resolve path's own argument normalization - caught
		// by the same catch, same event, same message, same document - and
		// nothing would notice the combine had stopped being exercised.
		expect(result.poisonStack, 'the worker did not report a throwing frame').toBeTruthy();
		expect(result.poisonStack, 'the fault must be raised from inside the combine').toContain('metrics-merge.js');

		expect(typeof result.doc).toBe('string');
		expect(result.doc).toContain('metrics_snapshot_degraded 1');
		// Two reports were delivered and the pair said 2/2, but the local-only
		// fallback hardcodes one worker - so reading 1 back proves this
		// document came from the fallback rather than the delivered context.
		expect(result.doc).toContain('metrics_snapshot_workers_expected 1');
	}, REAL_BOOT_BUDGET_MS);

	it('METRICS-MERGE: a fault that outlives the catch still settles the shared promise', async () => {
		// A rewrapped built-in does not un-install itself after one throw, and
		// the case above deliberately does, so that the catch's own recovery
		// runs clean. This is the other half: a fault that persists and is
		// reached from every place an answer could be built - the resolve
		// path's own normalization, the combine, and the fallback that renders
		// the local-only document - so no document is constructible and the
		// runtime falls through to resolving with an empty one.
		//
		// Settling is the claim, not the content. Every concurrent scrape on a
		// worker awaits ONE in-flight promise, so a catch that stopped
		// resolving would hang all of them indefinitely rather than degrade a
		// single interval - the failure the entry's containment exists to
		// prevent, and the one a caller cannot recover from.
		worker.postMessage({ type: 'drive-collect', name: 'sustained' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		worker.postMessage({ type: 'deliver-poison-sustained', id: request.id });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'sustained');

		const hit = result.events.find((e) => e.event === 'metrics.merge-failed');
		expect(hit, 'the entry event must still be emitted').toBeTruthy();
		expect(hit.error?.message).toContain('__MERGE_POISON_SUSTAINED__');
		// The promise resolved - that is the assertion. It resolved to the last
		// resort rather than a document, which is the honest answer when even
		// the local-only render cannot be built.
		expect(typeof result.doc, 'the scrape must be answered, not left hanging').toBe('string');
		expect(result.doc).toBe('');
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

	it('the platform fact the unreachable cause rests on: posting to a closed MessagePort is a silent no-op', () => {
		const { port1, port2 } = new MessageChannel();
		port2.close();
		port1.close();
		// The entry attributes the throw to an instrumented port precisely
		// because a dead one cannot produce it. If a Node change ever makes
		// this throw, the cause must be rewritten alongside this pin.
		expect(() => port1.postMessage({ type: 'metrics-request', id: 'x', timeoutMs: 50 })).not.toThrow();
	});

	it('a hostile but deliverable collection is dropped by the bounds, never thrown into the catch', async () => {
		worker.postMessage({ type: 'drive-collect', name: 'hostile' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		// Everything below survives structured clone, so a primary COULD put
		// it on the wire - which is exactly what the merge entry's cause rules
		// out of the catch: these shapes are dropped or collapsed, never
		// thrown. The sample-level circular reference and the BigInt ride
		// along untouched fields; the label shapes probe each bound.
		const circular = { name: 'ws_connections', value: 7, labels: {} };
		circular.self = circular;
		worker.postMessage({
			type: 'deliver-reports',
			id: request.id,
			expected: 1,
			reporting: 1,
			reports: [{
				worker: 1,
				samples: [
					// An oversized registration inventory: skipped by the sample
					// loop (its name is no manifest signal) and trimmed by the
					// inventory bound before the completeness read seats a Set.
					{ name: METRIC_REGISTRATIONS_SAMPLE, families: Array.from({ length: 5000 }, (_, i) => 'junk_family_' + i) },
					{ name: 'upgrade_rejected_total', value: 909091, labels: { reason: 'y'.repeat(300000) } },
					{ name: 'upgrade_rejected_total', value: 909092, labels: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, 'v'])) },
					{ name: 'upgrade_rejected_total', value: 909093, labels: new Map([['reason', 'm']]) },
					{ name: 'upgrade_rejected_total', value: 909095, labels: { 'bad"key\n': 'x' } },
					{ name: 'upgrade_rejected_total', value: 909094n, labels: { reason: 'big' } },
					circular,
					{ name: 'upgrade_rejected_total', value: 41, labels: { reason: 'capacity' } }
				]
			}]
		});
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'hostile');

		expect(result.events.find((e) => e.event === 'metrics.merge-failed'),
			'a deliverable collection must never reach the merge catch').toBeUndefined();
		expect(typeof result.doc).toBe('string');
		// The oversized label value, the oversized key set, the non-record
		// label shape, and the key outside the exposition grammar (which has
		// no key escaping, so an accepted bad key would inject bytes into the
		// document) are dropped whole - their sentinel values never render.
		expect(result.doc).not.toContain('909091');
		expect(result.doc).not.toContain('909092');
		expect(result.doc).not.toContain('909093');
		expect(result.doc).not.toContain('909095');
		expect(result.doc).not.toContain('bad"key');
		// The non-numeric value collapses to NaN on its otherwise-valid series
		// rather than taking the sample down with it.
		expect(result.doc).toContain('upgrade_rejected_total{reason="big"} NaN');
		// The positive controls: well-formed samples in the same delivery
		// arrive untouched, so the bounds drop rather than degrade.
		expect(result.doc).toContain('upgrade_rejected_total{reason="capacity"} 41');
		expect(result.doc).toContain('ws_connections 7');
	}, REAL_BOOT_BUDGET_MS);

	it('a delivered series flood seats up to the document bound and no further', async () => {
		worker.postMessage({ type: 'drive-collect', name: 'flood' });
		const request = await nextMessage((m) => m.type === 'metrics-request');
		const samples = [];
		for (let i = 0; i < 5000; i++) samples.push({ name: 'ws_connections', value: 1, labels: { reason: 'r' + i } });
		worker.postMessage({ type: 'deliver-reports', id: request.id, expected: 1, reporting: 1, reports: [{ worker: 1, samples }] });
		const result = await nextMessage((m) => m.type === 'result' && m.name === 'flood');

		expect(result.events.find((e) => e.event === 'metrics.merge-failed')).toBeUndefined();
		// 4096 distinct series seat; the rest are dropped, which is what keeps
		// the rendered document finite whatever a delivery carries.
		const lines = result.doc.split('\n').filter((l) => l.startsWith('ws_connections{'));
		expect(lines.length).toBe(4096);
	}, REAL_BOOT_BUDGET_MS);

	it('a registration inventory beyond the bound is trimmed, not seated', () => {
		const required = SIGNALS.filter((s) => s.merged !== true && s.optional !== true && s.scope === 'worker');
		const names = required.map((s) => s.name);
		const nonCounterSamples = required.filter((s) => s.type !== 'counter')
			.map((s) => ({ name: s.name, value: 1, labels: {} }));
		const marker = (families) => ({ name: METRIC_REGISTRATIONS_SAMPLE, families });

		// The control: a real inventory plus the required numeric samples is a
		// complete report and counts as reporting.
		const complete = mergeSamples(
			[{ worker: 1, samples: [marker(names), ...nonCounterSamples] }],
			{ expected: 1, reporting: 1 }
		);
		expect(complete).toContain('metrics_snapshot_workers_reporting 1');

		// The junk fills the inventory bound exactly, pushing every real name
		// past it; the trim drops them, so completeness cannot be claimed
		// through an inventory of unbounded length. Were the bound removed,
		// the real names would survive, this report would count as reporting,
		// and a deliverable inventory could then grow a Set past the engine's
		// maximum size inside the merge.
		const junk = Array.from({ length: 1024 }, (_, i) => 'not_a_family_' + i);
		const trimmed = mergeSamples(
			[{ worker: 1, samples: [marker([...junk, ...names]), ...nonCounterSamples] }],
			{ expected: 1, reporting: 1 }
		);
		expect(trimmed).toContain('metrics_snapshot_workers_reporting 0');
	});
});
