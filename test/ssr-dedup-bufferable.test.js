import { describe, it, expect } from 'vitest';
import { declaresBodyPastCap, isDedupBufferable, readBodyUpTo } from '../files/utils.js';

const resp = (headers) => ({ headers: new Headers(headers) });

describe('declaresBodyPastCap', () => {
	it('rules sharing out from a declared length past the cap, and nothing else', () => {
		expect(declaresBodyPastCap(resp({ 'content-length': '1000' }), 999)).toBe(true);
		expect(declaresBodyPastCap(resp({ 'content-length': '999' }), 999)).toBe(false);
		expect(declaresBodyPastCap(resp({}), 999)).toBe(false);
		// A length that is not a number decides nothing; the body is read instead.
		expect(declaresBodyPastCap(resp({ 'content-length': 'abc' }), 999)).toBe(false);
	});
});

describe('readBodyUpTo', () => {
	const stream = (chunks, onCancel) => new ReadableStream({
		pull(controller) {
			const next = chunks.shift();
			if (next === undefined) controller.close();
			else controller.enqueue(next);
		},
		cancel(reason) { onCancel?.(reason); }
	});
	const bytes = (n, fill) => new Uint8Array(n).fill(fill);

	it('returns the whole body when it ends within the cap', async () => {
		const read = await readBodyUpTo(stream([bytes(3, 1), bytes(4, 2)]), 100);
		expect(read.complete).toBe(true);
		if (read.complete) expect([...read.bytes]).toEqual([1, 1, 1, 2, 2, 2, 2]);
	});

	it('a body exactly at the cap is within it', async () => {
		const read = await readBodyUpTo(stream([bytes(5, 1), bytes(5, 2)]), 10);
		expect(read.complete).toBe(true);
	});

	it('stops reading the moment the cap is passed, and the stream replays what was read then continues', async () => {
		const pulled = [];
		const source = new ReadableStream({
			pull(controller) {
				pulled.push(pulled.length);
				if (pulled.length <= 5) controller.enqueue(bytes(4, pulled.length));
				else controller.close();
			}
		});
		const read = await readBodyUpTo(source, 6);
		expect(read.complete).toBe(false);
		// Two chunks (8 bytes) pass a cap of 6; the third was never asked for.
		// One extra pull is the stream's own read-ahead, never more.
		expect(pulled.length).toBeLessThanOrEqual(3);
		if (read.complete) return;
		const out = [];
		const reader = read.stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out.push(...value);
		}
		expect(out).toEqual([...bytes(4, 1), ...bytes(4, 2), ...bytes(4, 3), ...bytes(4, 4), ...bytes(4, 5)]);
	});

	it('cancelling the continuation cancels the source', async () => {
		let cancelled = null;
		const read = await readBodyUpTo(stream([bytes(8, 1), bytes(8, 2), bytes(8, 3)], (reason) => { cancelled = reason; }), 4);
		expect(read.complete).toBe(false);
		if (read.complete) return;
		await read.stream.cancel('client gone');
		expect(cancelled).toBe('client gone');
	});
});

describe('isDedupBufferable (SSR dedup gate)', () => {
	it('refuses to buffer an SSE (text/event-stream) response - it never ends', () => {
		expect(isDedupBufferable(resp({ 'content-type': 'text/event-stream' }))).toBe(false);
		expect(isDedupBufferable(resp({ 'content-type': 'text/event-stream; charset=utf-8' }))).toBe(false);
	});

	it('is case-insensitive on the content-type', () => {
		expect(isDedupBufferable(resp({ 'content-type': 'Text/Event-Stream' }))).toBe(false);
	});

	it('buffers a normal rendered page even WITHOUT a content-length (the SvelteKit case)', () => {
		// SvelteKit dynamically-rendered pages carry no content-length; they must
		// still be shareable, or dedup becomes a no-op for its primary workload
		// (the thundering herd of identical anonymous GETs).
		expect(isDedupBufferable(resp({ 'content-type': 'text/html; charset=utf-8' }))).toBe(true);
		expect(isDedupBufferable(resp({ 'content-type': 'text/html', 'content-length': '4096' }))).toBe(true);
	});

	it('buffers other finite body types (json, plain text, or no content-type)', () => {
		expect(isDedupBufferable(resp({ 'content-type': 'application/json' }))).toBe(true);
		expect(isDedupBufferable(resp({ 'content-type': 'text/plain' }))).toBe(true);
		expect(isDedupBufferable(resp({}))).toBe(true);
	});
});
