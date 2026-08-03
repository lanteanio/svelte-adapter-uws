import { describe, expect, it } from 'vitest';
import { send500 } from '../src/runtime/handler/http-helpers.js';

describe('owned HTTP 500 request correlation', () => {
	it('echoes the resolved request id without changing the body', () => {
		const calls = [];
		const res = {
			cork(fn) { calls.push(['cork']); fn(); },
			writeStatus(value) { calls.push(['status', value]); },
			writeHeader(name, value) { calls.push(['header', name, value]); },
			end(value) { calls.push(['end', value]); }
		};

		send500(/** @type {any} */ (res), 'request-500');

		expect(calls).toContainEqual(['header', 'x-request-id', 'request-500']);
		expect(calls.at(-1)).toEqual(['end', 'Internal Server Error']);
	});

	it('does not invent a response header when no id is available', () => {
		const headers = [];
		const res = {
			cork(fn) { fn(); },
			writeStatus() {},
			writeHeader(name, value) { headers.push([name, value]); },
			end() {}
		};

		send500(/** @type {any} */ (res));

		expect(headers).toEqual([['content-type', 'text/plain']]);
	});
});
