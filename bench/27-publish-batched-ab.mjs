// A/B bench for platform.publishBatched vs the equivalent platform.publish
// loop. Runs three profiles end-to-end in-process: spawns a uWS server,
// connects K WebSocket clients, has each client subscribe to its profile
// topic set, then drives the server through R repeats of the workload
// for each variant. Reports messages received / second per variant per
// profile, plus the delta.
//
// Profiles capture three realistic shapes:
//   - large-same:   50 events x 500 subs same-topic   (bulk-import shape)
//   - medium-over:   5 events x 500 subs overlapping topics (room-state-reset)
//   - small-disjoint:3 events x  50 subs disjoint topics (control)
//
// Usage:
//   node bench/27-publish-batched-ab.mjs [profile]
//
// Profile is one of: large-same, medium-over, small-disjoint, all (default).
//
// The bench imports `createTestServer` from ../testing.js to share the
// adapter's publishBatched implementation - no need to write a parallel
// uWS server. The publish loop variant wraps the same testing-harness
// platform with platform.batch(...) (which is the for-loop), so we are
// literally A/B testing wire-batched vs frame-per-event for the same
// fanout shape.

import { createTestServer } from '../testing.js';
import { WebSocket } from 'ws';

const PROFILE_ARG = process.argv[2] || 'all';

const PROFILES = {
	'large-same': {
		clients: 500,
		eventsPerCall: 50,
		topicsPerEvent: () => 'feed',
		clientTopics: () => ['feed'],
		repeats: 200,
		label: 'large-same   (50 events x 500 subs, single topic)'
	},
	'medium-over': {
		clients: 500,
		eventsPerCall: 5,
		topicsPerEvent: (i) => 'room:' + (i % 3),
		clientTopics: () => ['room:0', 'room:1', 'room:2'],
		repeats: 200,
		label: 'medium-over  ( 5 events x 500 subs, overlapping topics)'
	},
	'small-disjoint': {
		clients: 50,
		eventsPerCall: 3,
		topicsPerEvent: (i) => 'topic:' + (i % 3),
		clientTopics: (idx) => ['topic:' + (idx % 3)],
		repeats: 1000,
		label: 'small-disjoint ( 3 events x  50 subs, disjoint topics)'
	}
};

const ROUNDS = 5; // alternate baseline / variant N times for noise control

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectClient(url, topics, sendHello) {
	const ws = new WebSocket(url);
	let received = 0;
	ws.on('message', (data) => {
		// Accept either single-event frames or batch frames; count
		// event count so the two variants are comparable.
		try {
			const parsed = JSON.parse(data.toString());
			if (parsed && parsed.type === 'batch' && Array.isArray(parsed.events)) {
				received += parsed.events.length;
			} else if (parsed && parsed.topic !== undefined) {
				received += 1;
			}
		} catch {}
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	if (sendHello) {
		ws.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
	}
	for (const t of topics) {
		ws.send(JSON.stringify({ type: 'subscribe', topic: t }));
	}
	return { ws, received: () => received };
}

async function runWorkload(profile, mode) {
	// mode: 'publish-loop' or 'publish-batched'
	const server = await createTestServer();
	const url = server.wsUrl;

	const sendHello = mode === 'publish-batched';
	const clients = [];
	for (let i = 0; i < profile.clients; i++) {
		clients.push(await connectClient(url, profile.clientTopics(i), sendHello));
	}
	await sleep(200); // settle subscribes

	const totalReceivedBefore = clients.reduce((acc, c) => acc + c.received(), 0);
	const t0 = performance.now();

	for (let r = 0; r < profile.repeats; r++) {
		const messages = [];
		for (let i = 0; i < profile.eventsPerCall; i++) {
			messages.push({
				topic: profile.topicsPerEvent(i),
				event: 'tick',
				data: { r, i }
			});
		}
		if (mode === 'publish-loop') {
			for (const m of messages) server.platform.publish(m.topic, m.event, m.data);
		} else {
			server.platform.publishBatched(messages);
		}
	}
	// Allow in-flight frames to drain
	await sleep(300);

	const elapsed = performance.now() - t0;
	const totalReceivedAfter = clients.reduce((acc, c) => acc + c.received(), 0);
	const delivered = totalReceivedAfter - totalReceivedBefore;

	for (const c of clients) c.ws.close();
	await sleep(50);
	server.close();
	await sleep(50);

	return { delivered, elapsedMs: elapsed, perSec: delivered / (elapsed / 1000) };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
	const m = values.reduce((a, b) => a + b, 0) / values.length;
	const v = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / values.length;
	return Math.sqrt(v);
}

async function runProfile(name, profile) {
	console.log('\n=== ' + profile.label + ' ===');
	const baseline = [];
	const variant = [];
	// Warm-up: one round each, discarded.
	await runWorkload(profile, 'publish-loop');
	await runWorkload(profile, 'publish-batched');
	for (let r = 0; r < ROUNDS; r++) {
		const a = await runWorkload(profile, 'publish-loop');
		const b = await runWorkload(profile, 'publish-batched');
		baseline.push(a.perSec);
		variant.push(b.perSec);
		console.log(
			'  round ' + (r + 1) + ': loop=' + a.perSec.toFixed(0) +
			' batched=' + b.perSec.toFixed(0)
		);
	}
	const medA = median(baseline);
	const medB = median(variant);
	const sdA = stddev(baseline);
	const sdB = stddev(variant);
	const delta = (medB - medA) / medA;
	console.log(
		'  loop    median=' + medA.toFixed(0) + '/s  stddev=' + sdA.toFixed(0)
	);
	console.log(
		'  batched median=' + medB.toFixed(0) + '/s  stddev=' + sdB.toFixed(0)
	);
	console.log(
		'  delta:  ' + (delta * 100).toFixed(2) + '%  (' +
		(delta > 0 ? 'batched faster' : 'batched slower') + ')'
	);
	const noise = sdA / medA;
	const verdict = Math.abs(delta) < noise * 1.5
		? 'within noise'
		: delta > 0 ? 'BATCHED WIN' : 'BATCHED REGRESSION';
	console.log('  verdict: ' + verdict);
	return { name, label: profile.label, medA, medB, sdA, sdB, delta, verdict };
}

async function main() {
	const which = PROFILE_ARG === 'all'
		? Object.keys(PROFILES)
		: [PROFILE_ARG];
	const results = [];
	for (const key of which) {
		const profile = PROFILES[key];
		if (!profile) {
			console.error('Unknown profile: ' + key);
			process.exit(1);
		}
		results.push(await runProfile(key, profile));
	}
	console.log('\n=== Summary ===');
	for (const r of results) {
		console.log(
			'  ' + r.name.padEnd(15) +
			'  delta=' + (r.delta * 100).toFixed(2).padStart(7) + '%' +
			'  ' + r.verdict
		);
	}
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
