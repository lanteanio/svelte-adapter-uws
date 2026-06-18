// End-to-end A/B for the relay-RECEIVE hot path: a worker that receives a
// cross-worker relay frame re-publishes the originator's pre-stamped envelope to
// its local subscribers. The convergent-seq tracker adds ONE recordSeen guard
// (a Map.get + a monotone-max compare + a conditional Map.set) ahead of that
// app.publish. This bench measures the guard against the REAL cost of the
// receive path: a real uWebSockets.js App fanning a frame out to N real ws
// subscribers - the C++ TopicTree dispatch + N socket writes a pure-JS microbench
// cannot model.
//
// The production relayPublish (src/runtime/handler/lifecycle.js) imports
// build-virtual modules and is not importable here, so this bench reproduces its
// exact receive body over a real App: parse the seq out of the relay metadata
// (carried as an explicit number, NO envelope re-parse), recordSeen, then
// app.publish the pre-built envelope. The baseline arm runs the identical
// app.publish without the recordSeen call.
//
// PASS CRITERION: the tracked arm's delivered-msgs/sec stays within a
// single-digit percent of the baseline arm. A sustained >=5% regression is a
// blocker (credo rule 4). Run each arm several rounds, compare medians.
//
// Usage:
//   node bench/micro-relay-receive-ab.mjs [subscribers] [repeats] [rounds]
//
// Defaults: 200 subscribers, 2000 publishes/round, 8 rounds.

import { WebSocket } from 'ws';
import { recordSeen } from '../src/runtime/handler/state.js';
import { completeEnvelope } from '../src/runtime/utils/epoch.js';
import { esc } from '../src/runtime/utils.js';

const SUBS = parseInt(process.argv[2] || '200', 10);
const REPEATS = parseInt(process.argv[3] || '2000', 10);
const ROUNDS = parseInt(process.argv[4] || '8', 10);
const TOPIC = 'feed';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	console.error('micro-relay-receive-ab requires uWebSockets.js to be installed.');
	process.exit(1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function median(values) {
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(values) {
	const m = values.reduce((a, b) => a + b, 0) / values.length;
	const v = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / values.length;
	return Math.sqrt(v);
}

// Build a real uWS app whose only job is to fan a pre-built envelope out to its
// subscribers via app.publish - exactly what the receive handler does. The
// `tracked` flag toggles the recordSeen guard the tracker adds ahead of it.
async function startServer() {
	let app;
	const maxSeenSeq = new Map();
	const driver = {
		// The receive body under test. `seq` arrives as explicit relay metadata
		// (a number) - the production change carries it on the frame so the
		// receiver never re-parses the envelope string to recover it.
		receive(topic, envelope, seq, tracked) {
			if (tracked) recordSeen(maxSeenSeq, topic, seq);
			app.publish(topic, envelope, false, false);
		},
		maxSeenSeq
	};
	await new Promise((resolve, reject) => {
		app = uWS.App().ws('/ws', {
			maxPayloadLength: 64 * 1024,
			idleTimeout: 120,
			open(ws) { ws.subscribe(TOPIC); },
			message() {}
		}).listen(0, (token) => {
			if (token) { driver.token = token; driver.port = uWS.us_socket_local_port(token); resolve(); }
			else reject(new Error('listen failed'));
		});
	});
	driver.app = app;
	driver.close = () => { if (driver.token) uWS.us_listen_socket_close(driver.token); };
	return driver;
}

async function connectClients(port, n) {
	const clients = [];
	for (let i = 0; i < n; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		let received = 0;
		ws.on('message', () => { received += 1; });
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
		clients.push({ ws, received: () => received });
	}
	return clients;
}

async function runArm(driver, clients, tracked) {
	const before = clients.reduce((a, c) => a + c.received(), 0);
	const expected = SUBS * REPEATS;
	const prefix = '{"topic":' + esc(TOPIC) + ',"event":' + esc('tick') + ',"data":';

	const t0 = performance.now();
	for (let r = 0; r < REPEATS; r++) {
		const seq = r + 1;
		const env = completeEnvelope(prefix, { i: r }, seq);
		driver.receive(TOPIC, env, seq, tracked);
		if (r % 200 === 199) await sleep(1); // let the outbound queue drain
	}
	for (let waited = 0; waited < 4000; waited += 25) {
		await sleep(25);
		if (clients.reduce((a, c) => a + c.received(), 0) - before >= expected) break;
	}
	const elapsed = performance.now() - t0;
	const delivered = clients.reduce((a, c) => a + c.received(), 0) - before;
	return delivered / (elapsed / 1000);
}

async function main() {
	console.log(`Node ${process.version}`);
	console.log(`relay-receive A/B: ${SUBS} subscribers, ${REPEATS} publishes/round, ${ROUNDS} rounds`);

	const driver = await startServer();
	const clients = await connectClients(driver.port, SUBS);
	await sleep(200); // settle subscribes

	// Warm-up round per arm (cold JIT), discarded.
	await runArm(driver, clients, false);
	await runArm(driver, clients, true);

	const baseSamples = [];
	const trackedSamples = [];
	for (let r = 0; r < ROUNDS; r++) {
		baseSamples.push(await runArm(driver, clients, false));
		trackedSamples.push(await runArm(driver, clients, true));
	}

	const baseMed = median(baseSamples);
	const trackedMed = median(trackedSamples);
	const baseSd = stddev(baseSamples);
	const trackedSd = stddev(trackedSamples);
	const deltaPct = ((trackedMed - baseMed) / baseMed) * 100;

	console.log(`\n  baseline (app.publish only)        median=${baseMed.toFixed(0)}/s  stddev=${baseSd.toFixed(0)}  (rel ${((baseSd / baseMed) * 100).toFixed(2)}%)`);
	console.log(`  tracked  (recordSeen + app.publish) median=${trackedMed.toFixed(0)}/s  stddev=${trackedSd.toFixed(0)}  (rel ${((trackedSd / trackedMed) * 100).toFixed(2)}%)`);
	console.log(`  delta    ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%  (negative = tracked slower)`);

	for (const c of clients) c.ws.close();
	await sleep(50);
	driver.close();

	console.log('\n--- gate ---');
	const GATE = 5;
	// A negative delta beyond -GATE% is a regression; within +-GATE% is a pass
	// (the recordSeen guard is one Map op behind a C++ fan-out + N socket writes).
	const regressionPct = -deltaPct;
	const pass = regressionPct < GATE;
	console.log(`relay-receive regression ${regressionPct.toFixed(2)}%  gate < ${GATE}%  -> ${pass ? 'PASS' : 'BLOCKER'}`);
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
