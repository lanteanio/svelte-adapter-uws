// ADAPTER-ERR-RESUME-HOOK-READ and ADAPTER-ERR-DIVERGENCE, driven from the
// conditions they claim.
//
// The resume entry's consequence says an unreadable hook result loses only
// the watermark report: the hook already ran, so its replay is on the wire,
// and the held-frame flush falls back to the pre-window floor and delivers
// the whole captured window - duplicates inside that window, never a gap.
// The cases drive coveredSeqFor with a throwing getter (the event, the
// undefined watermark) and flushResumeTopic against the two floors (the
// fallback and an exact watermark), through the BUILT runtime modules so the
// state maps and the emitting module are the instances production uses.
//
// The divergence entry's recovery is gated: none by default, and under
// RESTART_ON_STATE_DIVERGENCE=1 the primary asks each MINORITY worker to
// exit. What makes that attribution possible is the detector naming the
// minority after a persisted disagreement - the pure seam driven here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hasUWS, EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { createStateHashDetector } from '../src/runtime/state-hash-detector.js';

const describeUWS = hasUWS ? describe : describe.skip;
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describeUWS('ADAPTER-ERR-RESUME-HOOK-READ', () => {
	let resumeBuffer;
	let state;
	let diagnostic;
	/** @type {Array<[string, string | undefined]>} */
	let envBefore = [];

	beforeAll(async () => {
		expect(buildFixtureOnce()).toBe(true);
		// The runtime reads env at module eval, and process.env is shared by
		// every test file this worker process runs - so snapshot, scrub for a
		// deterministic eval, and restore in afterAll.
		envBefore = EVAL_TIME_ENV.map((key) => [key, process.env[key]]);
		for (const key of EVAL_TIME_ENV) delete process.env[key];
		resumeBuffer = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'resume-buffer.js')).href);
		state = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'state.js')).href);
		diagnostic = await import(pathToFileURL(join(fixtureDir, 'build', 'diagnostic.js')).href);
	}, 400000);

	afterAll(() => {
		for (const [key, value] of envBefore) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('an unreadable topic emits the entry event and reports no watermark', () => {
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });
		try {
			const covered = {};
			Object.defineProperty(covered, 'room', {
				enumerable: true,
				get() { throw new Error('lazy row detached'); }
			});
			expect(resumeBuffer.coveredSeqFor(covered, 'room')).toBeUndefined();
			const hit = events.find((e) => e.event === 'resume.hook-read-failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error).toBeTruthy();
		} finally {
			diagnostic.setOperationalEventSink(null);
		}
	});

	it('the flush falls back to the pre-window floor and delivers the whole captured window', () => {
		const sent = [];
		const ws = { send(payload) { sent.push(payload); return 1; }, getUserData() { return {}; } };
		// Pre-window state: the topic had seen seq 5 before the buffer opened.
		state.maxSeenSeq.set('resume-claims-room', 5);
		try {
			const handle = resumeBuffer.beginResumeCapture(['resume-claims-room'], ws);
			expect(handle.entries[0].before).toBe(5);
			// Frames landing in the window; seq 4 was already covered before it.
			handle.entries[0].buffer.frames.push(
				{ seq: 4, envelope: 'covered-before-window', compress: false },
				{ seq: 6, envelope: 'window-six', compress: false },
				{ seq: 7, envelope: 'window-seven', compress: false }
			);
			// No watermark (the unreadable hook's answer): the floor is the
			// pre-window max - the WHOLE window is delivered, nothing is lost,
			// and re-delivery inside it is the documented cost.
			resumeBuffer.flushResumeTopic(handle, 'resume-claims-room', undefined);
			expect(sent).toEqual(['window-six', 'window-seven']);

			// A cooperating hook's exact watermark tightens the same floor.
			sent.length = 0;
			state.maxSeenSeq.set('resume-claims-room', 5);
			const exact = resumeBuffer.beginResumeCapture(['resume-claims-room'], ws);
			exact.entries[0].buffer.frames.push(
				{ seq: 6, envelope: 'window-six', compress: false },
				{ seq: 7, envelope: 'window-seven', compress: false }
			);
			resumeBuffer.flushResumeTopic(exact, 'resume-claims-room', 6);
			expect(sent).toEqual(['window-seven']);
		} finally {
			state.maxSeenSeq.delete('resume-claims-room');
		}
	});
});

describe('ADAPTER-ERR-DIVERGENCE: the minority attribution the restart gate acts on', () => {
	it('a persisted disagreement names the minority; one epoch never fires', () => {
		let now = 0;
		const detector = createStateHashDetector({ epochMs: 100, monotonicNow: () => now });
		const live = [1, 2, 3];

		// First epoch: complete, divergent - but a single epoch can be a
		// boundary artifact and a returned divergence can restart a worker,
		// so it must not fire yet.
		expect(detector.record(1, 10, live, 100)).toBeNull();
		expect(detector.record(2, 10, live, 100)).toBeNull();
		expect(detector.record(3, 99, live, 100)).toBeNull();

		// Second consecutive divergent epoch: the disagreement persisted.
		now += 100;
		expect(detector.record(1, 10, live, 100)).toBeNull();
		expect(detector.record(2, 10, live, 100)).toBeNull();
		const divergence = detector.record(3, 99, live, 100);
		expect(divergence, 'a persisted divergence must be returned').toBeTruthy();
		// The minority is what RESTART_ON_STATE_DIVERGENCE=1 asks to exit;
		// naming the wrong worker would restart a healthy majority member.
		expect(divergence.minorityThreadIds).toEqual([3]);
		expect(divergence.majorityHash).toBe(10);
	});

	it('an agreeing epoch resets the persistence streak', () => {
		let now = 0;
		const detector = createStateHashDetector({ epochMs: 100, monotonicNow: () => now });
		const live = [1, 2];
		expect(detector.record(1, 10, live, 100)).toBeNull();
		expect(detector.record(2, 99, live, 100)).toBeNull();
		now += 100;
		expect(detector.record(1, 10, live, 100)).toBeNull();
		expect(detector.record(2, 10, live, 100)).toBeNull();
		now += 100;
		expect(detector.record(1, 10, live, 100)).toBeNull();
		// Divergent again, but the agreement in between reset the streak.
		expect(detector.record(2, 99, live, 100)).toBeNull();
	});
});
