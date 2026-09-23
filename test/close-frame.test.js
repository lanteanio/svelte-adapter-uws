// The close rule every server surface applies to `ws.end(code, reason)`.
//
// The transports disagree without it: uWS drops an unsendable code to an
// empty close payload (the peer reads 1005), wraps a code past 65535 into the
// sendable range, and cuts a long reason at byte 123 even inside a character,
// so a conforming peer fails the connection instead of reading it; the `ws`
// library behind `vite dev` throws on both. The rule below is what production,
// createTestServer, vite dev and the simulator all send.

import { describe, it, expect } from 'vitest';
import { isUtf8 } from 'node:buffer';
import { closeFrameReason, isSendableCloseCode, guardCloseFrames, MAX_CLOSE_REASON_BYTES } from '../src/runtime/utils/close-frame.js';

describe('isSendableCloseCode', () => {
	it('accepts exactly 1000-1003, 1007-1014 and 3000-4999', () => {
		const sendable = [];
		for (let code = 0; code <= 6000; code++) if (isSendableCloseCode(code)) sendable.push(code);
		const expected = [];
		for (let code = 1000; code <= 1003; code++) expected.push(code);
		for (let code = 1007; code <= 1014; code++) expected.push(code);
		for (let code = 3000; code <= 4999; code++) expected.push(code);
		expect(sendable).toEqual(expected);
	});

	it('refuses what uWS would silently rewrite', () => {
		// 66536 is 1000 after the transport's 16-bit cast; 1000.7 truncates.
		for (const code of [66536, 1000.7, -1000, NaN, Infinity, '4401', 4401n, null]) {
			expect(isSendableCloseCode(code), String(code)).toBe(false);
		}
	});
});

describe('closeFrameReason: the code', () => {
	it('throws a TypeError for a code that cannot be sent, naming it', () => {
		for (const code of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000, 66536, 1000.5]) {
			expect(() => closeFrameReason(code, 'x'), String(code)).toThrow(TypeError);
			expect(() => closeFrameReason(code, 'x')).toThrow(`close code ${code} cannot be sent`);
		}
	});

	it('throws for a code that is not a number, without echoing it', () => {
		expect(() => closeFrameReason('4401', 'x')).toThrow('a close code must be a number; got string');
		expect(() => closeFrameReason(null)).toThrow('got object');
		expect(() => closeFrameReason(4401n)).toThrow('got bigint');
	});

	it('takes no code as a close with no status', () => {
		expect(closeFrameReason(undefined, undefined)).toBeUndefined();
		expect(closeFrameReason(undefined, '')).toBeUndefined();
		expect(closeFrameReason(undefined, new Uint8Array(0))).toBeUndefined();
	});

	it('refuses a reason with no code to carry it', () => {
		expect(() => closeFrameReason(undefined, 'bye')).toThrow('a close reason needs a close code');
		expect(() => closeFrameReason(undefined, new TextEncoder().encode('bye'))).toThrow(TypeError);
	});
});

describe('closeFrameReason: the reason', () => {
	it('passes a short well-formed string through as the same string', () => {
		const reason = 'Server shutting down';
		expect(closeFrameReason(1001, reason)).toBe(reason);
		// 41 three-byte characters are exactly 123 bytes, the most that fits.
		const edge = '\u20ac'.repeat(41);
		expect(closeFrameReason(4000, edge)).toBe(edge);
	});

	it('treats an absent or empty reason as none', () => {
		for (const reason of [undefined, null, '', new Uint8Array(0), new ArrayBuffer(0)]) {
			expect(closeFrameReason(1000, reason)).toBeUndefined();
		}
	});

	it('shortens a long reason at a character boundary, never inside one', () => {
		const cases = [
			['a'.repeat(200), 123],
			['\u00e9'.repeat(100), 122], // two-byte characters: 61 fit
			['\u20ac'.repeat(1000), 123], // three-byte: 41 fit exactly
			['a'.repeat(121) + '\u{1F600}tail', 121], // the four-byte emoji straddles 123
			['a'.repeat(119) + '\u{1F600}tail', 123] // ends exactly on 123
		];
		for (const [reason, bytes] of cases) {
			const sent = closeFrameReason(4000, reason);
			expect(sent).toBeInstanceOf(Uint8Array);
			expect(sent.length, reason.slice(0, 8)).toBe(bytes);
			expect(sent.length).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
			expect(isUtf8(sent)).toBe(true);
			expect(Buffer.from(reason, 'utf8').subarray(0, bytes).equals(Buffer.from(sent))).toBe(true);
		}
	});

	it('sends a lone surrogate as U+FFFD rather than as invalid UTF-8', () => {
		const sent = closeFrameReason(4000, 'ok\uD800ok');
		expect(Buffer.from(sent).toString('hex')).toBe(Buffer.from('ok\ufffdok').toString('hex'));
	});

	it('takes UTF-8 bytes in any buffer shape, and refuses bytes that are not UTF-8', () => {
		const text = new TextEncoder().encode('bin');
		expect(Buffer.from(closeFrameReason(4000, text)).toString()).toBe('bin');
		expect(Buffer.from(closeFrameReason(4000, text.buffer)).toString()).toBe('bin');
		expect(Buffer.from(closeFrameReason(4000, Buffer.from('bin'))).toString()).toBe('bin');
		const view = new DataView(new TextEncoder().encode('xbinx').buffer, 1, 3);
		expect(Buffer.from(closeFrameReason(4000, view)).toString()).toBe('bin');
		expect(() => closeFrameReason(4000, new Uint8Array([0xff, 0xfe]))).toThrow('a close reason must be UTF-8 text');
	});

	it('refuses a reason that is neither text nor bytes', () => {
		expect(() => closeFrameReason(4000, 42)).toThrow('a close reason must be a string or UTF-8 bytes; got number');
		expect(() => closeFrameReason(4000, { toString: () => 'x' })).toThrow('got object');
	});
});

describe('guardCloseFrames', () => {
	function fakeSocketClass() {
		const calls = [];
		class Socket { end(...args) { calls.push(args); } }
		return { Socket, calls };
	}

	it('routes end() through the rule and forwards exactly what should be sent', () => {
		const { Socket, calls } = fakeSocketClass();
		const ws = new Socket();
		guardCloseFrames(ws);
		ws.end();
		ws.end(1000);
		ws.end(1001, 'short');
		ws.end(4000, '\u00e9'.repeat(100));
		expect(calls[0]).toEqual([]);
		expect(calls[1]).toEqual([1000]);
		expect(calls[2]).toEqual([1001, 'short']);
		expect(calls[3][0]).toBe(4000);
		expect(calls[3][1].length).toBe(122);
		expect(() => ws.end(1005, 'x')).toThrow(TypeError);
		expect(calls).toHaveLength(4);
	});

	it('leaves a plain-object socket and Object.prototype alone', () => {
		const calls = [];
		const double = { end(...args) { calls.push(args); } };
		guardCloseFrames(double);
		expect(Object.hasOwn(Object.prototype, 'end')).toBe(false);
		double.end(1005, 'x'); // the double's own end, unguarded
		expect(calls).toEqual([[1005, 'x']]);
	});

	it('guards every socket that shares the prototype, and installs once', () => {
		const { Socket, calls } = fakeSocketClass();
		guardCloseFrames(new Socket());
		const guarded = Socket.prototype.end;
		guardCloseFrames(new Socket());
		expect(Socket.prototype.end).toBe(guarded);
		new Socket().end(4000, 'x');
		expect(calls).toEqual([[4000, 'x']]);
		expect(() => new Socket().end(5000)).toThrow(TypeError);
	});
});
