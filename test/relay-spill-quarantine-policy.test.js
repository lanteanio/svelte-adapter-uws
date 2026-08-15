// ADAPTER-ERR-RELAY-SPILL-QUARANTINE, driven from the condition it claims.
//
// The entry's consequence promises: the primary stops forwarding relay
// traffic to the worker (every fan-out lane consults relayEligible), asks it
// to exit, latches once per worker, and prints a line naming the reason, the
// dropped bytes, and the pending age. Its automaticRecovery describes a
// REQUEST: quarantine posts a terminate message the worker's event loop must
// process - the policy does not exit the worker itself, and a wedged worker
// is resolved by the exit-grace path a different entry documents. The policy
// is a pure export, so the cases drive it directly with a recording exit
// request and fake workers.

import { describe, it, expect } from 'vitest';
import {
	createRelaySpillQuarantine,
	relayEligible,
	attributeRelayIncident
} from '../src/runtime/relay-spill-policy.js';

function fakeWorker() {
	const posted = [];
	return { posted, postMessage(m) { posted.push(m); } };
}

function build() {
	const worker = fakeWorker();
	const alreadyQuarantined = fakeWorker();
	const sibling = fakeWorker();
	const meta = { threadId: 7, relayQuarantined: false };
	// The quarantined peer sits BEFORE the healthy sibling so the attribution
	// case can only pass by actually skipping it.
	const workers = new Map([
		[worker, meta],
		[alreadyQuarantined, { threadId: 9, relayQuarantined: true }],
		[sibling, { threadId: 8, relayQuarantined: false }]
	]);
	const lines = [];
	const exits = [];
	const quarantine = createRelaySpillQuarantine({
		worker, meta, workers,
		requestWorkerExit: (w, code) => exits.push({ w, code }),
		log: (line) => lines.push(line)
	});
	return { worker, sibling, alreadyQuarantined, meta, workers, lines, exits, quarantine };
}

describe('ADAPTER-ERR-RELAY-SPILL-QUARANTINE', () => {
	it('prints the indexed line naming reason, dropped bytes, and age', () => {
		const { lines, quarantine } = build();
		quarantine({ reason: 'age', droppedBytes: 4096, pendingAgeMs: 5000.6 });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			'[primary] relay spill quarantining worker=7 reason=age droppedBytes=4096 pendingAgeMs=5001'
			+ ' [ADAPTER-ERR-RELAY-SPILL-QUARANTINE]'
		);
	});

	it('a BYTES quarantine prints its own reason, so the next action can branch on the line', () => {
		const { lines, quarantine } = build();
		quarantine({ reason: 'bytes', droppedBytes: 262144, pendingAgeMs: 12 });
		expect(lines[0]).toContain('reason=bytes');
		expect(lines[0]).toContain('droppedBytes=262144');
	});

	it('stops relay forwarding and requests the exit as a message, never exiting the worker itself', () => {
		const { worker, meta, exits, quarantine } = build();
		expect(relayEligible(meta)).toBe(true);
		quarantine({ reason: 'age', droppedBytes: 1, pendingAgeMs: 5000 });
		// Every fan-out lane consults this predicate; false IS "stops forwarding".
		expect(relayEligible(meta)).toBe(false);
		// The exit is a request handed to the exit path - the cooperative half
		// the entry describes. The policy posted nothing to the involved worker
		// and terminated nothing.
		expect(exits).toEqual([{ w: worker, code: 1 }]);
		expect(worker.posted).toEqual([]);
	});

	it('latches once per worker: a second overflow neither logs nor re-requests', () => {
		const { lines, exits, quarantine } = build();
		expect(quarantine({ reason: 'age', droppedBytes: 1, pendingAgeMs: 5000 })).toBe(true);
		expect(quarantine({ reason: 'bytes', droppedBytes: 2, pendingAgeMs: 1 })).toBe(false);
		expect(lines).toHaveLength(1);
		expect(exits).toHaveLength(1);
	});

	it('attributes the incident to a surviving sibling, never the involved or a quarantined peer', () => {
		const { worker, sibling, alreadyQuarantined, quarantine } = build();
		quarantine({ reason: 'age', droppedBytes: 64, pendingAgeMs: 6000 });
		expect(worker.posted).toEqual([]);
		expect(alreadyQuarantined.posted).toEqual([]);
		expect(sibling.posted).toEqual([
			{ type: 'relay-spill-overflow', reason: 'age', droppedBytes: 64, pendingAgeMs: 6000 }
		]);
	});

	it('attribution reports failure when no surviving sibling remains', () => {
		const involved = fakeWorker();
		const meta = { threadId: 3, relayQuarantined: false };
		const workers = new Map([[involved, meta]]);
		expect(attributeRelayIncident(workers, involved, { type: 'relay-spill-overflow' })).toBe(false);
		expect(involved.posted).toEqual([]);
	});
});
