import { describe, expect, it } from 'vitest';
import { staticLastModifiedTime } from '../src/runtime/handler/static-last-modified.js';

describe('static Last-Modified date eligibility', () => {
	const indexedAt = Date.UTC(2026, 9, 10, 12);
	it('rejects dates before the HTTP year boundary independently of filesystem timestamp ranges', () => {
		expect(staticLastModifiedTime(Date.UTC(1899, 11, 31, 23, 59, 59, 999), indexedAt)).toBeUndefined();
		expect(staticLastModifiedTime(Date.UTC(1900, 0, 1), indexedAt)).toBe(Date.UTC(1900, 0, 1));
	});
	it('compares the original mtime to the held indexing clock before rounding seconds', () => {
		expect(staticLastModifiedTime(indexedAt + 1, indexedAt)).toBeUndefined();
		expect(staticLastModifiedTime(indexedAt, indexedAt)).toBe(indexedAt);
		expect(staticLastModifiedTime(indexedAt - 1, indexedAt)).toBe(indexedAt - 1000);
	});
	it('omits non-finite file times', () => {
		for (const value of [NaN, Infinity, -Infinity]) expect(staticLastModifiedTime(value, indexedAt)).toBeUndefined();
	});
});
