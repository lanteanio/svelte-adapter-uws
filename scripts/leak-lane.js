// The standing leak lane: does this server's memory grow under a workload it
// should be able to sustain indefinitely?
//
// It spawns the REAL built fixture server - the production entry, not a test
// harness shim - drives it at a fixed rate with real clients, and reads its
// resident set through a probe the harness build alone exposes. Minutes, by
// design: a slope needs a window, and a window is what separates a leak from a
// working set still filling up. That is why this is its own command and its own
// job rather than a case inside the fast suite - a slow gate in the dev loop is
// a gate people stop running.
//
// WHAT IT REFUSES TO DO, and why each rule is here:
//
//   A SLOPE THROUGH A CLOUD IS NOT A TREND. Least squares fits a line through
//   anything, including noise, and the line it finds through a flat cloud tilts
//   with wherever the window happens to start and stop. The verdict therefore
//   needs the fit to EXPLAIN the samples: r-squared at or above 0.5, alongside
//   the slope and the monotonic fraction. Without it, a lane that runs long
//   enough eventually reports a leak on a healthy server.
//
//   A FORCED COLLECTION MANUFACTURES THE SIGNATURE IT LOOKS FOR. Sampling right
//   after `global.gc()` catches the process climbing back to its working set:
//   steep, near-perfectly linear, r-squared close to 1 - a textbook leak, drawn
//   by the measurement. So the baseline is collected, then the workload keeps
//   running through a resettle window that is deliberately NOT sampled, and only
//   then does the window open.
//
//   KEEPALIVE, ALWAYS. A fresh connection per request grows sockets, buffers and
//   TLS state in step with the request count, which reads as a heap leak and is
//   not one. The clients here hold their connections.
//
//   A GATE THAT CANNOT FAIL IS NOT A GATE. The self-check scenario arms a real
//   leak and requires the GROWTH GATE ITSELF to have detected it - a verdict
//   failing on error rate or latency creep is a failing verdict, not a
//   detected leak, and accepting it would let the lane pass its self-check
//   while blind to the one thing it plants. A lane that has quietly lost the
//   ability to detect one then says so, instead of reporting a pass.
//
// EXIT CODES. 0 clean; 1 a scenario's verdict failed (a leak, an error rate, a
// latency creep, or a self-check that did not detect its own planted leak);
// 2 the lane could not reach a verdict it trusts (the server never became
// ready, a window never settled, the warmup itself was unhealthy). The
// distinction matters in CI: 1 is the server's problem, 2 is the lane's.
//
// Usage:
//   node scripts/leak-lane.js                      all scenarios, default window
//   node scripts/leak-lane.js --scenario http      one scenario
//   node scripts/leak-lane.js --minutes 2          shorter window (floor 1)
//   node scripts/leak-lane.js --out <dir>          where the record is written

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { detectGrowth } from '../src/runtime/leak-detect.js';
import { buildFixtureOnce } from '../test/helpers/fixture-build.js';

