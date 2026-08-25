// The per-topic epoch override: the durable half of the relay-gap resync
// signal. relay-receive-real.test.js proves the end-to-end behaviour (a
// confirmed loss mints a generation and the subscribe ack carries it); this
// file pins the override map's own contract, which the wire cannot show:
// the fallback identity, the recency-ordered bound, and the harness reset.

import { describe, it, expect, afterEach } from 'vitest';
import {
	processEpoch,
	topicEpochValue,
	overrideTopicEpoch,
	resetTopicEpochs
} from '../src/runtime/utils/epoch.js';

afterEach(() => resetTopicEpochs());

describe('topic epoch overrides', () => {
	it('falls back to the process generation until a topic is overridden', () => {
		expect(topicEpochValue('quiet-topic')).toBe(processEpoch());
		overrideTopicEpoch('loud-topic', 12345);
		expect(topicEpochValue('loud-topic')).toBe(12345);
		expect(topicEpochValue('quiet-topic'), 'an override never leaks onto other topics').toBe(processEpoch());
	});

	it('replaces an override in place', () => {
		overrideTopicEpoch('t', 1);
		overrideTopicEpoch('t', 2);
		expect(topicEpochValue('t')).toBe(2);
	});

	it('bounds the map by evicting the longest-undisturbed override', () => {
		// Fill to the cap, refresh a MIDDLE entry, add one more, then keep
		// inserting until the evictions would reach the refreshed entry's
		// ORIGINAL position. A single over-cap insert cannot tell a proper
		// recency refresh from an implementation whose refresh spuriously
		// evicts (or never moves the entry): their end states coincide. Five
		// more inserts separate them - a correct refresh moved cap-5 to the
		// newest end, so the evictions march past its old neighbourhood and
		// take cap-6, while either broken shape loses cap-5 at its original
		// turn.
		for (let i = 0; i < 4096; i++) overrideTopicEpoch('cap-' + i, i);
		overrideTopicEpoch('cap-5', 555555);
		overrideTopicEpoch('cap-one-more', 4096);
		expect(topicEpochValue('cap-0'), 'the longest-undisturbed override is the one evicted').toBe(processEpoch());
		// cap-1 present pins the EXACT cap: one entry under it, the fill loop
		// itself would already have evicted cap-0 and this insert would take
		// cap-1; one entry over it, nothing would be evicted at all.
		expect(topicEpochValue('cap-1'), 'exactly one eviction for exactly one over-cap insert').toBe(1);
		for (let i = 0; i < 5; i++) overrideTopicEpoch('cap-extra-' + i, 5000 + i);
		expect(topicEpochValue('cap-5'), 'the refreshed override outlives its original eviction turn').toBe(555555);
		expect(topicEpochValue('cap-6'), 'the evictions marched past the refreshed entry to its neighbour').toBe(processEpoch());
		expect(topicEpochValue('cap-one-more')).toBe(4096);
		expect(topicEpochValue('cap-4095'), 'entries inside the cap are untouched').toBe(4095);
	});

	it('clears every override on reset', () => {
		overrideTopicEpoch('a', 7);
		overrideTopicEpoch('b', 8);
		resetTopicEpochs();
		expect(topicEpochValue('a')).toBe(processEpoch());
		expect(topicEpochValue('b')).toBe(processEpoch());
	});
});
