// REAL uWS fan-out backpressure + recovery bench (g27). The single-worker
// goodput collapse under fan-out overload is NOT an accumulation bug - uWS's
// per-connection maxBackpressure already bounds each outbound queue and sheds
// past it. What was missing was OBSERVABILITY (the publish path drops silently
// in C++) and a PROVEN recovery bound. This bench demonstrates both against a
// live uWS server and real `ws` clients:
//
//   1. warm    - every client reads; publish at nominal rate; backpressure ~0.
//   2. overload - one client STOPS reading (pauses its TCP socket) while the
//                 publisher keeps fanning out; that client's server-side queue
//                 climbs past maxBackpressure and the sampler fold reports it.
//   3. recovery - the wedged client resumes; the queue drains; the bench
//                 measures how many sampler ticks until backpressure clears.
//
// The telemetry is read via the SAME pure fold the 1 Hz pressure sampler uses
// (foldConnectionBackpressure), so this exercises the shipped code path, not a
// bench-only reimplementation. Phase 4 also exercises the closeOnBackpressureLimit
// knob on a second route and reports whether a consumer wedged there is dropped by
// uWS (instead of shed forever like the default route); the drop is uWS-internal
// and loopback-timing-dependent, so it is reported, not asserted.
//
// Absolute throughput does not reproduce a 32-loader lab box on a dev machine
// (the original 1.47M/0.47M/0.93M figures were OVH iron); the SHAPE - overload
// raises backpressure, a load drop clears it within a bounded window - and all
// telemetry correctness ARE verifiable here.
//
// Run: node bench/ws-fanout-recovery.mjs    (starts its own server + clients; ~10 s)

import uWS from 'uWebSockets.js';
import { WebSocket } from 'ws';
import { foldConnectionBackpressure, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES } from '../src/runtime/utils/backpressure.js';

const PORT = parseInt(process.env.PORT || '9110');
const N_CLIENTS = parseInt(process.env.N_CLIENTS || '32');
const MAX_BACKPRESSURE = 256 * 1024; // lower than prod 1 MB so overload triggers fast on loopback
const FRAME = Buffer.alloc(16 * 1024, 0x7a); // 16 KB frames - a fat fan-out payload
const TOPIC = 'room';
const SAMPLE_MS = 100;
const RECOVERY_BUDGET_MS = 3000; // backpressure must clear within this after the drop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server
/** @type {Set<any>} live server-side sockets, the sampler's walk target */
const conns = new Set();
let publishing = false;

const app = uWS.App().ws('/rt', {
	maxPayloadLength: 1024 * 1024,
	maxBackpressure: MAX_BACKPRESSURE,
	idleTimeout: 0,
	open: (ws) => { ws.subscribe(TOPIC); conns.add(ws); },
	close: (ws) => { conns.delete(ws); }
}).ws('/rt-drop', {
	// Same limits, but closeOnBackpressureLimit ON: a consumer pinned over
	// maxBackpressure is CLOSED by uWS instead of shed-and-kept. Phase 4 wedges a
	// consumer here to show the bounded-recovery knob dropping it.
	maxPayloadLength: 1024 * 1024,
	maxBackpressure: MAX_BACKPRESSURE,
	closeOnBackpressureLimit: true,
	idleTimeout: 0,
	open: (ws) => { ws.subscribe('drop-room'); },
	close: () => {}
});

const sock = await new Promise((resolve, reject) => {
	app.listen('127.0.0.1', PORT, (s) => s ? resolve(s) : reject(new Error('listen failed')));
});

// Fan-out pump: publish FRAME to the topic as fast as the loop allows while
// `publishing` is set. app.publish is the native C++ fan-out the adapter's
// publish() fast path uses.
function pump() {
	if (!publishing) return;
	for (let i = 0; i < 8; i++) app.publish(TOPIC, FRAME, true, false);
	setImmediate(pump);
}

// ---------------------------------------------------------------- clients
/** @type {WebSocket[]} */
const clients = [];
for (let i = 0; i < N_CLIENTS; i++) {
	const ws = await new Promise((resolve, reject) => {
		const c = new WebSocket('ws://127.0.0.1:' + PORT + '/rt');
		c.binaryType = 'nodebuffer';
		c.on('open', () => resolve(c));
		c.on('error', reject);
	});
	ws.on('message', () => {}); // drain by default
	clients.push(ws);
}

function sample() {
	return foldConnectionBackpressure(conns, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES);
}

// ---------------------------------------------------------------- timeline
const pad = (s, n) => String(s).padStart(n);
const kb = (b) => (b / 1024).toFixed(0) + 'K';
console.log('\nREAL uWS fan-out backpressure + recovery (' + N_CLIENTS + ' clients, ' +
	kb(FRAME.length) + ' frames, maxBackpressure=' + kb(MAX_BACKPRESSURE) + ')');
