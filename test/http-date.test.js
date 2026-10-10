import { afterEach, describe, expect, it } from 'vitest';
import { parseHttpDate } from '../src/runtime/utils/http-date.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/runtime/runtime.js';

afterEach(resetRuntimeEnv);

describe('HTTP date grammar', () => {
	it.each([
		'Sun, 06 Nov 1994 08:49:37 GMT',
		'Sunday, 06-Nov-94 08:49:37 GMT',
		'Sun Nov  6 08:49:37 1994',
		'Sun Nov 06 08:49:37 1994'
	])('accepts %s', (value) => {
		setRuntimeEnv({ clock: { now: () => Date.UTC(2026, 9, 10) } });
		expect(parseHttpDate(value)).toBe(784111777000);
	});
	it.each([
		'1994-11-06T08:49:37Z', '2026-10-03', 'November 6, 1994',
		'06 Nov 1994 08:49:37 GMT', 'Sun, 6 Nov 1994 08:49:37 GMT',
		'sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37 UTC',
		'Sun, 06 Nov 1994 08:49:37 +0000', 'Sun, 06 Nov 1994 24:00:00 GMT',
		'Sun, 06 Nov 1994 08:60:00 GMT', 'Sun, 06 Nov 1994 08:49:61 GMT',
		'Thu, 30 Feb 2026 08:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37 GMT\n',
		'Sun, 06 Nov 1994 08:49:37 GMT, Sun, 06 Nov 1994 08:49:37 GMT',
		'Mon, 06 Nov 1994 08:49:37 GMT', 'Sun Nov 6 08:49:37 1994', 'Sun, 01 Jan 1899 00:00:00 GMT'
	])('ignores %s', (value) => {
		expect(parseHttpDate(value)).toBeNaN();
	});
	it('uses the exact rolling boundary for two-digit years', () => {
		setRuntimeEnv({ clock: { now: () => Date.UTC(2026, 0, 2, 3, 4, 5) } });
		expect(parseHttpDate('Thursday, 02-Jan-76 03:04:05 GMT')).toBe(Date.UTC(2076, 0, 2, 3, 4, 5));
		expect(parseHttpDate('Friday, 02-Jan-76 03:04:06 GMT')).toBe(Date.UTC(1976, 0, 2, 3, 4, 6));
		expect(parseHttpDate('Wednesday, 02-Jan-75 03:04:05 GMT')).toBe(Date.UTC(2075, 0, 2, 3, 4, 5));
	});
	it('resolves two-digit years across a century boundary', () => {
		setRuntimeEnv({ clock: { now: () => Date.UTC(2090, 0, 1) } });
		expect(parseHttpDate('Friday, 01-Jan-00 00:00:00 GMT')).toBe(Date.UTC(2100, 0, 1));
		expect(parseHttpDate('Friday, 01-Jan-40 00:00:00 GMT')).toBe(Date.UTC(2140, 0, 1));
		expect(parseHttpDate('Monday, 02-Jan-40 00:00:00 GMT')).toBe(Date.UTC(2040, 0, 2));
	});
	it('retains a leap second and accepts a leap day without normalizing an impossible one', () => {
		expect(parseHttpDate('Sat, 31 Dec 2016 23:59:60 GMT')).toBe(1483228800000);
		expect(parseHttpDate('Thu, 29 Feb 2024 00:00:00 GMT')).toBe(1709164800000);
		expect(parseHttpDate('Wed, 29 Feb 2023 00:00:00 GMT')).toBeNaN();
	});
});
