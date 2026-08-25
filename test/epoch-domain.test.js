// The per-process epoch is an OPAQUE token, not a timestamp.
//
// It was a wall-clock epoch-ms latch, which handed every unauthenticated
// client the process start time (uptime, deploy timing, a correlation
// fingerprint across sockets). It is now a random 32-bit integer from the
// runtime RNG seam. Both are opaque generation tokens to a correct client -
// only equality across a reconnect matters, and resume.test.js pins that
// treatment end to end, including with string epochs to prove nothing
// interprets the value. These tests pin the DOMAIN of the value the server
// latches: it comes from the RNG, carries no time, changes across a restart,
// and stays a wire-legal integer. The opaque contract is also stated in the
// protocol schema, pinned here so a future edit cannot silently drop it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { processEpoch, resetProcessEpoch } from '../src/runtime/utils/epoch.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

afterEach(() => {
	resetRuntimeEnv();
	resetProcessEpoch();
});

describe('the per-process epoch domain', () => {
	it('latches the RNG value, not the wall clock', () => {
		// A distinctive wall clock AND a distinctive u32: if the latch read the
		// clock, the result would be the epoch-ms; it reads the RNG instead.
		setRuntimeEnv({
			clock: { wallEpoch: () => 1_700_000_000_000 },
			rng: { u32: () => 305419896 }
		});
		resetProcessEpoch();
		const epoch = processEpoch();
		expect(epoch).toBe(305419896);
		expect(epoch).not.toBe(1_700_000_000_000);
	});

	it('is a wire-legal 32-bit unsigned integer', () => {
		for (const value of [0, 1, 2_147_483_648, 4_294_967_295]) {
			setRuntimeEnv({ rng: { u32: () => value } });
			resetProcessEpoch();
			const epoch = processEpoch();
			expect(Number.isInteger(epoch)).toBe(true);
			expect(epoch).toBeGreaterThanOrEqual(0);
			expect(epoch).toBeLessThanOrEqual(0xffffffff);
			resetRuntimeEnv();
		}
	});

	it('is latched once and constant within a process, and re-latches across a restart', () => {
		let handed = 111;
		setRuntimeEnv({ rng: { u32: () => handed } });
		resetProcessEpoch();
		const first = processEpoch();
		handed = 222; // the RNG would give a new value, but the latch holds
		expect(processEpoch()).toBe(first);
		// A restart is the only thing that re-reads: reset, then a fresh boot's
		// RNG hands a different value and the token changes.
		resetProcessEpoch();
		expect(processEpoch()).toBe(222);
		expect(processEpoch()).not.toBe(first);
	});

	it('is reproducible after reset under a seeded RNG, for controlled simulations', () => {
		const seeded = [7, 7, 7];
		let i = 0;
		setRuntimeEnv({ rng: { u32: () => seeded[i++ % seeded.length] } });
		resetProcessEpoch();
		const a = processEpoch();
		resetProcessEpoch();
		const b = processEpoch();
		// Same seeded value handed each latch -> the same reproducible epoch,
		// which is what lets a simulation replay a schedule deterministically.
		expect(a).toBe(7);
		expect(b).toBe(7);
	});
});

describe('the protocol schema states the epoch is opaque', () => {
	it('describes both epoch fields as an equality-only, non-timestamp token', () => {
		const schemaPath = fileURLToPath(new URL('../protocol.schema.json', import.meta.url));
		const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
		const subscribed = schema.$defs.subscribed.properties.epoch;
		const recoverOne = schema.$defs['recover-one'].properties.epoch;
		for (const field of [subscribed, recoverOne]) {
			expect(field.type).toBe('integer');
			expect(field.description).toMatch(/opaque/i);
			expect(field.description).toMatch(/never a timestamp/i);
			expect(field.description).toMatch(/equality only/i);
		}
	});
});
