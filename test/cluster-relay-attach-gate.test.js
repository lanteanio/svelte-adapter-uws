// The primary must not write relay bytes into a worker whose reader is not
// live yet.
//
// The ring is filled from the moment of spawn, but a worker drains only after
// module evaluation, its init hook and warmup. Bytes written before that just
// sit there, and the spill they build reads to the age ceiling - a STALL
// detector - as a worker that stopped draining: under sustained relay traffic
// the 5s ceiling quarantined the still-booting worker, whose respawn landed in
// the same window, converting one crash at relay peak into restart-limit
// exhaustion and a whole-process exit.
//
// Bounding that phase from inside the ring writer was tried first and is the
// wrong shape: the writer cannot tell a slow boot from a dead one, so any
// deadline it applied was either shorter than a legitimate init hook - the
// same respawn loop, just later - or too long to be worth having. The primary
// CAN tell, because the worker reports it. So the fan-out asks.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relayEligible, relayRingEligible } from '../src/runtime/relay-spill-policy.js';

const INDEX_SOURCE = readFileSync(fileURLToPath(new URL('../src/runtime/index.js', import.meta.url)), 'utf8');

describe('relay ring attach gate', () => {
	it('refuses a worker that has not reported its reader live', () => {
		expect(relayRingEligible({ relayAttached: false, relayQuarantined: false })).toBe(false);
		expect(relayRingEligible({ relayAttached: true, relayQuarantined: false })).toBe(true);
	});

	it('keeps every refusal relayEligible already made', () => {
		// Attachment is an ADDITIONAL question, not a replacement: a quarantined
		// worker stays refused whether or not it ever attached, or a peer being
		// torn down would start receiving relay traffic again the moment this
		// predicate was reached for it.
		expect(relayRingEligible({ relayAttached: true, relayQuarantined: true })).toBe(false);
		expect(relayRingEligible({ relayAttached: false, relayQuarantined: true })).toBe(false);
		for (const attached of [false, true]) {
			for (const quarantined of [false, true]) {
				const meta = { relayAttached: attached, relayQuarantined: quarantined };
				if (!relayEligible(meta)) {
					expect(relayRingEligible(meta), `quarantined=${quarantined} must stay refused`).toBe(false);
				}
			}
		}
	});

	it('leaves the postMessage lane ungated, because that lane replays through the boot backlog', () => {
		// A worker buffers control-lane messages that arrive during boot and
		// replays them in arrival order once its graph is up, so a postMessage
		// relay reaches a booting worker intact - and with
		// CLUSTER_RELAY_RING_KB=0 it is the ONLY lane. Gating it would drop
		// those frames outright, which is a regression the ring gate does not
		// need and must not cause. Pinned on the source because the asymmetry
		// is the whole design decision, and a well-meant "make it consistent"
		// edit is exactly what would undo it.
		const ringForward = INDEX_SOURCE.match(/if \(w !== worker && m\.ringWriter !== null && ([A-Za-z]+)\(m\)\)/);
		expect(ringForward, 'the ring forward loop no longer matches its known shape').not.toBeNull();
		expect(ringForward[1], 'the ring lane must consult the attach-aware predicate').toBe('relayRingEligible');

		const postMessageForwards = [...INDEX_SOURCE.matchAll(/if \(w !== worker && ([A-Za-z]+)\(m\)\) w\.postMessage/g)];
		expect(postMessageForwards.length, 'expected the three postMessage relay forwards').toBe(3);
		for (const forward of postMessageForwards) {
			expect(forward[1], 'a postMessage forward must NOT be attach-gated').toBe('relayEligible');
		}
	});

	it('starts every worker slot unattached and flips it only on the worker signal', () => {
		// A respawn gets a fresh slot, so the flag cannot be inherited from the
		// worker being replaced - which would hand the replacement's ring the
		// very backlog this gate exists to prevent.
		expect(INDEX_SOURCE).toContain('relayAttached: false');
		expect(INDEX_SOURCE).toMatch(/msg\.type === 'relay-attached'[\s\S]{0,400}?meta\.relayAttached = true/);
		// And the worker announces it only after the reader is actually started,
		// so the first frame the primary sends has somewhere to drain to.
		const attachIndex = INDEX_SOURCE.indexOf('relayReader.start()');
		const announceIndex = INDEX_SOURCE.indexOf("postMessage({ type: 'relay-attached' })");
		expect(attachIndex, 'relayReader.start() not found').toBeGreaterThan(-1);
		expect(announceIndex, 'the worker never announces its attach').toBeGreaterThan(-1);
		expect(announceIndex, 'the attach is announced before the reader starts').toBeGreaterThan(attachIndex);
	});
});