const require = createRequire(import.meta.url);
const fixtureDir = fileURLToPath(new URL('../test/fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');

/** Where a local run leaves its record. Never TEMP: these are worth keeping. */
const DEFAULT_OUT = 'c:/Users/kevin/Git/__harness/leak-lane';

// ---------------------------------------------------------------------------
// Verdict rules. Pure, exported, and unit-tested in test/leak-lane-rules.test.js
// so the rules can be driven in milliseconds while the lane itself spends
// minutes. A rule nobody can exercise cheaply is a rule that rots.
// ---------------------------------------------------------------------------

/** Fit quality below which a slope is not evidence of anything. */
export const MIN_R_SQUARED = 0.5;
/** Share of requests allowed to fail across a window. */
export const MAX_ERROR_RATE = 0.005;
/** How much the window's p95 may exceed the warmed baseline's. */
export const MAX_P95_CREEP = 0.5;
/** Bytes of resident growth across the window that count as flat. */
export const RSS_TOLERANCE_BYTES = 16 * 1024 * 1024;
/** Bytes per sample below which a slope is not worth escalating. */
export const RSS_MIN_SLOPE_BYTES = 256 * 1024;
/** Load applied before anything is measured, so the working set is filled first. */
export const WARMUP_MS = 60000;
/** Worked but unsampled after the forced collection, before the settle probe begins. */
export const RESETTLE_MS = 20000;

/**
 * @param {number[]} values
 * @param {number} p in [0,1]
 */
export function quantile(values, p) {
	if (values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Turn one scenario's measurements into a verdict.
 *
 * Three independent gates, each reported whether or not it fired, because "no
 * leak" is only meaningful next to what else was true at the time: a window
 * that lost 4% of its requests has not proved the memory is flat, it has proved
 * the server stopped answering.
 *
 * @param {{ rss: number[], errors: number, requests: number, baselineP95: number, windowP95: number, settled: boolean }} m
 * @param {{ minRSquared?: number, maxErrorRate?: number, maxP95Creep?: number, tolerance?: number, minSlope?: number }} [opts]
 */
export function judge(m, opts = {}) {
	const minRSquared = opts.minRSquared ?? MIN_R_SQUARED;
	const maxErrorRate = opts.maxErrorRate ?? MAX_ERROR_RATE;
	const maxP95Creep = opts.maxP95Creep ?? MAX_P95_CREEP;

	const growth = detectGrowth(m.rss, {
		warmup: 0,
		tolerance: opts.tolerance ?? RSS_TOLERANCE_BYTES,
		minSlope: opts.minSlope ?? RSS_MIN_SLOPE_BYTES,
		minRSquared,
		// The kernel's monotonic vote is switched OFF here, deliberately. It was
		// built for the simulator's structural sizes - a Map that leaks really
		// does only grow - and a resident set does not behave that way at all:
		// it wanders by several MiB between samples while V8 collects, so a
		// genuinely leaking server still steps backwards a third of the time.
		// Demanding 90% non-decreasing samples would make this gate unable to
		// fire, which is worse than no gate. The fit quality is what carries the
		// noise judgment here instead.
		minMonotonicFraction: 0
	});

	const errorRate = m.requests > 0 ? m.errors / m.requests : 0;
	// A baseline of zero cannot be exceeded by any multiple of itself, so a
	// missing baseline is a health problem rather than a passing creep gate.
	const p95Creep = m.baselineP95 > 0 ? (m.windowP95 - m.baselineP95) / m.baselineP95 : null;

	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const health = [];

	if (!m.settled) health.push('the resident set never settled before the window opened, so nothing measured here is a baseline');
	if (m.rss.length < 2) health.push(`only ${m.rss.length} resident-set sample(s): too short a window to fit anything`);
	if (p95Creep === null) health.push('no warmed baseline latency, so the creep gate could not run');

	if (growth.leaking) {
		failures.push(
			`resident set grew ${(growth.delta / 1048576).toFixed(1)} MiB over ${growth.n} samples ` +
			`(slope ${(growth.slope / 1024).toFixed(0)} KiB/sample, r-squared ${growth.rSquared.toFixed(2)}, ` +
			`monotonic ${(growth.monotonicFraction * 100).toFixed(0)}%)`
		);
	}
	if (errorRate > maxErrorRate) {
		failures.push(`${(errorRate * 100).toFixed(2)}% of ${m.requests} requests failed, over the ${(maxErrorRate * 100).toFixed(2)}% ceiling`);
	}
	if (p95Creep !== null && p95Creep > maxP95Creep) {
		failures.push(
			`p95 latency crept ${(p95Creep * 100).toFixed(0)}% (${m.baselineP95.toFixed(1)}ms warmed to ${m.windowP95.toFixed(1)}ms), ` +
			`over the ${(maxP95Creep * 100).toFixed(0)}% ceiling`
		);
	}

	return { growth, errorRate, p95Creep, failures, health, failing: failures.length > 0 };
}

/**
 * The self-check's own verdict, TYPED on the gate under test.
 *
 * The planted defect is memory growth, so only the growth gate detecting it
 * proves the lane can see one. `record.failing` alone is not detection: a
 * deliberately leaking server can also shed requests or creep its p95, and a
 * self-check that accepted any failing verdict would pass while the growth
 * gate itself was blind - the exact quiet death the scenario exists to catch.
 *
 * @param {{ growth?: { leaking?: boolean }, failing?: boolean, failures?: string[] }} record
 * @returns {{ pass: boolean, reason: string }}
 */
export function selfCheckVerdict(record) {
	if (record.growth && record.growth.leaking === true) {
		return { pass: true, reason: 'the planted leak was detected by the growth gate' };
	}
	if (record.failing) {
		return {
			pass: false,
			reason: 'the verdict failed (' + (record.failures || []).join('; ') +
				') but the planted memory growth itself went undetected, so the growth gate cannot be trusted'
		};
	}
	return { pass: false, reason: 'a deliberate leak went undetected, so no other verdict here can be trusted' };
}

// ---------------------------------------------------------------------------
// The lane itself.
// ---------------------------------------------------------------------------

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the built fixture as a real child process with the leak probe armed.
 *
 * `--expose-gc` is passed to the CHILD only, and the probe route answers only
 * while `LEAK_PROBE` is set, so neither reaches a build anyone deploys.
 *
 * @param {number} port
 */
async function bootServer(port) {
	const built = buildFixtureOnce('default');
	if (!built) throw new Error('fixture build failed - cannot drive a server that was not built');

	const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), LEAK_PROBE: '1' };
	delete env.CLUSTER_WORKERS;
	delete env.CLUSTER_MODE;
	const child = spawn(process.execPath, ['--expose-gc', builtEntry], {
		cwd: fixtureDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env
	});

	let output = '';
	const ready = await new Promise((resolve) => {
		const scan = (buf) => {
			output += buf.toString();
			if (output.includes('Ready for traffic')) resolve(true);
		};
		child.stdout.on('data', scan);
		child.stderr.on('data', scan);
		child.on('exit', () => resolve(false));
		setTimeout(() => resolve(false), 60000);
	});
	if (!ready) {
		child.kill('SIGKILL');
		throw new Error(`server never reported ready\n${output}`);
	}
	return { child, output: () => output };
}

/** One keepalive HTTP agent per client, so connections are held, not churned. */
function keepaliveAgent() {
	return new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
}

/**
 * @param {number} port @param {string} pathname @param {http.Agent} agent
 * @returns {Promise<{ ms: number, ok: boolean, body: string }>}
 */
function get(port, pathname, agent) {
	const started = performance.now();
	return new Promise((resolve) => {
		const req = http.request({ host: '127.0.0.1', port, path: pathname, agent, method: 'GET' }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ ms: performance.now() - started, ok: res.statusCode === 200, body }));
		});
		req.on('error', () => resolve({ ms: performance.now() - started, ok: false, body: '' }));
		req.end();
	});
}

