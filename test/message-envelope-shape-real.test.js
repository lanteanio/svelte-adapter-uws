// What `MessageContext.msg` carries, driven through the BUILT runtime.
//
// `msg` is the control envelope the adapter already parsed, handed to the app
// hook so plugin dispatchers (svelte-realtime's `onJsonMessage`) don't re-run
// TextDecoder + JSON.parse on every frame. `index.d.ts` declares it undefined
// when the parsed value "was not a plain object (null / array / primitive)".
//
// The array is the shape that check can silently admit, because `typeof [] ===
// 'object'`: an array frame parses, passes an object test that does not name
// arrays, matches no control type (`type` is undefined on an array) and lands
// on the app hook as an envelope the declared contract says cannot arrive.
// `src/testing.js` and `src/vite.js` name the array; production has to as well,
// or an app sees one envelope shape in dev and another in production.
//
// Both arms run on ONE connection and carry a nonce, because `waitFor` scans
// the whole frame history and the second probe would otherwise read the first
// probe's answer back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the pre-parsed envelope handed to the app message hook', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime();
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('is absent for a JSON array and present for an object envelope no control type claims', async () => {
		const client = await connectRealClient(server.wsUrl);
		try {
			// byte[3] has to be 'y' or the frame is never parsed at all, which
			// would make both arms pass for the wrong reason: `[{"y` and `{"ty`
			// each put it there.
			client.send('[{"y":1,"nonce":"array"}]');
			const asArray = await client.waitFor(
				(parsed) => parsed?.event === 'envelope-shape' && parsed?.data?.nonce === 'array',
				2000
			);
			expect(asArray, 'the array frame must still reach the app hook as raw bytes').not.toBeNull();
			expect(
				asArray.parsed.data.present,
				'an array must not arrive as a pre-parsed envelope'
			).toBe(false);

			// The control arm. Without it, a guard that cleared `msg` for every
			// shape would pass the case above while deleting the fast path this
			// field exists for.
			client.send('{"type":"envelope-shape-probe","nonce":"object"}');
			const asObject = await client.waitFor(
				(parsed) => parsed?.event === 'envelope-shape' && parsed?.data?.nonce === 'object',
				2000
			);
			expect(asObject, 'the object frame must reach the app hook').not.toBeNull();
			expect(
				asObject.parsed.data.present,
				'an object envelope no control type claims still arrives pre-parsed'
			).toBe(true);
			expect(asObject.parsed.data.isArray).toBe(false);
		} finally {
			client.close();
		}
	});
});
