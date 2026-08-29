// The batch entry table on the PRODUCTION stateful lane, asserted on frames a
// real client receives. The unit and harness suites pin the resolver and the
// mirror; this is the one place the production stamping loop's translation -
// explicit verbatim, entry-level true drawing the counter, false and null
// leaving the entry seq-less - is read back off the wire it actually went out
// on. A JSON client takes the stateful lane's envelope fallback, so each
// entry's envelope arrives exactly as the loop built it.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');

describeUWS('batch entry seq overrides on the production wire', () => {
	/** @type {any} */ let rt;
	/** @type {any} */ let client;
	/** @type {any} */ let platform;

	beforeAll(async () => {
		rt = await startRealRuntime();
		({ platform } = await import(pathToFileURL(path.join(builtDir, 'platform.js')).href));
		client = await connectRealClient(rt.wsUrl);
		client.send({ type: 'subscribe', topic: 'entry-seq', ref: 1 });
		const ack = await client.waitFor((p) => p && p.type === 'subscribed' && p.topic === 'entry-seq' && p.ref === 1, 5000);
		expect(ack, 'the subscribe was never acknowledged').not.toBeNull();
	}, 90000);

	afterAll(async () => {
		try { client?.close(); } catch { /* gone */ }
		await rt?.stop();
	});

	it('stamps each entry by its own resolution and keeps one counter track', async () => {
		const wire = {
			capability: 'fixture.entry-seq:1',
			schemaVersion: 1,
			state: { onAttach: () => ({}) },
			encode: () => null
		};
		platform.publishWireBatch('entry-seq', 'update', [
			{ data: { n: 0 }, seq: 9 },
			{ data: { n: 1 }, seq: true },
			{ data: { n: 2 }, seq: false },
			{ data: { n: 3 }, seq: null },
			{ data: { n: 4 } }
		], wire, {});
		platform.publishWireBatch('entry-seq', 'update', [
			{ data: { n: 5 }, seq: true },
			{ data: { n: 6 } }
		], wire, { seq: false });

		const last = await client.waitFor((p) => p && p.topic === 'entry-seq' && p.data && p.data.n === 6, 5000);
		expect(last, 'the final batch entry never arrived').not.toBeNull();

		const frames = client.frames
			.map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
			.filter((p) => p && p.topic === 'entry-seq' && p.event === 'update');
		expect(frames.map((p) => p.data.n), 'delivery order must be entry order').toEqual([0, 1, 2, 3, 4, 5, 6]);
		// Explicit 9 verbatim with the counter untouched; true draws 1; false
		// and null omit the field; the inheriting entry draws 2 from the batch
		// default; the second batch's true continues the same track at 3 while
		// its sibling inherits the seq-less default.
		expect(frames.map((p) => ('seq' in p ? p.seq : null))).toEqual([9, 1, null, null, 2, 3, null]);
	}, 20000);
});
