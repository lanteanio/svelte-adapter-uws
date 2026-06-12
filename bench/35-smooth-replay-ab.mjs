// Reconciliation hot-path perf gate. Every server acknowledgement drops the
// confirmed window prefix, rebases on the authoritative state, and replays
// the surviving command tail through the developer's apply. This bench
// measures that cost across window depths in the steady state: one new
// command and one acknowledgement per cycle, the un-acked window holding a
// constant depth, so each ack replays exactly `depth` commands.
//
//   A: direct state adoption (no predictor) - command generation, the
//      authoritative fold, and id/clock bookkeeping only
//   B: the same cycle through the predictor (command apply + window entry +
//      ack prefix drop + rebase + tail replay)
//
// The reported ns/ack is B minus A per cycle: the predictor's own added
// cost. Gate: at a 5-command window the added cost stays under 5000 ns -
// an ack must be invisible against a 16.6 ms frame budget.
//
// Pure JS, no uWS, no real WS - this is a data-structure property, not a
// network property. Deterministic, repeatable, runs in seconds.

import { performance } from 'node:perf_hooks';
import { createPredictor } from '../plugins/smooth/predict.js';

const DEPTHS = [1, 5, 30, 256];
const CYCLES = 20000;
const WARMUP = 3000;
const ROUNDS = 7;

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const CMD = { dx: 1, dy: -1 };

/** The trivial positional apply both variants share. */
function fold(s, c) {
	return { x: s.x + c.dx, y: s.y + c.dy };
}

function benchPredictor(depth) {
	const p = createPredictor({
		apply: fold,
		initial: { x: 0, y: 0 },
		windowCap: depth + 8,
		windowMaxAgeMs: Number.MAX_SAFE_INTEGER,
		smoothTimeMs: 100
	});
	let mono = 0;
	let serverState = { x: 0, y: 0 };
	let ackId = 0;
	let sink = 0;
	// Fill the window to the working depth; from here every cycle issues one
	// command and acknowledges the oldest, so the depth holds.
	for (let i = 0; i < depth; i++) p.command(CMD, ++mono);
	const cycle = () => {
		p.command(CMD, ++mono);
		serverState = fold(serverState, CMD);
		const r = p.ack(++ackId, serverState, mono);
		sink += r.divergence;
	};
	for (let i = 0; i < WARMUP; i++) cycle();
	const start = performance.now();
	for (let i = 0; i < CYCLES; i++) cycle();
	const ns = ((performance.now() - start) * 1e6) / CYCLES;
	if (p.windowSize !== depth || p.overflowed) throw new Error('bench invariant broken');
	return { ns, sink };
}

function benchBaseline(depth) {
	let mono = 0;
	let serverState = { x: 0, y: 0 };
	let predicted = serverState;
	let nextId = depth;
	let sink = 0;
	const cycle = () => {
		++mono;
		++nextId;
		serverState = fold(serverState, CMD);
		predicted = serverState;
		sink += predicted.x;
	};
	for (let i = 0; i < WARMUP; i++) cycle();
	const start = performance.now();
	for (let i = 0; i < CYCLES; i++) cycle();
	const ns = ((performance.now() - start) * 1e6) / CYCLES;
	return { ns, sink: sink + nextId };
}

console.log('Reconciliation cost per acknowledgement (steady-state window)');
console.log('  cycles timed per round: ' + CYCLES + ', rounds: ' + ROUNDS + ' (median)');

for (const depth of DEPTHS) {
	const base = [];
	const pred = [];
	for (let r = 0; r < ROUNDS; r++) {
		base.push(benchBaseline(depth).ns);
		pred.push(benchPredictor(depth).ns);
	}
	const a = median(base);
	const b = median(pred);
	const perAck = b - a;
	const perReplayed = perAck / depth;
	console.log('\n  window depth ' + String(depth).padStart(3));
	console.log('    A direct adoption   ' + a.toFixed(0).padStart(8) + ' ns/cycle');
	console.log('    B predictor         ' + b.toFixed(0).padStart(8) + ' ns/cycle');
	console.log('    ack cost (B - A)    ' + perAck.toFixed(0).padStart(8) + ' ns/ack  (' + perReplayed.toFixed(1) + ' ns/replayed command)');
	if (depth === 5) {
		const pass = perAck < 5000;
		console.log('    gate: 5-command window < 5000 ns/ack -> ' + (pass ? 'PASS' : 'FAIL') + ' (' + perAck.toFixed(0) + ' ns)');
		if (!pass) process.exitCode = 1;
	}
}