/** @param {number} port @param {string} op */
async function probe(port, op, agent) {
	const res = await get(port, `/__leak?op=${op}`, agent);
	if (!res.ok) throw new Error(`leak probe "${op}" answered ${res.body || 'nothing'} - is LEAK_PROBE armed in the child?`);
	return JSON.parse(res.body);
}

/**
 * Drive one scenario's workload at a FIXED rate for `ms`, recording every
 * request's outcome.
 *
 * Fixed rate rather than closed-loop: a closed loop slows down when the server
 * does, which hides exactly the latency creep the gate is looking for.
 *
 * @param {{ port: number, ms: number, ratePerSecond: number, drive: (i: number) => Promise<{ ms: number, ok: boolean }> }} spec
 */
async function driveAtRate({ ms, ratePerSecond, drive, startIndex = 0 }) {
	// Issued in ticks, against an ABSOLUTE schedule.
	//
	// One request per `setTimeout(1000 / rate)` is the obvious spelling and it
	// cannot hold a rate: the platform timer's granularity is the floor on every
	// gap, so a 20 ms interval became roughly 30 ms here and the lane delivered
	// two thirds of the rate it printed. Ticking every 25 ms and issuing the
	// whole tick's worth is granularity-proof, and computing each tick's due
	// time from the START rather than from the last one keeps the error from
	// accumulating across a window measured in minutes.
	const tickMs = 25;
	const perTick = Math.max(1, Math.round((ratePerSecond * tickMs) / 1000));
	const began = performance.now();
	const ticks = Math.max(1, Math.round(ms / tickMs));
	/** @type {Promise<{ ms: number, ok: boolean }>[]} */
	const inFlight = [];
	let issued = startIndex;
	for (let tick = 0; tick < ticks; tick++) {
		for (let i = 0; i < perTick; i++) inFlight.push(drive(issued++));
		const due = began + (tick + 1) * tickMs;
		const wait = due - performance.now();
		if (wait > 0) await sleep(wait);
	}
	const settledResults = await Promise.all(inFlight);
	const elapsedMs = performance.now() - began;
	return {
		requests: settledResults.length,
		errors: settledResults.filter((r) => !r.ok).length,
		latencies: settledResults.map((r) => r.ms),
		// Reported rather than assumed: a lane that prints the rate it ASKED for
		// describes a workload it may not have applied.
		achievedRatePerSecond: elapsedMs > 0 ? (settledResults.length * 1000) / elapsedMs : 0,
		nextIndex: issued
	};
}

