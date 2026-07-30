// Microbenchmark: A/B the subscribe-batch LANDING decisions, inline vs routed
// through the shared policy module.
//
// The batch landing runs once per topic in a `subscribe-batch` frame, up to 256
// topics per frame, so it is a per-message hot path and the shared-decision
// refactor has to pay for itself there. Two decisions are at stake:
// `deniesWireSubscribeLanding` (spelled inline as `_wireAuthz && !subs.has(t)`)
// and `exceedsSubscriptionCap` (spelled inline as `subs.size >= MAX`). Both take
// an object literal per call when routed through the module, which is the cost
// this measures.
//
// Variant A replays the inline spellings as the three surfaces ship them today.
// Variant B calls the real exported policy functions. The realistic case below
// is the one that decides: nothing calls these predicates in a hot loop on their
// own - a real landing also does the Set lookups, the denial chain, the
// membership add and the ack serialization around them.
//
// Usage:
//   node bench/micro-batch-landing-policy-ab.mjs [frames] [rounds]
// Defaults: 200_000 frames, 12 rounds.

import { deniesWireSubscribeLanding, exceedsSubscriptionCap } from '../src/runtime/utils/subscribe-policy.js';

const FRAMES = parseInt(process.argv[2] || '200000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);
const MAX = 1024;

function makeTopics(n) {
	return Array.from({ length: n }, (_, i) => `room-${i}`);
}

// Variant A: the inline spellings, as src/runtime/handler.js:1888/1904,
// src/testing.js:2170/2184 and src/vite.js:1946/1958 ship them.
function landingInline(topics, subs, wireAuthz, hookDenials, out) {
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const denial = (wireAuthz && !subs.has(topic) ? 'FORBIDDEN' : null)
			?? (hookDenials !== null ? (hookDenials[topic] ?? null) : null);
		if (denial !== null) { out.denied++; continue; }
		if (subs.has(topic)) { out.acked++; continue; }
		if (subs.size >= MAX) { out.limited++; continue; }
		subs.add(topic);
		out.subscribed++;
	}
}

// Variant B: the same decisions asked of the policy module. `hasUserHook` is
// hoisted per frame exactly as `_wireAuthz` already is, so this adds an object
// literal per topic and no extra call.
function landingPolicy(topics, subs, armed, hasUserHook, hookDenials, out) {
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const held = subs.has(topic);
		const denial = (deniesWireSubscribeLanding({ armed, hasUserHook, held }) ? 'FORBIDDEN' : null)
			?? (hookDenials !== null ? (hookDenials[topic] ?? null) : null);
		if (denial !== null) { out.denied++; continue; }
		if (held) { out.acked++; continue; }
		if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX })) { out.limited++; continue; }
		subs.add(topic);
		out.subscribed++;
	}
}

// Realistic frame: the landing PLUS the ack serialization a real landing does
// per topic. The isolated predicates are a couple of ns; the number that decides
// the verdict is the delta against what a real frame costs.
const EPOCH = 7;
function frameInline(topics, subs, wireAuthz, hookDenials, out) {
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const denial = (wireAuthz && !subs.has(topic) ? 'FORBIDDEN' : null)
			?? (hookDenials !== null ? (hookDenials[topic] ?? null) : null);
		if (denial !== null) {
			out.b += JSON.stringify({ type: 'subscribe-denied', topic, ref: i, reason: denial }).length;
			continue;
		}
		if (subs.has(topic)) {
			out.b += JSON.stringify({ type: 'subscribed', topic, ref: i, epoch: EPOCH }).length;
			continue;
		}
		if (subs.size >= MAX) { out.limited++; continue; }
		subs.add(topic);
		out.b += JSON.stringify({ type: 'subscribed', topic, ref: i, epoch: EPOCH }).length;
	}
}
function framePolicy(topics, subs, armed, hasUserHook, hookDenials, out) {
	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const held = subs.has(topic);
		const denial = (deniesWireSubscribeLanding({ armed, hasUserHook, held }) ? 'FORBIDDEN' : null)
			?? (hookDenials !== null ? (hookDenials[topic] ?? null) : null);
		if (denial !== null) {
			out.b += JSON.stringify({ type: 'subscribe-denied', topic, ref: i, reason: denial }).length;
			continue;
		}
		if (held) {
			out.b += JSON.stringify({ type: 'subscribed', topic, ref: i, epoch: EPOCH }).length;
			continue;
		}
		if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX })) { out.limited++; continue; }
		subs.add(topic);
		out.b += JSON.stringify({ type: 'subscribed', topic, ref: i, epoch: EPOCH }).length;
	}
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Each frame starts from a fresh membership set so both variants walk the same
// state; the reconnect shape (every topic already held) is the common one, so it
// gets its own case rather than being averaged away.
function runCase(fn, topics, frames, preHeld, wireAuthz, hookDenials, isPolicy) {
	const out = { denied: 0, acked: 0, limited: 0, subscribed: 0, b: 0 };
	const t0 = performance.now();
	for (let f = 0; f < frames; f++) {
		const subs = new Set(preHeld ? topics : undefined);
		if (isPolicy) fn(topics, subs, wireAuthz, false, hookDenials, out);
		else fn(topics, subs, wireAuthz, hookDenials, out);
	}
	const t1 = performance.now();
	return { ms: t1 - t0, out };
}

const CASES = [
	{ name: 'batch 1,   fresh',     n: 1,   preHeld: false },
	{ name: 'batch 8,   fresh',     n: 8,   preHeld: false },
	{ name: 'batch 64,  fresh',     n: 64,  preHeld: false },
	{ name: 'batch 256, fresh',     n: 256, preHeld: false },
	{ name: 'batch 256, reconnect', n: 256, preHeld: true }
];

console.log(`Node ${process.version}, ${FRAMES.toLocaleString()} frames x ${ROUNDS} rounds, alternating`);
console.log(`armed wire-authz, no app hook, no hook denials (the armed hot path)`);

for (const label of ['isolated landing (diagnostic)', 'realistic frame (landing + ack serialization)']) {
	const inline = label.startsWith('isolated') ? landingInline : frameInline;
	const policy = label.startsWith('isolated') ? landingPolicy : framePolicy;
	console.log(`\n== ${label} ==`);
	for (const c of CASES) {
		const topics = makeTopics(c.n);
		// Frames scale down with batch size so every case does comparable work.
		const frames = Math.max(1000, Math.round(FRAMES / c.n));
		for (let i = 0; i < 3; i++) {
			runCase(inline, topics, frames, c.preHeld, true, null, false);
			runCase(policy, topics, frames, c.preHeld, true, null, true);
		}
		const aMs = [];
		const bMs = [];
		for (let r = 0; r < ROUNDS; r++) {
			aMs.push(runCase(inline, topics, frames, c.preHeld, true, null, false).ms);
			bMs.push(runCase(policy, topics, frames, c.preHeld, true, null, true).ms);
		}
		const a = median(aMs);
		const b = median(bMs);
		const perTopicA = (a * 1e6) / (frames * c.n);
		const perTopicB = (b * 1e6) / (frames * c.n);
		const ratio = b / a;
		const verdict = ratio > 1.03 ? 'REGRESSION' : ratio < 0.97 ? 'faster' : 'no delta';
		console.log(
			`${c.name.padEnd(22)} inline ${a.toFixed(1).padStart(8)}ms (${perTopicA.toFixed(1)}ns/topic)  ` +
			`policy ${b.toFixed(1).padStart(8)}ms (${perTopicB.toFixed(1)}ns/topic)  ` +
			`${ratio.toFixed(3)}x  ${verdict}`
		);
	}
}