console.log('  ' + pad('phase', 10) + '  ' + pad('maxBuffered', 12) + '  ' + pad('bpConns', 8));

// Phase 1: warm - everyone reads.
publishing = true;
pump();
await sleep(500);
const warm = sample();
console.log('  ' + pad('warm', 10) + '  ' + pad(kb(warm.maxBufferedBytes), 12) + '  ' + pad(warm.backpressuredConnections, 8));

// Phase 2: overload - wedge one client by pausing its TCP read.
const victim = clients[0];
victim._socket.pause();
let peak = { maxBufferedBytes: 0, backpressuredConnections: 0 };
const overloadDeadline = Date.now() + 2000;
while (Date.now() < overloadDeadline) {
	await sleep(SAMPLE_MS);
	const s = sample();
	if (s.maxBufferedBytes > peak.maxBufferedBytes) peak = s;
}
console.log('  ' + pad('overload', 10) + '  ' + pad(kb(peak.maxBufferedBytes), 12) + '  ' + pad(peak.backpressuredConnections, 8));

// Phase 3: recovery - stop overloading and let the wedged client read again.
publishing = false;
victim._socket.resume();
const recoveryStart = Date.now();
let recoveredMs = -1;
while (Date.now() - recoveryStart < RECOVERY_BUDGET_MS + 1000) {
	await sleep(SAMPLE_MS);
	const s = sample();
	if (s.backpressuredConnections === 0 && s.maxBufferedBytes < BACKPRESSURE_SAMPLE_THRESHOLD_BYTES) {
		recoveredMs = Date.now() - recoveryStart;
		break;
	}
}
const recovered = sample();
console.log('  ' + pad('recovered', 10) + '  ' + pad(kb(recovered.maxBufferedBytes), 12) + '  ' + pad(recovered.backpressuredConnections, 8));

// ---------------------------------------------------------------- verdict
let ok = true;
function assert(cond, msg) { if (!cond) { ok = false; console.log('  FAIL: ' + msg); } }
assert(warm.backpressuredConnections === 0, 'warm phase should show no backpressure');
assert(peak.maxBufferedBytes >= MAX_BACKPRESSURE || peak.backpressuredConnections >= 1,
	'overload phase should raise backpressure on the wedged consumer');
assert(recoveredMs >= 0 && recoveredMs <= RECOVERY_BUDGET_MS,
	'backpressure should clear within ' + RECOVERY_BUDGET_MS + 'ms of the load drop (got ' +
	(recoveredMs < 0 ? 'never' : recoveredMs + 'ms') + ')');
console.log('\n  recovery time after load drop: ' + (recoveredMs < 0 ? 'NOT RECOVERED' : recoveredMs + 'ms') +
	'  (budget ' + RECOVERY_BUDGET_MS + 'ms)');
console.log('  peak wedged-consumer queue: ' + kb(peak.maxBufferedBytes) + '  (maxBackpressure ' + kb(MAX_BACKPRESSURE) + ')');
console.log('\n  ' + (ok ? 'PASS - overload raises backpressure telemetry; a load drop clears it within the bound.' : 'FAIL - see above.'));

// Phase 4: the closeOnBackpressureLimit knob. A consumer wedged on the /rt-drop
// route (which set the option) is CLOSED by uWS when its queue pins over
// maxBackpressure, instead of being kept and shed forever like the default
// route above. Connect one consumer, wedge it (pause its read), overload it,
// and observe the server drop it. Informational (loopback close timing is
// uWS-internal), so it reports rather than gating the bench.
const dropClient = await new Promise((resolve, reject) => {
	const c = new WebSocket('ws://127.0.0.1:' + PORT + '/rt-drop');
	c.binaryType = 'nodebuffer';
	c.on('open', () => resolve(c));
	c.on('error', reject);
});
let dropClosed = false;
dropClient.on('close', () => { dropClosed = true; });
dropClient.on('message', () => {});
await sleep(100);
dropClient._socket.pause(); // wedge: stop reading so the server-side queue climbs
const dropStart = Date.now();
publishing = true;
(function dropPump() {
	if (!publishing) return;
	for (let i = 0; i < 8; i++) app.publish('drop-room', FRAME, true, false);
	setImmediate(dropPump);
})();
while (Date.now() - dropStart < 3000 && !dropClosed) await sleep(SAMPLE_MS);
publishing = false;
const dropMs = Date.now() - dropStart;
console.log('\n  closeOnBackpressureLimit: wedged consumer ' +
	(dropClosed ? 'DROPPED after ' + dropMs + 'ms (knob closed the pinned consumer)' : 'not dropped within 3000ms on this box (loopback timing)'));

for (const c of clients) c.close();
try { dropClient.close(); } catch { /* already closed by the server */ }
uWS.us_listen_socket_close(sock);
await sleep(100);
process.exit(ok ? 0 : 1);
