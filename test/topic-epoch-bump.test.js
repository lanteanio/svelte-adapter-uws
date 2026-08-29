// The app-driven epoch mint: a topic whose seq AUTHORITY changes must
// repudiate every offset clients recorded under the old one, and nothing but
// a fresh epoch does that. bumpTopicEpoch mints through the same shared
// machinery the confirmed-relay-loss drain installs its override with, so
// the subscribe ack and every resume compare pick the new value up through
// the one read authority - here pinned off the ack a real client of the
// harness receives, and on the shared mint helper directly.

import { describe, it, expect, afterEach } from 'vitest';
import {
	mintTopicEpoch, topicEpochValue, processEpoch, resetProcessEpoch, resetTopicEpochs
} from '../src/runtime/utils/epoch.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

let uWS = null;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const itUWS = uWS ? it : it.skip;

afterEach(() => { resetTopicEpochs(); });

describe('bumpTopicEpoch mints a fresh per-topic generation', () => {
	it('changes what the read authority answers, for that topic alone', () => {
		const before = topicEpochValue('bump-a');
		expect(before, 'an unbumped topic answers the process generation').toBe(processEpoch());
		const minted = mintTopicEpoch('bump-a');
		expect(minted).not.toBe(before);
		expect(topicEpochValue('bump-a'), 'the read authority must answer the mint').toBe(minted);
		expect(topicEpochValue('bump-b'), 'a sibling topic keeps the process generation').toBe(processEpoch());
		// A second bump repudiates the first mint's offsets the same way.
		const again = mintTopicEpoch('bump-a');
		expect(again).not.toBe(minted);
		expect(topicEpochValue('bump-a')).toBe(again);
	});

	it('re-rolls a mint that would equal the value it replaces', () => {
		// The guard is what makes a bump never a no-op, and a probabilistic
		// assert is vacuous against the dropped-guard mutant (2^-32 per run).
		// Script the RNG through the injectable seam instead: latch the
		// generation to X, hand the mint X then Y - a guarded mint must skip
		// the colliding X and install Y, every run.
		const rolls = [111, 111, 999];
		let i = 0;
		setRuntimeEnv({ rng: { u32: () => rolls[Math.min(i++, rolls.length - 1)] } });
		try {
			resetProcessEpoch();
			expect(processEpoch(), 'the generation must latch the scripted X').toBe(111);
			const minted = mintTopicEpoch('bump-reroll');
			expect(minted, 'a mint colliding with the current value must re-roll').toBe(999);
			expect(topicEpochValue('bump-reroll')).toBe(999);
		} finally {
			resetRuntimeEnv();
			resetProcessEpoch();
			resetTopicEpochs();
		}
	});

	it('stays inside the wire-legal u32 domain the epoch fields carry', () => {
		const minted = mintTopicEpoch('bump-domain');
		expect(Number.isInteger(minted)).toBe(true);
		expect(minted).toBeGreaterThanOrEqual(0);
		expect(minted).toBeLessThanOrEqual(0xFFFFFFFF);
	});

	itUWS('reaches the subscribe ack a real client receives, before and after', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer();
		try {
			const { WebSocket } = await import('ws');
			const ws = new WebSocket(server.wsUrl);
			const frames = [];
			ws.on('message', (d, isBinary) => { if (!isBinary) { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

			const ack = async (ref) => {
				const deadline = Date.now() + 5000;
				for (;;) {
					const hit = frames.find((p) => p && p.type === 'subscribed' && p.ref === ref);
					if (hit) return hit;
					if (Date.now() >= deadline) return null;
					await new Promise((r) => setTimeout(r, 10));
				}
			};

			ws.send(JSON.stringify({ type: 'subscribe', topic: 'bump-ack', ref: 1 }));
			const first = await ack(1);
			expect(first, 'the first subscribe was never acknowledged').not.toBeNull();

			const minted = server.platform.bumpTopicEpoch('bump-ack');
			expect(minted).not.toBe(first.epoch);

			// A resubscribe after the bump acks the MINTED generation - the
			// value a reconnecting client would record and present.
			ws.send(JSON.stringify({ type: 'unsubscribe', topic: 'bump-ack' }));
			ws.send(JSON.stringify({ type: 'subscribe', topic: 'bump-ack', ref: 2 }));
			const second = await ack(2);
			expect(second, 'the post-bump subscribe was never acknowledged').not.toBeNull();
			expect(second.epoch, 'the ack must carry the minted generation').toBe(minted);
			ws.terminate();
		} finally {
			await server.close();
		}
	}, 30000);
});
