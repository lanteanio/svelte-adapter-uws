// Characterization tests for the cursor-store merge extracted into
// plugins/cursor/decode.js. They pin the catalog / join / update / bulk /
// remove semantics, the user/position output join, and the maxAge sweep so a
// future refactor of either the store or the merge cannot drift the two apart.
// These assert the exact state the inline merge in plugins/cursor/client.js
// produced before extraction (positionMap / userMap / output Map), so a
// regression in either side surfaces here.

import { describe, it, expect } from 'vitest';
import { applyEvent, mergeOutput, sweepExpired } from '../src/plugins/cursor/decode.js';

function newState() {
	return { positionMap: new Map(), userMap: new Map(), timestamps: new Map() };
}

// Apply a fixed frame sequence at a pinned time so the timestamps (and thus the
// sweep) are deterministic. Returns the state plus the per-frame re-emit flags.
function applySequence(state, frames, now) {
	return frames.map((f) => applyEvent(state, f, now));
}

const SEQUENCE = [
	{ event: 'catalog', data: [{ key: 'a', user: { name: 'Ann' } }, { key: 'b', user: { name: 'Bo' } }] },
	{ event: 'join', data: { key: 'c', user: { name: 'Cy' } } },
	{ event: 'update', data: { key: 'a', data: { x: 1, y: 2 } } },
	{ event: 'bulk', data: [{ key: 'b', data: { x: 3, y: 4 } }, { key: 'c', data: { x: 5, y: 6 } }] },
	{ event: 'remove', data: { key: 'b' } }
];

describe('cursor decode applyEvent', () => {
	it('produces the exact positionMap / userMap for a fixed catalog/join/update/bulk/remove sequence', () => {
		const state = newState();
		applySequence(state, SEQUENCE, 1000);

		// catalog seeded a + b, join added c, remove dropped b from both Maps.
		expect([...state.userMap]).toEqual([
			['a', { name: 'Ann' }],
			['c', { name: 'Cy' }]
		]);
		// update set a, bulk set b + c, remove dropped b's position.
		expect([...state.positionMap]).toEqual([
			['a', { x: 1, y: 2 }],
			['c', { x: 5, y: 6 }]
		]);
		// remove cleared b's timestamp too; a + c stamped at the pinned time.
		expect([...state.timestamps]).toEqual([
			['a', 1000],
			['c', 1000]
		]);
	});

	it('builds the merged output skipping a position whose user is unknown', () => {
		const state = newState();
		applySequence(state, SEQUENCE, 1000);
		const merged = mergeOutput(state);
		expect([...merged]).toEqual([
			['a', { user: { name: 'Ann' }, data: { x: 1, y: 2 } }],
			['c', { user: { name: 'Cy' }, data: { x: 5, y: 6 } }]
		]);
	});

	it('hides a position whose user has not been seen via catalog/join', () => {
		const state = newState();
		// A position arrives with no roster entry: tracked internally but never
		// surfaced in the output until a catalog/join supplies the user.
		applyEvent(state, { event: 'update', data: { key: 'ghost', data: { x: 9, y: 9 } } }, 1000);
		expect(mergeOutput(state).size).toBe(0);
		expect(state.positionMap.has('ghost')).toBe(true);

		applyEvent(state, { event: 'join', data: { key: 'ghost', user: { name: 'G' } } }, 1000);
		expect([...mergeOutput(state)]).toEqual([['ghost', { user: { name: 'G' }, data: { x: 9, y: 9 } }]]);
	});

	it('catalog replaces the whole roster', () => {
		const state = newState();
		applyEvent(state, { event: 'catalog', data: [{ key: 'a', user: 1 }, { key: 'b', user: 2 }] }, 1000);
		applyEvent(state, { event: 'catalog', data: [{ key: 'b', user: 22 }, { key: 'd', user: 4 }] }, 1000);
		expect([...state.userMap]).toEqual([['b', 22], ['d', 4]]);
	});

	it('reports the re-emit flag per frame (true for a real change, false for a no-op)', () => {
		const state = newState();
		// A null frame and a malformed entry are no-ops; the real frames re-emit.
		expect(applyEvent(state, null, 1000)).toBe(false);
		expect(applyEvent(state, { event: 'join', data: { key: 7, user: {} } }, 1000)).toBe(false);
		expect(applyEvent(state, { event: 'update', data: { key: 42, data: {} } }, 1000)).toBe(false);
		expect(applyEvent(state, { event: 'remove', data: { key: 'absent' } }, 1000)).toBe(false);
		expect(applyEvent(state, { event: 'join', data: { key: 'a', user: {} } }, 1000)).toBe(true);
		expect(applyEvent(state, { event: 'update', data: { key: 'a', data: { x: 0, y: 0 } } }, 1000)).toBe(true);
		expect(applyEvent(state, { event: 'catalog', data: [] }, 1000)).toBe(true);
		expect(applyEvent(state, { event: 'bulk', data: [] }, 1000)).toBe(true);
	});

	it('remove returns false when it clears nothing', () => {
		const state = newState();
		expect(applyEvent(state, { event: 'remove', data: { key: 'nope' } }, 1000)).toBe(false);
	});
});

describe('cursor decode sweepExpired', () => {
	it('drops entries older than maxAge and reports a position was removed', () => {
		const state = newState();
		applyEvent(state, { event: 'catalog', data: [{ key: 'a', user: 1 }] }, 1000);
		applyEvent(state, { event: 'update', data: { key: 'a', data: { x: 1, y: 1 } } }, 1000);
		applyEvent(state, { event: 'join', data: { key: 'b', user: 2 } }, 5000);
		applyEvent(state, { event: 'update', data: { key: 'b', data: { x: 2, y: 2 } } }, 5000);

		// At now=5500 with maxAge=1000, a (ts 1000) is stale, b (ts 5000) survives.
		const changed = sweepExpired(state, 1000, 5500);
		expect(changed).toBe(true);
		expect([...state.positionMap]).toEqual([['b', { x: 2, y: 2 }]]);
		expect([...state.userMap]).toEqual([['b', 2]]);
		expect([...state.timestamps]).toEqual([['b', 5000]]);
	});

	it('is a no-op for a non-positive maxAge', () => {
		const state = newState();
		applyEvent(state, { event: 'update', data: { key: 'a', data: {} } }, 1000);
		expect(sweepExpired(state, 0, 99999)).toBe(false);
		expect(sweepExpired(state, -1, 99999)).toBe(false);
		expect(state.positionMap.size).toBe(1);
	});

	it('returns false when an expired entry had no position to drop', () => {
		const state = newState();
		// A user-only entry (join with no following position) has no timestamp, so
		// the sweep never touches it: it was never in the output to begin with.
		applyEvent(state, { event: 'join', data: { key: 'a', user: 1 } }, 1000);
		expect(sweepExpired(state, 1000, 5000)).toBe(false);
		expect(state.userMap.has('a')).toBe(true);
	});
});
