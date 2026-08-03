// Guards for the structural invariant sites promoted from the soft tier
// (`assert`) to the hard tier (`fatal`). These sites live in the production
// dispatch (src/runtime/handler.js and src/runtime/handler/platform.js), which
// is built against rollup-injected globals (WS_HANDLER / MANIFEST / ...) and so
// cannot be imported at runtime in vitest. The full unit suite and the e2e
// prod.spec.js prove the HEALTHY path never trips these (a fatal throws in test
// mode, so any spurious fire fails a green run). Here we pin two things:
//
//   1. each promoted site is wired to `fatal(` with its exact category and is no
//      longer a soft `assert(` (a source-level guard against a future refactor
//      silently demoting a worker-killing invariant back to a log line), and
//   2. the `fatal` contract each site relies on: the falsy structural condition
//      raises (the corrupt-state direction), and the truthy/healthy condition is
//      a silent no-op (no spurious worker kill).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fatal, readAssertionCounts, _resetAssertionCountsForTest } from '../src/runtime/utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handlerSrc = readFileSync(path.join(ROOT, 'src/runtime/handler.js'), 'utf8');
const platformSrc = readFileSync(path.join(ROOT, 'src/runtime/handler/platform.js'), 'utf8');
const testingSrc = readFileSync(path.join(ROOT, 'src/testing.js'), 'utf8');

// Each promoted site: the source file it lives in and the structural-corruption
// condition the site guards. The condition is the EXACT expression at the site,
// so the runtime contract test below exercises the same shape the dispatch does.
const PROMOTED = [
	{
		category: 'ws.platform-double-init',
		src: () => handlerSrc,
		corrupt: () => { const ud = { WS_PLATFORM: {} }; return !ud.WS_PLATFORM; },
		healthy: () => { const ud = {}; return !ud.WS_PLATFORM; }
	},
	{
		category: 'ws.platform-missing-in-message',
		src: () => handlerSrc,
		corrupt: () => ({}).WS_PLATFORM,
		healthy: () => ({ WS_PLATFORM: {} }).WS_PLATFORM
	},
	{
		category: 'ws.connection-permit-carrier',
		src: () => [handlerSrc, testingSrc],
		corrupt: () => false,
		healthy: () => true
	},
	{
		category: 'subs.shape',
		src: () => [handlerSrc, platformSrc],
		corrupt: () => 'not-a-set' instanceof Set,
		healthy: () => new Set() instanceof Set
	},
	{
		category: 'envelope.empty',
		src: () => platformSrc,
		corrupt: () => ''.length > 0,
		healthy: () => '{"topic":"x"}'.length > 0
	}
];

describe('promoted fatal sites - source wiring', () => {
	it('every promoted site is a fatal() call with its category, not a soft assert', () => {
		for (const { category, src } of PROMOTED) {
			const sources = [].concat(src());
			const fatalRe = new RegExp("fatal\\([^;]*'" + category.replace(/[.]/g, '\\.') + "'");
			const assertRe = new RegExp("assert\\([^;]*'" + category.replace(/[.]/g, '\\.') + "'");
			const hasFatal = sources.some((s) => fatalRe.test(s));
			const hasSoftAssert = sources.some((s) => assertRe.test(s));
			expect(hasFatal, `${category} should be a fatal() call`).toBe(true);
			expect(hasSoftAssert, `${category} must no longer be a soft assert()`).toBe(false);
		}
	});

	it('the production message-subscribe path no longer carries the soft subs.shape assert', () => {
		// The promoted subscribe sites read `subs instanceof Set` and now escalate.
		// The sibling shape-unsubscribe / shape-batch categories are intentionally
		// left soft (concurrency edges), so they must still be soft asserts.
		expect(/fatal\(subs instanceof Set, 'subs\.shape', null\)/.test(handlerSrc)).toBe(true);
		expect(/fatal\(subs instanceof Set, 'subs\.shape', null\)/.test(platformSrc)).toBe(true);
		expect(/assert\([^;]*'subs\.shape-unsubscribe'/.test(platformSrc)).toBe(true);
		expect(/assert\([^;]*'subs\.shape-batch'/.test(handlerSrc)).toBe(true);
	});

	it('subs.total-negative stays SOFT (a transient close-path dip must not kill a worker)', () => {
		// Deliberately excluded from promotion and from hardCategories. Every
		// membership lane now reaches the one accounting hook in handler.js, so
		// platform.js must not carry a second copy of the assertion.
		expect(/assert\([^;]*'subs\.total-negative'/.test(handlerSrc)).toBe(true);
		expect(/assert\([^;]*'subs\.total-negative'/.test(platformSrc)).toBe(false);
		expect(/fatal\([^;]*'subs\.total-negative'/.test(handlerSrc)).toBe(false);
		expect(/fatal\([^;]*'subs\.total-negative'/.test(platformSrc)).toBe(false);
	});

	it('production and the test harness both stop before app open on a missing connection carrier', () => {
		for (const source of [handlerSrc, testingSrc]) {
			expect(source).toMatch(/fatal\(permitRestored, 'ws\.connection-permit-carrier', null\);\s*if \(!permitRestored\) return;/);
		}
	});

	it('the send-site and batch envelope guards stay SOFT (distinct categories, out of scope)', () => {
		expect(/assert\([^;]*'envelope\.send-empty'/.test(platformSrc)).toBe(true);
		expect(/fatal\([^;]*'envelope\.send-empty'/.test(platformSrc)).toBe(false);
	});
});

describe('promoted fatal sites - runtime contract', () => {
	beforeEach(() => { _resetAssertionCountsForTest(); });

	it('fires (throws in test mode) on the corrupt structural condition for each category', () => {
		for (const { category, corrupt } of PROMOTED) {
			expect(() => fatal(corrupt(), category, null), `${category} should fire on corruption`).toThrow(
				new RegExp('adapter-uws fatal: ' + category.replace(/[.]/g, '\\.'))
			);
			expect(readAssertionCounts().get(category)).toBeGreaterThan(0);
		}
	});

	it('is a silent no-op on the healthy condition for each category (no spurious worker kill)', () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const { category, healthy } of PROMOTED) {
			expect(() => fatal(healthy(), category, null), `${category} must not fire when healthy`).not.toThrow();
		}
		expect(readAssertionCounts().size).toBe(0);
		errSpy.mockRestore();
	});
});
