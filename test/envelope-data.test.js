// Message data JSON has no form for is refused, never put on the wire.
//
// JSON.stringify throws for a BigInt or a cycle, but returns undefined for a
// function or a symbol, and the envelope builders concatenated that straight
// into the frame: {"topic":..,"event":..,"data":undefined}, which no client can
// parse. Every builder now goes through envelopeData, which throws instead.

import { describe, it, expect, afterEach } from 'vitest';
import { envelopeData, completeEnvelope, completeGameEnvelope } from '../src/runtime/utils/epoch.js';
import { hasUWS } from './helpers/real-runtime.js';

const PREFIX = '{"topic":"t","event":"e","data":';

describe('envelopeData', () => {
	it('refuses a function and a symbol, like a BigInt', () => {
		expect(() => envelopeData(() => 1)).toThrow(TypeError);
		expect(() => envelopeData(Symbol('s'))).toThrow(TypeError);
		expect(() => envelopeData(1n)).toThrow(TypeError);
	});

	it('leaves every JSON value as it was', () => {
		expect(envelopeData({ a: 1 })).toBe('{"a":1}');
		expect(envelopeData(undefined)).toBe('null');
		expect(envelopeData('x')).toBe('"x"');
		expect(JSON.parse(completeEnvelope(PREFIX, { a: 1 }, 3))).toEqual({ topic: 't', event: 'e', data: { a: 1 }, seq: 3 });
	});

	it('guards both envelope builders', () => {
		expect(() => completeEnvelope(PREFIX, () => 1, null)).toThrow(TypeError);
		expect(() => completeGameEnvelope(PREFIX, Symbol('s'), 1, 'id')).toThrow(TypeError);
	});
});

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('a publish with function data on createTestServer', () => {
	let server;
	afterEach(async () => { await server?.close(); server = null; });

	it('throws to the caller instead of sending a malformed frame', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({});
		expect(() => server.platform.publish('room', 'update', () => 1)).toThrow(TypeError);
	});
});
