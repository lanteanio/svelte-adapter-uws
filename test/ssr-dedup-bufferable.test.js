import { describe, it, expect } from 'vitest';
import { isDedupBufferable } from '../src/runtime/handler/ssr-dedup.js';

const resp = (headers) => ({ headers: new Headers(headers) });

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
