// Price the Host check in the origin the SSR, admin and auth lanes build.
//
// With no ORIGIN configured, `get_origin` (handler/config.js) builds the origin
// every rendered request's URL is resolved against. It now holds the host to
// the authority grammar and a port header to digits (`originFromHeaders`,
// utils/origin.js) behind a try/catch that warns once about a refused proxy
// header. This is per rendered request, so it is priced against the old body
// and against the `new Request()` the same lane builds right after it.
//
// Arms, each over the same header sets:
//
//   before   the old get_origin body, copied from config.js before the change
//   after    the shipped originFromHeaders, wrapped the way get_origin wraps it
//   control  `before` a second time, which gives the run its noise band
//   request  `new Request(origin + url, { method, headers })` alone, the work
//            the lane does next, for scale
//
// Two configurations: no proxy headers (the default), and PROTOCOL_HEADER +
// HOST_HEADER + PORT_HEADER set. A second table prices the same-origin
// `isOriginAllowed` against its old body with the same three arms. Prints the
// median ns per call.
//
// What it has answered, on this host (two runs of 7 rounds, ns per call):
// no proxy headers 10.0 -> 27.1 and 10.1 -> 26.9, control 10.0 and 10.1; the
// three proxy headers 161.7 -> 205.7 and 163.0 -> 204.7, control 166.8 and
// 160.3. `new Request()` alone took 1,833 to 2,656. So the check adds about
// 17 ns, or 43 ns behind a proxy, to a lane whose Request construction alone
// costs about two microseconds, before any render. The same-origin Origin
// check, run once per upgrade or auth POST, went 418.5 -> 466.6 and
// 418.1 -> 473.1 (control 428.3 and 428.6): about 50 ns on a check the
// `new URL()` of the Origin header dominates.
//
// Usage:
//   node bench/43-origin-host-check-cost.mjs [rounds]
// Defaults: 7 rounds of 1,000,000 calls per arm and header set (200,000 for
// the request arm).

import { originFromHeaders, isOriginAllowed } from '../src/runtime/utils/origin.js';

const ROUNDS = parseInt(process.argv[2] || '7', 10);
const CALLS = 1_000_000;
const REQUEST_CALLS = 200_000;

const PLAIN = { isTls: false, protocolHeader: '', hostHeader: '', portHeader: '' };
const PROXIED = { isTls: false, protocolHeader: 'x-forwarded-proto', hostHeader: 'x-forwarded-host', portHeader: 'x-forwarded-port' };

const BROWSER = {
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'accept-encoding': 'gzip, deflate, br, zstd',
	'accept-language': 'en-US,en;q=0.5',
	'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
	cookie: 'session=0123456789abcdef0123456789abcdef'
};

