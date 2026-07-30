// A subscribeBatch hook receives a caller-owned list, not the handler's
// internal landing queue.
//
// The no-pre-denial path used to alias `hookTopics` directly to `valid`.
// Mutating the hook argument then mutated the queue the handler still needed
// to settle: a hook that emptied the array left every ref'd topic unanswered
// and every pending-subscribe entry stranded for the connection's lifetime.
// The pre-denied path happened to be safe because Array#filter made a copy,
// so the same hook changed behaviour solely with grant-gate state.

import { afterEach, describe, expect, it } from 'vitest';
import { WS_PENDING_SUBSCRIBES } from '../src/runtime/utils/ws-symbols.js';

/** @type {Awaited<ReturnType<import('../src/testing.js').createTestServer>> | null} */
let server = null;
/** @type {import('ws').WebSocket | null} */
let client = null;

afterEach(async () => {
	try { client?.terminate(); } catch { /* already closed */ }
	client = null;
	await server?.close();
	server = null;
});

async function waitFor(frames, predicate, ms = 1500) {
	const deadline = Date.now() + ms;
	for (;;) {
		for (const raw of frames) {
			let frame = null;
			try { frame = JSON.parse(raw); } catch { /* non-JSON */ }
			if (predicate(frame)) return frame;
		}
		if (Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('subscribeBatch hook input isolation', () => {
	it('settles the original topics even when the hook mutates its argument', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let capturedWs = null;
		let hookTopics = null;

		server = await createTestServer({
			handler: {
				open(ws) { capturedWs = ws; },
				subscribeBatch(_ws, topics) {
					hookTopics = topics;
					// A caller is allowed to treat its argument as ordinary mutable
					// application data. This must not erase the handler's landing queue.
					topics.length = 0;
					return {};
				}
			}
		});

		const { WebSocket } = await import('ws');
		client = new WebSocket(server.wsUrl);
		const frames = [];
		client.on('message', (data) => frames.push(data.toString()));
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});

		client.send(JSON.stringify({
			type: 'subscribe-batch',
			topics: ['room'],
			ref: 41
		}));

		const answer = await waitFor(
			frames,
			(frame) => frame?.ref === 41 && frame?.topic === 'room'
		);
		expect(hookTopics, 'the hook must have run').toEqual([]);
		expect(answer, 'mutating hook input must not erase the original landing').toMatchObject({
			type: 'subscribed',
			topic: 'room',
			ref: 41
		});

		const pending = capturedWs?.getUserData()?.[WS_PENDING_SUBSCRIBES];
		expect(pending?.size ?? 0, 'the original pending enrolment must be settled').toBe(0);
	});
});
