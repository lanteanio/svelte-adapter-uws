// The batch exclusion contract on the PRODUCTION wire, both lanes: a
// call-level `excludeWs` is the default for every entry - the author of a
// tick's updates is one socket for the whole batch - and an entry's own
// `excludeWs` overrides it for that entry. Which lane runs is a property of
// the codec (state opts into batch framing); who is excluded must not be.
// The stateful lane used to consult only the entries, so adding `state` to a
// working codec silently dropped the call-level exclusion and the author
// heard its own updates back - the drift this file exists to keep dead, read
// off frames real clients receive.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');

describeUWS('batch exclusions on the production wire', () => {
	/** @type {any} */ let rt;
	/** @type {any} */ let author;
	/** @type {any} */ let audience;
	/** @type {any} */ let authorWs;
	/** @type {any} */ let audienceWs;
	/** @type {any} */ let platform;
	/** @type {any} */ let state;

	const subscribe = async (client, topic, ref) => {
		client.send({ type: 'subscribe', topic, ref });
		const ack = await client.waitFor((p) => p && p.type === 'subscribed' && p.topic === topic && p.ref === ref, 5000);
		expect(ack, `subscribe ${topic} was never acknowledged`).not.toBeNull();
	};

	beforeAll(async () => {
		rt = await startRealRuntime();
		({ platform } = await import(pathToFileURL(path.join(builtDir, 'platform.js')).href));
		state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);

		// Connect one at a time and capture each server-side socket while it is
		// the only one the runtime holds - the object identity `excludeWs`
		// compares against.
		author = await connectRealClient(rt.wsUrl);
		expect(state.wsConnections.size).toBe(1);
		authorWs = state.wsConnections.values().next().value;
		audience = await connectRealClient(rt.wsUrl);
		expect(state.wsConnections.size).toBe(2);
		for (const ws of state.wsConnections) { if (ws !== authorWs) audienceWs = ws; }
		expect(audienceWs).toBeTruthy();
	}, 90000);

	afterAll(async () => {
		try { author?.close(); } catch { /* gone */ }
		try { audience?.close(); } catch { /* gone */ }
		await rt?.stop();
	});

	/** Frames a client received for one topic, by payload marker. */
	const received = (client, topic) => client.frames
		.map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
		.filter((p) => p && p.topic === topic && p.event === 'update')
		.map((p) => p.data.n);

	it('the stateful lane honours a call-level exclusion, with a per-entry override', async () => {
		const topic = 'exclude-stateful';
		await subscribe(author, topic, 11);
		await subscribe(audience, topic, 12);
		const wire = {
			capability: 'fixture.exclude-stateful:1',
			schemaVersion: 1,
			state: { onAttach: () => ({}) },
			encode: () => null
		};
		platform.publishWireBatch(topic, 'update', [
			{ data: { n: 0 } },
			{ data: { n: 1 }, excludeWs: audienceWs },
			{ data: { n: 2 } },
			// null is ABSENT, not an override to nothing: it inherits the
			// call-level default like an entry that says nothing.
			{ data: { n: 3 }, excludeWs: null }
		], wire, { seq: false, excludeWs: authorWs });

		const settled = await audience.waitFor((p) => p && p.topic === topic && p.data && p.data.n === 3, 5000);
		expect(settled, 'the audience never saw the batch settle').not.toBeNull();
		// The author is excluded by default; the middle entry overrides the
		// default to exclude the audience instead, so it reaches the author.
		expect(received(audience, topic), 'the audience receives all but its own override entry').toEqual([0, 2, 3]);
		expect(received(author, topic), 'the author hears only the entry that overrode the default').toEqual([1]);
	}, 20000);

	it('the stateless lane answers the same contract', async () => {
		const topic = 'exclude-stateless';
		await subscribe(author, topic, 21);
		await subscribe(audience, topic, 22);
		const wire = {
			capability: 'fixture.exclude-stateless:1',
			schemaVersion: 1,
			encode: () => null
		};
		platform.publishWireBatch(topic, 'update', [
			{ data: { n: 0 } },
			{ data: { n: 1 }, excludeWs: audienceWs },
			{ data: { n: 2 } },
			// null is ABSENT, not an override to nothing: it inherits the
			// call-level default like an entry that says nothing.
			{ data: { n: 3 }, excludeWs: null }
		], wire, { seq: false, excludeWs: authorWs });

		const settled = await audience.waitFor((p) => p && p.topic === topic && p.data && p.data.n === 3, 5000);
		expect(settled, 'the audience never saw the batch settle').not.toBeNull();
		expect(received(audience, topic), 'the audience receives all but its own override entry').toEqual([0, 2, 3]);
		expect(received(author, topic), 'the author hears only the entry that overrode the default').toEqual([1]);
	}, 20000);
});
