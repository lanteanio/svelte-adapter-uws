// Price the catch-all's resolution gate on rendered requests.
//
// The gate in handler/request.js runs on every request that is not a built
// asset. It used to run only while the admin route was mounted, scanned for
// any dot or escape, and parsed and fully decoded every such path. It now runs
// for every app, refusing a target that resolves, decodes or strips onto an
// exact mount; it parses only a path that can drop a segment (a dot segment,
// `%2e`, a backslash) and decodes only ASCII escapes, so a dot inside a name
// (`/__data.json`, `/v1.2/x`) and an escaped non-ASCII name skip the parse.
//
// Arms, each over the same paths, with the adapter's default exact mounts
// registered through the real registry:
//
//   before     the gate as it stood, no admin route mounted (most apps)
//   beforeAdm  the gate as it stood, admin route mounted (svelte-realtime apps)
//   after      the gate as it stands, no admin route mounted
//   afterAdm   the gate as it stands, admin route mounted
//   control    `before` a second time, which gives the run its noise band
//
// The two gate bodies are copied from request.js, before and after the
// change; `entersExactMount` is the shipped one. Prints the median ns per call
// for each path, then over the whole mix.
//
// What it has answered, on this host (7 rounds; `before` -> `after`, then
// `beforeAdm` -> `afterAdm`, ns per call): `/` 3.1 -> 13.4 and 9.1 -> 13.5;
// `/blog/hello-world` 3.1 -> 26.6 and 9.3 -> 26.4; `/docs/v1.2/getting-started`
// 3.0 -> 30.6 and 321 -> 30.6; a data request 3.0 -> 64 and 331 -> 65;
// `/search/caf%C3%A9` 3.0 -> 81 and 584 -> 92; a dot segment, the one shape
// that still pays the URL parse, 3.0 -> 367 and 317 -> 376. The control arm
// stayed within 0.2 ns of `before`.
//
// Usage:
//   node bench/42-resolution-gate-cost.mjs [rounds]
// Defaults: 7 rounds of 1,000,000 calls per arm and path.

import { registerRoute, entersExactMount } from '../src/runtime/handler/route-registry.js';

const ROUNDS = parseInt(process.argv[2] || '7', 10);
const CALLS = 1_000_000;

const app = { get() {}, head() {}, post() {}, any() {}, ws() {} };
for (const p of ['/healthz', '/readyz', '/__ws/auth']) registerRoute(app, 'get', p, () => {});
registerRoute(app, 'any', '/__realtime/*', () => {});

const PATHS = [
	'/',
	'/blog/hello-world',
	'/docs/v1.2/getting-started',
	'/blog/hello-world/__data.json',
	'/search/caf%C3%A9',
	'/x/../blog'
];

const RESOLUTION_BASE = 'http://a';
const ADMIN_PREFIX = '/__realtime/';
const OLD_MAY_RESOLVE = /[.%\\\t\n\r]/;
const DROPS_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)|\\|%2e/i;
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
const asciiFromEscape = (_, hex) => String.fromCharCode(parseInt(hex, 16));

/** The gate before the change. @returns {boolean} whether it refuses */
function before(pathname, adminMounted) {
	if (ADMIN_PREFIX !== null && adminMounted && OLD_MAY_RESOLVE.test(pathname) &&
		!pathname.startsWith(ADMIN_PREFIX)) {
		try {
			const resolved = new URL(RESOLUTION_BASE + pathname).pathname;
			if (resolved.startsWith(ADMIN_PREFIX)) return true;
			if (resolved.includes('%') && decodeURIComponent(resolved).startsWith(ADMIN_PREFIX)) return true;
		} catch { /* not a path this check can rule on */ }
	}
	return false;
}

/** The gate after the change. @returns {boolean} whether it refuses */
function after(pathname, adminMounted, query) {
	if (entersExactMount(pathname, pathname, query)) return true;
	const dropsSegment = DROPS_SEGMENT.test(pathname);
	if (dropsSegment || pathname.includes('%')) {
		let resolved = pathname;
		if (dropsSegment) {
			try { resolved = new URL(RESOLUTION_BASE + pathname).pathname; } catch { /* read as sent */ }
		}
		const guardsPrefix = ADMIN_PREFIX !== null && adminMounted && !pathname.startsWith(ADMIN_PREFIX);
		if (entersExactMount(resolved, pathname, query)) return true;
		if (guardsPrefix && resolved.startsWith(ADMIN_PREFIX)) return true;
		if (resolved.includes('%')) {
			const decodedPath = resolved.replace(ASCII_ESCAPE, asciiFromEscape);
			if (entersExactMount(decodedPath, pathname, query)) return true;
			if (guardsPrefix && decodedPath.startsWith(ADMIN_PREFIX)) return true;
		}
	}
	return false;
}

const ARMS = {
	before: (p) => before(p, false),
	beforeAdm: (p) => before(p, true),
	after: (p) => after(p, false, undefined),
	afterAdm: (p) => after(p, true, undefined),
	control: (p) => before(p, false)
};

let sink = 0;
function run(fn, paths) {
	const start = process.hrtime.bigint();
	for (let i = 0; i < CALLS; i++) if (fn(paths[i % paths.length])) sink++;
	return Number(process.hrtime.bigint() - start) / CALLS;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const names = Object.keys(ARMS);

console.log(`${ROUNDS} rounds of ${CALLS} calls per arm, median ns per call`);
console.log(''.padEnd(32) + names.map((n) => n.padStart(10)).join(''));
for (const paths of [...PATHS.map((p) => [p]), PATHS]) {
	for (const name of names) run(ARMS[name], paths);
	/** @type {Record<string, number[]>} */
	const samples = Object.fromEntries(names.map((n) => [n, []]));
	for (let round = 0; round < ROUNDS; round++) {
		for (const name of round % 2 === 0 ? names : [...names].reverse()) samples[name].push(run(ARMS[name], paths));
	}
	const label = paths.length === 1 ? paths[0] : 'the mix';
	console.log(label.padEnd(32) + names.map((n) => median(samples[n]).toFixed(1).padStart(10)).join(''));
}
if (sink < 0) console.log(sink);
