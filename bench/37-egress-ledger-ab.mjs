// A/B bench for the publish-egress ledger's reclamation and eviction policy
// (src/runtime/utils/egress-account.js), plus an independent enforcement oracle
// for the same shapes.
//
// Three rounds of eviction design were accepted against benches that could not
// resolve what they claimed, so the method here is as load-bearing as the
// numbers and is worth keeping intact:
//
//   1. THE CLOCK ADVANCES ON EVERY PUBLISH. Every earlier bench ticked once per
//      "window" and held the clock still for the thousands of calls inside it.
//      That gives every resident window the same start, so one reclamation pass
//      covers the whole ledger and any design looks sound. Production reads a
//      monotonic clock per call; the window starts fan out; reclamation has to
//      keep pace continuously. A design measured on a frozen clock has been
//      measured on a condition production never has - it reported one change as
//      a 24% win that a moving clock puts at +213%.
//
//   2. A BYTE-IDENTICAL CONTROL ARM, per shape. The extra arm is the same module
//      loaded twice. Whatever spread it shows against its own twin IS that
//      shape's noise floor. Without it there is no way to tell a real regression
//      from harness bias: one effect in this module measured +162%, +36% and
//      -3.2% across three attempts before a control showed the headline sat
//      inside a single unchanged arm's warm-up spread.
//
//   3. MEDIAN AND A TAIL QUANTILE, never best-of-N. A best-of estimator cannot
//      show a latency spike, and a spike is what this module's failure mode
//      looks like - the rejected design reached 87 us on a single insert.
//
//   4. THE ENFORCEMENT ORACLE IS INDEPENDENT of the account's own counters. It
//      records every ADMITTED publish's timestamp and replays them through a
//      reimplementation of the documented window rule. Its control is that it
//      reports exactly 0 on an unbounded ledger - run that first, because an
//      oracle that cannot report zero cannot report anything.
//
// Usage:  node bench/37-egress-ledger-ab.mjs [pathToVariant.mjs ...]
//
// With no arguments it measures the shipped module against itself, which
// establishes the noise floor and nothing else. Pass one or more variant copies
// (a module with its three relative imports rewritten to absolute file:// URLs)
// to compare a candidate policy against it.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = 'file:///' + path.join(ROOT, 'src/runtime/utils/egress-account.js').replace(/\\/g, '/');

const variants = process.argv.slice(2);
const ARMS = [['shipped', await import(SHIPPED)], ['control', await import(SHIPPED + '?control')]];
for (const v of variants) {
	const url = v.startsWith('file:') ? v : 'file:///' + path.resolve(v).replace(/\\/g, '/');
	ARMS.push([path.basename(v), await import(url)]);
}

const TICK = 0.05; // ms of simulated time per publish

function mk(mod, windowMs, ceiling) {
	let nowMs = 0;
	const account = mod.createEgressAccount({
		options: mod.normalizeEgressOptions({ windowMs, topic: { messages: ceiling } }),
		clock: () => nowMs,
		onEvicted: () => {}
	});
	return { account, adv: (ms) => { nowMs += ms; } };
}

