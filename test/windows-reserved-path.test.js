// The Windows reserved-character gate (src/runtime/utils/windows-path.js)
// that handler/request.js applies ahead of every decoding lane on win32.
//
// The refusal used to read the RAW pathname only, so `/x%3Ay` passed a gate
// that refused `/x:y`, and reached the prerendered lookup, SvelteKit's router
// and `read()` - all of which decode first - as the same alternate-data-stream
// path. The predicate is pure so it runs on every platform; the win32-only
// wiring is driven against the built runtime in test/http-request-lanes.test.js.

import { describe, it, expect } from 'vitest';
import { windowsReservedPath } from '../src/runtime/utils/windows-path.js';

describe('windowsReservedPath', () => {
	it('refuses the raw spellings it always refused', () => {
		expect(windowsReservedPath('/file.txt:stream')).toBe(true);
		expect(windowsReservedPath('/LONGFI~1.TXT')).toBe(true);
		expect(windowsReservedPath('/a/b:c/d')).toBe(true);
	});

	it('refuses the encoded spellings the decoding lanes would open', () => {
		expect(windowsReservedPath('/file.txt%3Astream')).toBe(true);
		expect(windowsReservedPath('/file.txt%3astream')).toBe(true);
		expect(windowsReservedPath('/LONGFI%7E1.TXT')).toBe(true);
		expect(windowsReservedPath('/LONGFI%7e1.TXT')).toBe(true);
		// Percent-encoded elsewhere in the path, reserved byte encoded too.
		expect(windowsReservedPath('/caf%C3%A9%3Ax')).toBe(true);
	});

	it('passes ordinary paths, encoded or not', () => {
		expect(windowsReservedPath('/')).toBe(false);
		expect(windowsReservedPath('/about')).toBe(false);
		expect(windowsReservedPath('/_app/immutable/chunk.js')).toBe(false);
		expect(windowsReservedPath('/caf%C3%A9')).toBe(false);
		expect(windowsReservedPath('/a%20b')).toBe(false);
		expect(windowsReservedPath('/a%2Fb')).toBe(false);
	});

	it('a double encoding decodes to the encoded form, which is not the reserved byte', () => {
		// The lanes decode once; `%253A` becomes the literal `%3A`, which no
		// filesystem call reads as a colon.
		expect(windowsReservedPath('/x%253Ay')).toBe(false);
	});

	it('leaves a path that does not decode to the lanes that refuse it', () => {
		expect(windowsReservedPath('/x%')).toBe(false);
		expect(windowsReservedPath('/x%ZZ')).toBe(false);
		expect(windowsReservedPath('/x%E0%80')).toBe(false);
		// Unless the raw spelling is already reserved.
		expect(windowsReservedPath('/x:%')).toBe(true);
	});
});
