/* global WS_OPTIONS */
// Bounded per-topic sequence registries.
//
// topicSeqs and maxSeenSeq are process-lifetime maps that publishing and the
// cross-worker relay insert into, and nothing evicted from them while the
// worker lived: a high-cardinality topic scheme (a topic per user, per
// document, per match) consumed memory for the worker lifetime with only a
// one-shot warning at a million entries. Plain LRU eviction is not safe here,
// because the resume protocol depends on the counters: a client holds a
// per-topic dedup watermark, and a topic whose counter is evicted and later
// re-inserted would restart at 1, so the client would silently discard fresh
// events as duplicates.
//
// What makes eviction safe is that a forgotten counter is never REUSED. The
// bound carries what it forgets, in two layers:
//
// EXACT FLOORS (the common case): evicting a topic records
// fnv32(topic) -> lastSeq in a bounded map. When the counter arm later meets a
// topic absent from the registry, it resumes from that floor plus one instead
// of 1. A hash collision can only INFLATE another topic's resume point, which
// is harmless by the same monotonicity argument: a counter may skip numbers;
// it must never repeat them. Cost per evicted topic: two numbers instead of
// the topic string and its map entry.
//
// THE HIGH-WATER MARK (the backstop, and the memory guarantee): when the floor
// map reaches its own cap, every floor it holds is absorbed into a single
// number - the highest counter any forgotten topic reached - and the map is
// cleared. A topic re-inserted after that resumes above THAT, so the
// no-reuse property survives with one number of state no matter how many
// topics the worker forgets. Nothing about the seq space resets, so no epoch
// changes and no client is asked to rehydrate: the whole mechanism stays
// invisible to clients, which is what lets it run on a live worker.
//
// EVICTION POLICY: on inserting a NEW topic at the cap, sweep the front of
// the registry for an entry with no live subscribers and no open resume
// buffer. The sweep is bounded - two passes of SCAN_LIMIT candidates - and
// rotates everything it passes over to the tail, so a block of unevictable
// topics cannot occupy the window forever; a fixed window re-judged from the
// head each time would jam on sixteen busy topics and the registry would grow
// without limit, which is the failure this bound exists to prevent. When both
// passes come back empty, admit over the cap and warn, and wave the next few
// over-cap inserts straight through: the empty sweep is the expensive one and
// its answer cannot change until something becomes evictable, so re-paying it
// per insert would turn a wedged registry into a hot loop. Over-cap-with-
// warning beats evicting under an active subscriber, whose resume buffer would
// be re-based. That protection is best-effort by design (an exact-topic
// subscriber count does not see a wildcard subscription); CORRECTNESS does not
// rest on it, because the carried floor keeps every client's watermark valid
// whether the topic was protected or not.
//
// The seen registry is the wider of the two - every counter topic also has a
// seen entry - so its scan takes counter topics as victims too, through the
// same eviction. maxSeenSeq and topicSeqs therefore shrink together, and the
// divergence reporter's mirror maps follow the live registry's membership per
// tick, so bounding these bounds the mirrors for free.
//
// Floors are per-worker, matching the per-worker counter authority they
// protect. A cross-worker asymmetry (one worker evicted a topic its sibling
// retained) is only safe while the forgotten topic is QUIET, because the
// active lane is the one that can restart a worker over a disagreement. So a
// clustered worker's reporter lends this bound its quiet-lane judgment
// (handler.js installs the probe) and eviction takes only topics the reporter
// has positively judged quiet.
//
// The cost is that a topic stays unevictable until the reporter has judged it,
// so on a clustered worker the real ceiling is
//
//     maxTopicSeqEntries + newTopicsPerSecond * 2 * stateHashIntervalMs/1000
//
// - two reporter intervals of arrivals, which at the recommended 30s interval
// is a minute of them. Size the option with that term in mind rather than
// from the cap alone; the over-cap warning reports the real size. The probe
// also stops judging if the reporter ever stops ticking, which would starve
// eviction entirely - the reporter runs for the life of a clustered worker,
// so this is a constraint on future teardown paths, not a live hazard. A
// single-process worker installs no probe and evicts immediately, having no
// sibling to disagree with.

import { createSeqBound } from '../utils/seq-bound.js';
import { TOPIC_SEQS_WARN_THRESHOLD } from '../utils/caps.js';
import { app } from './config.js';
import { maxSeenSeq, resumeBuffers, topicSeqs } from './state.js';
import { maybeWarnTopicRegistry } from './pressure-metrics.js';

function resolveCapacity() {
	if (typeof WS_OPTIONS !== 'undefined' && WS_OPTIONS && WS_OPTIONS.maxTopicSeqEntries !== undefined) {
		return WS_OPTIONS.maxTopicSeqEntries;
	}
	// Default = the long-standing warn threshold: zero-config behavior only
	// changes where today's deployment was already in warned pathology.
	return TOPIC_SEQS_WARN_THRESHOLD;
}

const CAPACITY = resolveCapacity();

/**
 * The shared bound over the runtime's topicSeqs / maxSeenSeq registries.
 * Protection is fail-closed: a topic with live raw subscribers or an open
 * resume buffer is passed over, and a probe that throws protects rather than
 * authorizes.
 */
export const seqBound = createSeqBound({
	seqMap: topicSeqs,
	seenMap: maxSeenSeq,
	capacity: CAPACITY,
	floorCap: CAPACITY === 0 ? 0 : Math.max(1024, Math.floor(CAPACITY / 4)),
	isProtected(topic) {
		try {
			if (resumeBuffers.size > 0 && resumeBuffers.has(topic)) return true;
			return app.numSubscribers(topic) > 0;
		} catch {
			return true;
		}
	},
	onOverCap(size) {
		maybeWarnTopicRegistry(CAPACITY, size);
	}
});