export const SCENARIOS = ['http', 'ws', 'selfcheck'];

/**
 * @param {string} name
 * @param {{ minutes: number }} opts
 */
async function runScenario(name, { minutes }) {
	const port = await freePort();
	const { child, output } = await bootServer(port);
	const probeAgent = keepaliveAgent();
	/** @type {any[]} */
	const agents = [];
	/** @type {import('ws').WebSocket[]} */
	const sockets = [];

	try {
		const clients = 4;
		for (let i = 0; i < clients; i++) agents.push(keepaliveAgent());

		/** @type {(i: number) => Promise<{ ms: number, ok: boolean }>} */
		let drive;
		if (name === 'ws') {
			const { WebSocket } = require('ws');
			for (let i = 0; i < clients; i++) {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
				await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
				sockets.push(ws);
			}
			// Topic churn on held connections: subscribe, publish, unsubscribe.
			// The connections do not move, so anything that grows here grows per
			// TOPIC rather than per socket - which is the shape a registry leak
			// has and a socket-pool artifact does not.
			drive = async (i) => {
				const ws = sockets[i % sockets.length];
				const topic = `leak-lane-${i % 512}`;
				const started = performance.now();
				try {
					ws.send(JSON.stringify({ type: 'subscribe', topic, ref: i }));
					ws.send(JSON.stringify({ type: 'broadcast', topic, payload: { i } }));
					ws.send(JSON.stringify({ type: 'revoke-topic', topic }));
					return { ms: performance.now() - started, ok: ws.readyState === 1 };
				} catch {
					return { ms: performance.now() - started, ok: false };
				}
			};
		} else if (name === 'selfcheck') {
			// A real leak, armed through the probe: each call retains a buffer
			// inside the SERVER. If the verdict below comes back clean, the lane
			// has lost the ability to detect a leak and says so.
			drive = async (i) => {
				const res = await get(port, '/__leak?op=retain&kb=64', agents[i % agents.length]);
				return { ms: res.ms, ok: res.ok };
			};
		} else {
			drive = async (i) => {
				const res = await get(port, '/', agents[i % agents.length]);
				return { ms: res.ms, ok: res.ok };
			};
		}

		const ratePerSecond = name === 'ws' ? 200 : 50;

		// WARMUP. Fills the working set, JITs the hot paths and gives the creep
		// gate a baseline taken under the same load as the window.
		//
		// A minute, not the twenty seconds that felt sufficient. This server's
		// resident set reaches its working set in STEPS - it holds a plateau for
		// half a minute, then jumps twenty or forty MiB and holds again - so a
		// short warmup hands the window a staircase and the fit reads it as a
		// climb. Measured on the HTTP scenario: a window opened after twenty
		// seconds reported 79 MiB of growth at r-squared 0.89, and the same
		// server's last thirty samples were flat to within 2 MiB. The growth was
		// real and it was the working set, which is exactly the reading this
		// lane must not send anyone chasing.
		let nextIndex = 0;
		const warm = await driveAtRate({ ms: WARMUP_MS, ratePerSecond, drive, startIndex: nextIndex });
		nextIndex = warm.nextIndex;
		const warmErrorRate = warm.requests > 0 ? warm.errors / warm.requests : 1;
		const baselineP95 = quantile(warm.latencies, 0.95);

		// SETTLE. Collect, then keep working through a resettle window that is
		// deliberately NOT sampled, and only open the window once the reading has
		// stopped MOVING - in either direction.
		//
		// Both halves matter, and the second is the one that is easy to get
		// backwards. After a forced collection the resident set does not drift
		// down to a resting point; it CLIMBS back to the working set, steeply and
		// almost perfectly linearly. A settle rule that waits only for the
		// reading to stop falling therefore reports "settled" at the exact
		// instant the climb begins, and the window opens on the most
		// leak-shaped stretch a healthy process ever produces. Stability here
		// means a run of rounds inside a band, not one round that failed to
		// fall - see the run length below, which is calibrated against this
		// server's own plateaus.
		await probe(port, 'gc', probeAgent);
		nextIndex = (await driveAtRate({ ms: RESETTLE_MS, ratePerSecond, drive, startIndex: nextIndex })).nextIndex;
		let settled = false;
		let previous = null;
		let stableRounds = 0;
		/** Every settle reading, kept in the record: a false alarm is unarguable with them and guesswork without. */
		const settleReadings = [];
		for (let round = 0; round < 30; round++) {
			nextIndex = (await driveAtRate({ ms: 4000, ratePerSecond, drive, startIndex: nextIndex })).nextIndex;
			const { rss } = await probe(port, 'mem', probeAgent);
			settleReadings.push(rss);
			if (previous !== null) {
				// Relative band with an absolute floor: a 400 MiB working set
				// wobbling by 3 MiB is as settled as a 100 MiB one wobbling by 1.
				const band = Math.max(2 * 1048576, previous * 0.01);
				stableRounds = Math.abs(rss - previous) <= band ? stableRounds + 1 : 0;
				// EIGHT consecutive rounds - half a minute of not moving. A plateau is not
				// a resting point on this server: it holds one for thirty to sixty
				// seconds, jumps twenty to forty MiB, and holds again. Two rounds
				// inside the band was satisfied by the middle of a plateau, and so
				// was three - both opened the window just before the next step,
				// which the fit then read as a leak at r-squared 0.6. The
				// stability requirement has to outlast the plateaus it must not
				// be fooled by.
				if (stableRounds >= 8) { settled = true; break; }
			}
			previous = rss;
		}

		// WINDOW. Sample every 2s while the same workload continues.
		/** @type {number[]} */
		const rss = [];
		const windowMs = Math.max(1, minutes) * 60000;
		const sliceMs = 2000;
		let requests = 0;
		let errors = 0;
		/** @type {number[]} */
		const latencies = [];
		/** Per-slice achieved rate, so the record states the workload applied rather than the one requested. */
		const achieved = [];
		for (let elapsed = 0; elapsed < windowMs; elapsed += sliceMs) {
			const slice = await driveAtRate({ ms: sliceMs, ratePerSecond, drive, startIndex: nextIndex });
			nextIndex = slice.nextIndex;
			achieved.push(slice.achievedRatePerSecond);
			requests += slice.requests;
			errors += slice.errors;
			latencies.push(...slice.latencies);
			rss.push((await probe(port, 'mem', probeAgent)).rss);
		}

		const verdict = judge({
			rss, errors, requests, baselineP95,
			windowP95: quantile(latencies, 0.95),
			settled
		});

		// The warmup is held to the SAME error rate as the window, not to zero.
		// A stricter gate on the baseline than on the measurement is how a lane
		// starts failing for reasons nobody acts on.
		if (warmErrorRate > MAX_ERROR_RATE) {
			verdict.health.push(`the warmup itself lost ${(warmErrorRate * 100).toFixed(2)}% of ${warm.requests} requests`);
		}

		return {
			scenario: name, port, ratePerSecond, minutes,
			requests, errors, baselineP95, windowP95: quantile(latencies, 0.95),
			rss, settled, settleReadings, warmRequests: warm.requests, warmErrors: warm.errors,
			achievedRatePerSecond: achieved.length > 0 ? achieved.reduce((a, b) => a + b, 0) / achieved.length : 0,
			...verdict
		};
	} finally {
		for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
		for (const agent of agents) agent.destroy();
		probeAgent.destroy();
		child.kill('SIGKILL');
		void output;
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const flag = (name, fallback) => {
		const at = argv.indexOf(`--${name}`);
		return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
	};
	const minutes = Math.max(1, Number(flag('minutes', '3')));
	const only = flag('scenario', 'all');
	const outDir = flag('out', DEFAULT_OUT);
	const scenarios = only === 'all' ? SCENARIOS : [only];
	if (!scenarios.every((s) => SCENARIOS.includes(s))) {
		console.error(`unknown scenario "${only}" - one of: ${SCENARIOS.join(', ')}, or all`);
		process.exit(2);
	}

	/** @type {any[]} */
	const records = [];
	let exit = 0;
	for (const name of scenarios) {
		console.log(`\n[leak-lane] ${name}: warmup ${WARMUP_MS / 1000}s, collect, resettle ${RESETTLE_MS / 1000}s unsampled, ` +
			`settle until steady, then a ${minutes} minute window`);
		let record;
		try {
			record = await runScenario(name, { minutes });
		} catch (err) {
			console.error(`[leak-lane] ${name}: HEALTH - ${err.message}`);
			records.push({ scenario: name, health: [err.message], failing: false });
			exit = Math.max(exit, 2);
			continue;
		}
		records.push(record);

		const rssMiB = record.rss.map((b) => (b / 1048576).toFixed(0)).join(' ');
		console.log(`[leak-lane] ${name}: ${record.requests} requests at ${record.achievedRatePerSecond.toFixed(0)}/s ` +
			`(asked ${record.ratePerSecond}/s), ${record.errors} failed, ` +
			`p95 ${record.baselineP95.toFixed(1)}ms warmed -> ${record.windowP95.toFixed(1)}ms`);
		console.log(`[leak-lane] ${name}: rss MiB over the window: ${rssMiB}`);
		console.log(`[leak-lane] ${name}: fit r-squared ${record.growth.rSquared.toFixed(2)}, verdict ${record.growth.reason}`);
		if (record.settleReadings) {
			console.log(`[leak-lane] ${name}: settle MiB before the window opened: ` +
				record.settleReadings.map((b) => (b / 1048576).toFixed(0)).join(' ') +
				(record.settled ? '' : ' (NEVER STEADY)'));
		}

		if (name === 'selfcheck') {
			// Inverted on purpose - this scenario is leaking by construction - and
			// typed on purpose: only the growth gate's own detection counts. See
			// selfCheckVerdict for why a failing verdict alone is not detection.
			const check = selfCheckVerdict(record);
			if (check.pass) {
				console.log(`[leak-lane] selfcheck: PASS - ${check.reason}`);
			} else {
				console.error(`[leak-lane] selfcheck: FAIL - ${check.reason}`);
				exit = Math.max(exit, 1);
			}
		} else if (record.failing) {
			for (const line of record.failures) console.error(`[leak-lane] ${name}: FAIL - ${line}`);
			exit = Math.max(exit, 1);
		} else {
			console.log(`[leak-lane] ${name}: PASS`);
		}
		for (const line of record.health) {
			console.error(`[leak-lane] ${name}: HEALTH - ${line}`);
			exit = Math.max(exit, 2);
		}
	}

	try {
		mkdirSync(outDir, { recursive: true });
		const file = path.join(outDir, `leak-lane-${process.pid}.json`);
		writeFileSync(file, JSON.stringify({ node: process.version, platform: process.platform, records }, null, '\t'));
		console.log(`\n[leak-lane] record written to ${file}`);
	} catch (err) {
		console.error(`[leak-lane] could not write the record: ${err.message}`);
	}

	process.exit(exit);
}

// Importing this module for its rules must not start a server.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(`[leak-lane] ${err.stack || err.message}`);
		process.exit(2);
	});
}
