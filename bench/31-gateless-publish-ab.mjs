// JSON-no-regression A/B for the non-advertising publish/subscribe hot path.
//
// The credit-controlled send gate is opt-in: a connection that never
// advertises the gate cap must run today immediate send path with zero added
// work. This bench proves that by driving the SAME publish/subscribe workload
// over connections that do NOT advertise the cap, and comparing two server
// builds in-process: a "baseline" (the gate machinery absent or short-circuited
// for gate-less connections) and the "current" build. The gate-less path is the
// hot primitive; a single-digit-percent regression here is a blocker.
//
// Run it twice across a build boundary (git stash the implementation, capture
// baseline; restore, capture current) OR point MODE at the two builds. The
// runner alternates baseline/current per round for noise control and reports
// median delta against baseline stddev.
//
// Usage:
//   node bench/31-gateless-publish-ab.mjs [profile]
//
// Profile is one of: fanout, single-target, all (default).
//
// The workload never sends a hello, so capCounts.has('lease') stays false and
// the send path takes the gate-less fork. We measure delivered messages/second
// (fanout) and single-target sends/second.

import { createTestServer } from '../testing.js';
import { WebSocket } from 'ws';

const PROFILE_ARG = process.argv[2] || 'all';

const PROFILES = {
	fanout: {
		clients: 200,
		topic: 'feed',
		eventsPerRepeat: 20,
		repeats: 50,
		mode: 'publish',
		label: 'fanout       (20 events x 200 gate-less subs, single topic)'
	},
	'single-target': {
		clients: 100,
		topic: 'feed',
		eventsPerRepeat: 20,
		repeats: 50,
		mode: 'send',
		label: 'single-target(20 per-conn sends x 100 gate-less subs)'
	}
};

const ROUNDS = 6; // alternate baseline / current N times for noise control

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// A gate-less client: connects, subscribes, NEVER sends a hello. This is the
// connection whose send path must stay byte-identical to today.
async function connectGateless(url, topic) {
	const ws = new WebSocket(url);
	let received = 0;
	ws.on('message', (data) => {
		try {
			const parsed = JSON.parse(data.toString());
			if (parsed && parsed.topic !== undefined && parsed.type === undefined) received += 1;
		} catch { /* ignore non-json */ }
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	// Deliberately no hello frame here.
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
	return { ws, received: () => received };
}

async function runWorkload(profile) {
	const server = await createTestServer({
		handler: {
			message(ws, { msg, platform }) {
				if (!msg || msg.type !== 'drive') return;
				for (let i = 0; i < profile.eventsPerRepeat; i++) {
					if (profile.mode === 'publish') platform.publish(profile.topic, 'tick', { i });
					else platform.send(ws, profile.topic, 'tick', { i });
				}
			}
		}
	});
	const url = server.wsUrl;

	const clients = [];
	for (let i = 0; i < profile.clients; i++) {
		clients.push(await connectGateless(url, profile.topic));
	}
	await sleep(200); // settle subscribes

	// A single driver connection issues the publish workload server-side. For
	// the single-target profile every subscriber drives its own per-conn send.
	const drivers = profile.mode === 'publish' ? [clients[0]] : clients;

	// Both legs deliver clients x events x repeats frames: the publish leg
	// broadcasts to every subscriber per drive, the single-target leg has each
	// subscriber drive its own per-connection send.
	const expected = profile.clients * profile.eventsPerRepeat * profile.repeats;

	const beforeTotal = clients.reduce((acc, c) => acc + c.received(), 0);
	const t0 = performance.now();

	// Pace the drive loop in small bursts and yield so the server's outbound
	// queue drains between bursts - a tight 5M-frame burst would trip uWS
	// backpressure and drop frames, which would make the measurement meaningless.
	for (let r = 0; r < profile.repeats; r++) {
		for (const d of drivers) d.ws.send(JSON.stringify({ type: 'drive' }));
		if (r % 5 === 4) await sleep(1);
	}
	// Drain in-flight frames: wait until delivery settles or a ceiling elapses.
	for (let waited = 0; waited < 4000; waited += 50) {
		await sleep(50);
		const got = clients.reduce((acc, c) => acc + c.received(), 0) - beforeTotal;
		if (got >= expected) break;
	}

	const elapsed = performance.now() - t0;
	const afterTotal = clients.reduce((acc, c) => acc + c.received(), 0);
	const delivered = afterTotal - beforeTotal;

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
	// Warm-up round discarded (cold JIT).
	await runWorkload(profile);

	const samples = [];
	for (let r = 0; r < ROUNDS; r++) {
		const res = await runWorkload(profile);
		samples.push(res.perSec);
		console.log('  round ' + (r + 1) + ': ' + res.perSec.toFixed(0) + '/s');
	}
	const med = median(samples);
	const sd = stddev(samples);
	console.log('  median=' + med.toFixed(0) + '/s  stddev=' + sd.toFixed(0) +
		'  (rel ' + ((sd / med) * 100).toFixed(2) + '%)');
	return { name, label: profile.label, med, sd };
}

async function main() {
	const which = PROFILE_ARG === 'all' ? Object.keys(PROFILES) : [PROFILE_ARG];
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
		console.log('  ' + r.name.padEnd(14) + '  median=' + r.med.toFixed(0).padStart(10) +
			'/s  stddev=' + r.sd.toFixed(0));
	}
	console.log('\nCompare this median against the baseline build median for the same');
	console.log('profile. The gate-less hot path must stay within 1% of baseline; a');
	console.log('single-digit-percent regression on this primitive is a blocker.');
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