const SETS = {
	plain: {
		source: PLAIN,
		headers: [
			{ ...BROWSER, host: 'localhost:3000' },
			{ ...BROWSER, host: 'example.com' },
			{ ...BROWSER, host: 'www.example-shop.co.uk' },
			{ ...BROWSER, host: '[::1]:8080' }
		]
	},
	proxied: {
		source: PROXIED,
		headers: [
			{ ...BROWSER, host: '10.0.0.7:3000', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' },
			{ ...BROWSER, host: '10.0.0.7:3000', 'x-forwarded-host': 'www.example-shop.co.uk', 'x-forwarded-proto': 'https', 'x-forwarded-port': '8443' }
		]
	}
};

/** The old get_origin body, with its module-level config passed in. */
function before(headers, source) {
	const default_protocol = source.isTls ? 'https' : 'http';
	const protocol = source.protocolHeader
		? decodeURIComponent(headers[source.protocolHeader] || default_protocol)
		: default_protocol;
	if (protocol !== 'http' && protocol !== 'https') {
		throw new Error(`The ${source.protocolHeader} header specified '${protocol}' which is not a valid protocol.`);
	}
	const host = (source.hostHeader && headers[source.hostHeader]) || headers['host'];
	if (!host) throw new Error('Could not determine host. The request must have a host header.');
	const port = source.portHeader ? headers[source.portHeader] : undefined;
	if (port && isNaN(+port)) throw new Error(`The ${source.portHeader} header specified ${port} which is an invalid port.`);
	const hostWithoutPort = port ? host.replace(/:\d+$/, '') : host;
	return port ? `${protocol}://${hostWithoutPort}:${port}` : `${protocol}://${host}`;
}

let warned = false;
/** The shipped get_origin shape: originFromHeaders behind the warning's catch. */
function after(headers, source) {
	try {
		return originFromHeaders(headers, source);
	} catch (err) {
		if (!warned) warned = true;
		throw err;
	}
}

const ARMS = { before, after, control: before };

let sink = 0;
function run(fn, set) {
	const { headers, source } = set;
	const start = process.hrtime.bigint();
	for (let i = 0; i < CALLS; i++) sink += fn(headers[i % headers.length], source).length;
	return Number(process.hrtime.bigint() - start) / CALLS;
}

function runRequest(set) {
	const { headers, source } = set;
	const start = process.hrtime.bigint();
	for (let i = 0; i < REQUEST_CALLS; i++) {
		const h = headers[i % headers.length];
		sink += new Request(before(h, source) + '/blog/hello-world', { method: 'GET', headers: h }).url.length;
	}
	return Number(process.hrtime.bigint() - start) / REQUEST_CALLS;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const names = Object.keys(ARMS);

console.log(`${ROUNDS} rounds, median ns per call`);
console.log(''.padEnd(10) + [...names, 'request'].map((n) => n.padStart(10)).join(''));
for (const [label, set] of Object.entries(SETS)) {
	for (const name of names) run(ARMS[name], set);
	runRequest(set);
	/** @type {Record<string, number[]>} */
	const samples = Object.fromEntries([...names, 'request'].map((n) => [n, []]));
	for (let round = 0; round < ROUNDS; round++) {
		for (const name of round % 2 === 0 ? names : [...names].reverse()) samples[name].push(run(ARMS[name], set));
		samples.request.push(runRequest(set));
	}
	console.log(label.padEnd(10) + [...names, 'request'].map((n) => median(samples[n]).toFixed(1).padStart(10)).join(''));
}
// The same-origin Origin check (`isOriginAllowed`, per WebSocket upgrade and
// auth POST without a pinned ORIGIN) now refuses a Host that is not an
// authority before comparing, and merges PORT_HEADER through the shared helper.

/** The old same-origin branch, copied from utils/origin.js before the change. */
function originCheckBefore(reqOrigin, headers, ctx) {
	if (ctx.allowedOrigins === '*') return true;
	if (!reqOrigin) return ctx.hasUpgradeHook;
	try {
		const parsed = new URL(reqOrigin);
		const requestHost = (ctx.hostHeader && headers[ctx.hostHeader]) || headers['host'];
		if (!requestHost) return false;
		const requestScheme = ctx.protocolHeader
			? (headers[ctx.protocolHeader] || (ctx.isTls ? 'https' : 'http'))
			: (ctx.isTls ? 'https' : 'http');
		const requestPort = ctx.portHeader ? headers[ctx.portHeader] : undefined;
		let expectedHost = requestHost;
		if (requestPort) expectedHost = requestHost.replace(/:\d+$/, '') + ':' + requestPort;
		const defaultPort = requestScheme === 'https' ? '443' : '80';
		expectedHost = expectedHost.replace(new RegExp(':' + defaultPort + '$'), '');
		return parsed.host === expectedHost && parsed.protocol === requestScheme + ':';
	} catch {
		return false;
	}
}

const CHECK_CTX = { allowedOrigins: 'same-origin', isTls: false, hasUpgradeHook: false };
const CHECKS = [
	['http://localhost:3000', { host: 'localhost:3000' }],
	['http://example.com', { host: 'example.com' }],
	['http://www.example-shop.co.uk', { host: 'www.example-shop.co.uk' }]
];
const CHECK_ARMS = { before: originCheckBefore, after: isOriginAllowed, control: originCheckBefore };

function runCheck(fn) {
	const start = process.hrtime.bigint();
	for (let i = 0; i < CALLS; i++) {
		const [o, h] = CHECKS[i % CHECKS.length];
		if (fn(o, h, CHECK_CTX)) sink++;
	}
	return Number(process.hrtime.bigint() - start) / CALLS;
}

const checkNames = Object.keys(CHECK_ARMS);
for (const name of checkNames) runCheck(CHECK_ARMS[name]);
/** @type {Record<string, number[]>} */
const checkSamples = Object.fromEntries(checkNames.map((n) => [n, []]));
for (let round = 0; round < ROUNDS; round++) {
	for (const name of round % 2 === 0 ? checkNames : [...checkNames].reverse()) checkSamples[name].push(runCheck(CHECK_ARMS[name]));
}
console.log('');
console.log(''.padEnd(10) + checkNames.map((n) => n.padStart(10)).join(''));
console.log('isOrigin'.padEnd(10) + checkNames.map((n) => median(checkSamples[n]).toFixed(1).padStart(10)).join(''));
if (sink < 0) console.log(sink);
