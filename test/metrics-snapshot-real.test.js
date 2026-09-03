// Production-built proof for the cluster metrics snapshot's completeness
// contract. The unit suite drives mergeSamples with reports it composes by
// hand, which can prove the merge but never that the RUNTIME writes every
// required signal - the exact gap that let a required gauge ship that no
// healthy worker ever wrote, pinning `metrics_snapshot_workers_reporting` at 0
// in every deployment and firing the shipped alert pack out of the box. This
// boots the real metrics fixture and asserts on the document produced from the
// live registry's own mirrored samples.
//
// `platform.metricsSnapshot()` itself cannot be awaited inside a vitest
// worker: the suite runs in a worker thread, so `parentPort` is vitest's and
// the runtime would wait on a primary that will never answer. The
// single-process production path is exactly
// `mergeSamples([{ worker: threadId, samples: collectLocalMetrics() }],
// { expected: 1 })` (localOnly in src/runtime/handler/metrics-snapshot.js), so
// this test drives that same composition using the BUILT modules the running
// server evaluated - same module instances, same live mirror.

import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { variantOut } from './fixture/variants.js';

const describeUWS = hasUWS ? describe : describe.skip;
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

/** Parse unlabelled series out of exposition text. */
function parseValues(text) {
	const values = new Map();
	for (const line of text.split('\n')) {
		const match = /^([a-z_][a-z0-9_]*) (-?\d+(?:\.\d+)?)$/.exec(line);
		if (match) values.set(match[1], Number(match[2]));
	}
	return values;
}

describeUWS('production metrics snapshot completeness', () => {
	let server;
	afterAll(async () => { await server?.stop(); });

	it('a healthy single-process worker produces a complete, non-degraded document', async () => {
		server = await startRealRuntime({ variant: 'metrics' });

		const built = (name) =>
			import(pathToFileURL(path.join(fixtureDir, variantOut('metrics'), name)).href);
		const { collectLocalMetrics } = await built('handler/metrics-snapshot.js');
		const { mergeSamples } = await built('utils/metrics-merge.js');

		// The required gauges are written by the 1 Hz sampler, so the first
		// complete report can be up to a tick away. Poll the real path rather
		// than fabricating the missing samples - fabricating them is exactly
		// how a required-but-never-written gauge stayed green before.
		const deadline = Date.now() + 10_000;
		let values = new Map();
		let doc = '';
		for (;;) {
			doc = mergeSamples(
				[{ worker: threadId, samples: collectLocalMetrics() }],
				{ expected: 1 }
			);
			values = parseValues(doc);
			if (values.get('metrics_snapshot_workers_reporting') === 1) break;
			if (Date.now() >= deadline) break;
			await new Promise((r) => setTimeout(r, 200));
		}

		// EVERY SIGNAL IN THE RENDERED DOCUMENT CARRIES A DESCRIPTION.
		//
		// Deliberately NOT compared against the manifest's help text. The
		// renderer reads its help FROM the manifest, so a text-equality
		// assertion moves with the thing it is meant to check: reword an entry
		// and both sides change together. That version passes a mutation it
		// should fail, which makes it worse than no assertion at all.
		//
		// What is checked instead binds to the DOCUMENT: every metric the
		// document renders must be preceded by a `# HELP <name> <sentence>`
		// line carrying at least one non-space character. A signal that drops
		// out of the document, or renders without a description, fails by name.
		//
		// SCOPE, so nobody reads this as more than it is: it covers what THIS
		// fixture renders, not every signal the manifest declares. A counter
		// that never fires here - `ws_publish_outcomes_total` among them, since
		// the fixture publishes nothing - is absent from the document and so
		// cannot be checked. Emptying its help was a mutation this suite did
		// NOT catch, which is how the boundary was measured rather than
		// assumed.
		const helped = new Set();
		for (const line of doc.split('\n')) {
			const match = /^# HELP ([a-z_][a-z0-9_]*) (\S.*)$/.exec(line);
			if (match) helped.add(match[1]);
		}
		// Vacuity floor: an empty or truncated document would satisfy a
		// per-signal loop over nothing. The metrics fixture renders well over
		// this many families; the number is a floor, not a count to maintain.
		expect(helped.size, 'the rendered document carried almost no HELP lines').toBeGreaterThan(20);
		// The rendered set is read from the SAMPLE lines, both forms. Building
		// it from `values` instead covered only the unlabelled series, because
		// that parser is value-oriented and skips `name{label="x"} 1` - so a
		// labelled family losing its description passed. Mutation found that;
		// reading the name off both shapes is what closes it.
		const rendered = new Set();
		for (const line of doc.split('\n')) {
			const match = /^([a-z_][a-z0-9_]*)(?:\{[^}]*\})? -?\d/.exec(line);
			if (match) rendered.add(match[1]);
		}
		expect(rendered.size, 'the rendered document carried almost no samples').toBeGreaterThan(20);
		const undescribed = [...rendered].filter((name) => !helped.has(name));
		expect(undescribed, 'signals rendered into the document with no HELP line').toEqual([]);

		// AND THE DESCRIPTIONS DO NOT NAME THE RUNTIME THAT PRODUCED THE
		// NUMBER. This is the half a manifest comparison cannot make: the
		// absent words are an independent fact, not a copy of the source the
		// renderer already read. A stale or hardcoded sentence surviving
		// anywhere in the render path shows up here.
		const layerNaming = doc.split('\n').filter((line) =>
			line.startsWith('# HELP ') && /C\+\+|native backpressure limit|Native publish calls/.test(line));
		expect(layerNaming, 'a HELP line still names the implementation layer').toEqual([]);

		expect(values.get('metrics_snapshot_workers_expected'), 'workers_expected').toBe(1);
		expect(values.get('metrics_snapshot_workers_reporting'),
			'a healthy worker must satisfy the completeness gate without any synthetic sample'
		).toBe(1);
		expect(values.get('metrics_snapshot_degraded'), 'degraded flag').toBe(0);

		// The lifeline gauge that previously was only written at quarantine:
		// healthy means an explicit zero, not absence.
		expect(values.get('relay_spill_pending_age_seconds'),
			'healthy workers publish relay_spill_pending_age_seconds as an explicit zero'
		).toBe(0);

		// Healthy-zero families: registered, never-fired counters render at
		// zero in a complete document - this is the zero_when_complete policy
		// the manifest promises, and it only renders when the completeness
		// gate above actually passes.
		expect(values.get('relay_gap_frames_total'), 'zero-counter family').toBe(0);
		expect(values.get('upgrade_deferred_rejected_total'), 'zero-counter family').toBe(0);

		// The pacing-queue gauges the manifest declares reach the snapshot.
		expect(values.get('upgrade_deferred_depth'), 'idle pacing queue depth').toBe(0);
		expect(values.get('upgrade_deferred_oldest_age_seconds'), 'idle pacing queue age').toBe(0);
	}, 20_000);
});
