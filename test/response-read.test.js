import { describe, it, expect } from 'vitest';
import { readReady, readBodyUpTo, responseChunkBytes } from '../files/utils.js';

describe('readReady', () => {
	it('returns a read that is already fulfilled', async () => {
		const reader = new ReadableStream({ start(c) { c.enqueue('a'); c.close(); } }).getReader();
		expect(await readReady(reader)).toEqual({ done: false, value: 'a' });
		expect(await readReady(reader)).toEqual({ done: true, value: undefined });
	});

	it('waits for a read that settles within the current turn', async () => {
		let release;
		const gate = new Promise((r) => (release = r));
		const reader = new ReadableStream({
			async pull(c) { await gate; c.enqueue('late'); }
		}).getReader();
		const active = readReady(reader);
		queueMicrotask(() => queueMicrotask(release));
		expect(await active).toEqual({ done: false, value: 'late' });
	});

	it('hands back a read that needs I/O as pending instead of waiting for it', async () => {
		let push;
		const reader = new ReadableStream({ start(c) { push = (v) => c.enqueue(v); } }).getReader();
		const next = await readReady(reader);
		expect(next).toHaveProperty('pending');
		// The pending read is the stream's next read: nothing is lost.
		setTimeout(() => push('later'), 20);
		expect(await next.pending).toEqual({ done: false, value: 'later' });
	});

	it('rethrows a read that fails within the turn', async () => {
		const reader = new ReadableStream({ start(c) { c.error(new Error('boom')); } }).getReader();
		await expect(readReady(reader)).rejects.toThrow('boom');
	});

	it('does not wait again once the shared allowance is spent', async () => {
		// One deadline covers a whole buffered prefix: a read made after it
		// passed comes back pending at once, before the check phase runs.
		const reader = new ReadableStream({ pull() { return new Promise(() => {}); } }).getReader();
		let checkPhaseRan = false;
		setImmediate(() => { checkPhaseRan = true; });
		const next = await readReady(reader, { spent: true });
		expect(next).toHaveProperty('pending');
		expect(checkPhaseRan).toBe(false);
	});
});

describe('readBodyUpTo cancellation', () => {
	it('exposes a cancel for the read in progress and withdraws it when the read ends', async () => {
		let cancelled = false;
		const body = new ReadableStream({
			pull() { return new Promise(() => {}); },
			cancel() { cancelled = true; }
		});
		const state = { cancelResponse: null };
		const reading = readBodyUpTo(body, 1024, state);
		await Promise.resolve();
		expect(typeof state.cancelResponse).toBe('function');
		state.cancelResponse();
		const read = await reading;
		expect(cancelled).toBe(true);
		expect(read.complete).toBe(true);
		expect(state.cancelResponse).toBe(null);
	});

	it('cancelling the continuation while its read is pending cancels the source', async () => {
		let cancelled = false;
		const body = new ReadableStream({
			start(c) { c.enqueue(new Uint8Array([1])); },
			pull() { return new Promise(() => {}); },
			cancel() { cancelled = true; }
		});
		const read = await readBodyUpTo(body, 1024);
		expect(read.complete).toBe(false);
		if (read.complete) return;
		const reader = read.stream.getReader();
		expect([...(await reader.read()).value]).toEqual([1]);
		const pending = reader.read();
		await reader.cancel('client gone');
		expect(cancelled).toBe(true);
		expect((await pending).done).toBe(true);
	});
});

describe('readBodyUpTo with a body that waits on I/O', () => {
	it('stops at the first chunk that is not ready and replays what it read', async () => {
		let push;
		let close;
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array([1]));
				push = (v) => c.enqueue(v);
				close = () => c.close();
			}
		});
		const read = await readBodyUpTo(body, 1024);
		expect(read.complete).toBe(false);
		if (read.complete) return;
		const reader = read.stream.getReader();
		expect([...(await reader.read()).value]).toEqual([1]);
		setTimeout(() => { push(new Uint8Array([2])); close(); }, 20);
		expect([...(await reader.read()).value]).toEqual([2]);
		expect((await reader.read()).done).toBe(true);
	});

	it('shares a body whose chunks are all ready, even past the first', async () => {
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array([1, 2]));
				c.enqueue('ab');
				c.close();
			}
		});
		const read = await readBodyUpTo(body, 1024);
		expect(read.complete).toBe(true);
		if (read.complete) expect([...read.bytes]).toEqual([1, 2, 97, 98]);
	});
});

describe('responseChunkBytes', () => {
	it('passes a Uint8Array through unchanged', () => {
		const u8 = new Uint8Array([1, 2, 3]);
		expect(responseChunkBytes(u8)).toBe(u8);
	});

	it('encodes a string as UTF-8', () => {
		expect([...responseChunkBytes(String.fromCharCode(0xe4))]).toEqual([0xc3, 0xa4]);
	});

	it('views an ArrayBuffer and any ArrayBuffer view by its own bytes', () => {
		const ab = new Uint8Array([9, 8, 7, 6]).buffer;
		expect([...responseChunkBytes(ab)]).toEqual([9, 8, 7, 6]);
		expect([...responseChunkBytes(new DataView(ab, 1, 2))]).toEqual([8, 7]);
		expect([...responseChunkBytes(new Uint16Array([0x0201]))]).toEqual([1, 2]);
	});

	it('refuses a chunk that has no wire bytes', () => {
		expect(() => responseChunkBytes(42)).toThrow(TypeError);
		expect(() => responseChunkBytes({})).toThrow(TypeError);
	});
});
