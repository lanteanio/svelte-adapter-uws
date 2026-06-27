// The server-side wire-codec registry (capability -> codec) that the
// cross-worker relay reads to re-encode binary on the receiving worker.

import { describe, it, expect, afterEach } from 'vitest';
import { registerWireCodec, getWireCodec, _resetWireCodecRegistry } from '../src/runtime/handler/codec-registry.js';

describe('wire-codec registry', () => {
	afterEach(() => _resetWireCodecRegistry());

	it('registers a codec under its capability and looks it up', () => {
		const codec = { capability: 'cursor.protocol:3', schemaVersion: 2, encode: () => null };
		registerWireCodec(codec);
		expect(getWireCodec('cursor.protocol:3')).toBe(codec);
	});

	it('returns null for an unknown or non-string capability', () => {
		expect(getWireCodec('nope')).toBe(null);
		expect(getWireCodec(undefined)).toBe(null);
		expect(getWireCodec(42)).toBe(null);
	});

	it('is idempotent - the last registration for a capability wins', () => {
		const v1 = { capability: 'cap:1', schemaVersion: 1, encode: () => null };
		const v2 = { capability: 'cap:1', schemaVersion: 1, encode: () => null };
		registerWireCodec(v1);
		registerWireCodec(v2);
		expect(getWireCodec('cap:1')).toBe(v2);
	});

	it('ignores a codec with no string capability', () => {
		registerWireCodec(null);
		registerWireCodec({ schemaVersion: 1, encode: () => null });
		registerWireCodec({ capability: 7, encode: () => null });
		expect(getWireCodec('7')).toBe(null);
	});

	it('reset clears the registry', () => {
		registerWireCodec({ capability: 'cap:x', schemaVersion: 1, encode: () => null });
		_resetWireCodecRegistry();
		expect(getWireCodec('cap:x')).toBe(null);
	});
});