const SHAPES = {
	// A live set just over the bound with a slow trickle of new keys: the shape
	// where a per-insert full pass is ruinous and a frozen clock hides it.
	'live 4300, rooms trickle': (m) => {
		const { account, adv } = mk(m, 1000, 1e6);
		const core = Array.from({ length: 4240 }, (_, i) => 'c:' + i);
		let n = 0;
		for (let w = 0; w < 8; w++) {
			for (const t of core) { adv(TICK); account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
			for (let i = 0; i < 60; i++) { adv(TICK); const t = 'r:w' + w + '-' + i; account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
		}
		return n;
	},
	// A population that fits, with a real room wave each window.
	'live 4000, 400 rooms/window': (m) => {
		const { account, adv } = mk(m, 1000, 1e6);
		const core = Array.from({ length: 3600 }, (_, i) => 'c:' + i);
		let n = 0;
		for (let w = 0; w < 8; w++) {
			for (const t of core) { adv(TICK); account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
			for (let i = 0; i < 400; i++) { adv(TICK); const t = 'r:w' + w + '-' + i; account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
		}
		return n;
	},
	// A burst of distinct keys well past the bound, all live at once.
	'burst: 8000 new keys': (m) => {
		const { account, adv } = mk(m, 1000, 1e6);
		let n = 0;
		for (let i = 0; i < 8000; i++) { adv(TICK); const t = 'b:' + i; account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
		return n;
	},
	// Total turnover: a new key on every publish, everything reclaimable. The
	// shipped policy's known weak shape - it pays reclamation that this workload
	// does not need, to keep a guarantee that mixed populations do.
	'churn: new key per publish': (m) => {
		const { account, adv } = mk(m, 1000, 1e6);
		let n = 0;
		for (let w = 0; w < 30; w++) {
			for (let i = 0; i < 1200; i++) { adv(TICK); const t = 'g:w' + w + '-' + i; account.admit(t, null, 1, 1); account.charge(t, null, 1, 1, 80); n++; }
		}
		return n;
	}
};

// ---- enforcement oracle -----------------------------------------------------

const WINDOW = 1000;
const CEILING = 4;
const ATTEMPTS = 6;
const CORE = 3400;
const ROOMS = 500;

/**
 * Drive a population that fits inside the bound and count, independently of the
 * account, how many of a topic's own windows were admitted past its ceiling.
 */
function enforcement(mod) {
	let nowMs = 0;
	let evicted = 0;
	const account = mod.createEgressAccount({
		options: mod.normalizeEgressOptions({ windowMs: WINDOW, topic: { messages: CEILING } }),
		clock: () => nowMs,
		onEvicted: () => { evicted++; }
	});
	const core = Array.from({ length: CORE }, (_, i) => 'core:' + i);
	const admitted = new Map(core.map((t) => [t, []]));
	const tick = WINDOW / (CORE * ATTEMPTS + ROOMS);
	for (let w = 0; w < 8; w++) {
		for (const t of core) {
			for (let n = 0; n < ATTEMPTS; n++) {
				nowMs += tick;
				if (account.admit(t, null, 1, 1)) { account.charge(t, null, 1, 1, 10); admitted.get(t).push(nowMs); }
			}
		}
		for (let i = 0; i < ROOMS; i++) {
			nowMs += tick;
			const t = 'room:w' + w + '-' + i;
			if (account.admit(t, null, 1, 1)) account.charge(t, null, 1, 1, 10);
		}
	}
	let over = 0;
	for (const stamps of admitted.values()) {
		let start = null;
		let count = 0;
		for (const at of stamps) {
			if (start === null || at - start >= WINDOW) { if (count > CEILING) over++; start = at; count = 0; }
			count++;
		}
		if (count > CEILING) over++;
	}
	return { over, evicted };
}

// ---- run --------------------------------------------------------------------

const ROUNDS = 11;
const results = {};
for (const name of Object.keys(SHAPES)) { results[name] = {}; for (const [label] of ARMS) results[name][label] = []; }

for (const [, mod] of ARMS) for (const name of Object.keys(SHAPES)) { const warm = SHAPES[name]; warm(mod); }

for (let round = 0; round < ROUNDS; round++) {
	for (const name of Object.keys(SHAPES)) {
		// Rotate the arm order so warm-up and GC do not settle on one arm.
		const order = ARMS.slice(round % ARMS.length).concat(ARMS.slice(0, round % ARMS.length));
		for (const [label, mod] of order) {
			const t0 = process.hrtime.bigint();
			const shape = SHAPES[name];
			const n = shape(mod);
			results[name][label].push(Number(process.hrtime.bigint() - t0) / n);
		}
	}
}

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

console.log('ns per publish, median then 90th percentile, ' + ROUNDS + ' interleaved rounds, clock advances every publish');
console.log('the control arm is the shipped module loaded twice - its spread IS this shape\'s noise floor\n');
const width = Math.max(30, ...Object.keys(SHAPES).map((s) => s.length + 1));
console.log('shape'.padEnd(width), ...ARMS.map(([l]) => l.padStart(16)));
for (const name of Object.keys(SHAPES)) {
	console.log(
		name.padEnd(width),
		...ARMS.map(([l]) => (q(results[name][l], 0.5).toFixed(0) + ' (' + q(results[name][l], 0.9).toFixed(0) + ')').padStart(16))
	);
}

console.log('\nenforcement, independent replay oracle: over-ceiling windows / live evictions');
console.log('a population that FITS inside the bound must show 0 / 0\n');
for (const [label, mod] of ARMS) {
	const e = enforcement(mod);
	console.log('  ' + label.padEnd(width), String(e.over).padStart(8), '/', String(e.evicted).padStart(8));
}
