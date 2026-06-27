// The server-wide wire-id table for shared binary fan-out: one id per shared topic,
// partitioned above the per-connection id space, refcounted by cohort membership.

import { describe, it, expect, afterEach } from 'vitest';
import {
	acquireSharedWireId, releaseSharedWireId, getSharedWireId, _resetSharedWireIds,
	SHARED_WIRE_ID_BASE
} from '../src/runtime/handler/shared-wire-id.js';
import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../src/runtime/utils/caps.js';

describe('shared wire-id table', () => {
	afterEach(() => _resetSharedWireIds());

	it('partitions global ids far above the per-connection id space', () => {
		// The client keeps one id -> topic map per connection, so a global id must
		// never equal a per-connection id. Per-connection ids are monotonic and
		// unreclaimed (wire.js allocWireId), so the base sits at 2^32 - a per-connection
		// counter would exhaust the worker heap (2^32 live byName entries) long before
		// reaching it, and the base is far above the concurrent-subscription cap too.
		expect(SHARED_WIRE_ID_BASE).toBeGreaterThan(MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(acquireSharedWireId('room')).toBe(SHARED_WIRE_ID_BASE);
	});

	it('assigns one stable id per topic and increments per distinct topic', () => {
		const a1 = acquireSharedWireId('a');
		const a2 = acquireSharedWireId('a'); // same topic -> same id, refs now 2
		const b1 = acquireSharedWireId('b');
		expect(a1).toBe(a2);
		expect(b1).toBe(a1 + 1);
		expect(getSharedWireId('a')).toBe(a1);
		expect(getSharedWireId('b')).toBe(b1);
	});

	it('getSharedWireId returns undefined for a topic with no live cohort', () => {
		expect(getSharedWireId('nope')).toBeUndefined();
	});

	it('reclaims the entry only when the last cohort reference is released', () => {
		acquireSharedWireId('a'); // refs 1
		acquireSharedWireId('a'); // refs 2
		releaseSharedWireId('a'); // refs 1
		expect(getSharedWireId('a')).toBe(SHARED_WIRE_ID_BASE);
		releaseSharedWireId('a'); // refs 0 -> reclaimed
		expect(getSharedWireId('a')).toBeUndefined();
	});

	it('retires a reclaimed id - a re-shared topic draws a fresh id, never reused', () => {
		const first = acquireSharedWireId('a');
		releaseSharedWireId('a'); // reclaimed
		const reshared = acquireSharedWireId('a');
		expect(reshared).toBeGreaterThan(first); // monotonic, no reuse
	});

	it('release is a safe no-op for an unknown topic', () => {
		expect(() => releaseSharedWireId('ghost')).not.toThrow();
		expect(getSharedWireId('ghost')).toBeUndefined();
	});
});
