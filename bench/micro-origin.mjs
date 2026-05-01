// Microbenchmark: A/B test the cost of moving the WebSocket Origin
// validation from an inline 4-level-nested ladder in handler.js to a
// single helper call (isOriginAllowed in files/utils.js).
//
// Same alternating-round methodology as bench/micro-utils.mjs:
// each variant runs N iterations per round, R rounds, alternating;
// reports median + stddev + delta + verdict.
//
// The Origin check runs once per WebSocket upgrade (per new connection),
// so this is per-request not per-message. Still on a hot path under
// high-fan-in workloads.
//
// Usage:
//   node bench/micro-origin.mjs [iterations] [rounds]
// Defaults: 5_000_000 iterations, 10 rounds.

import { isOriginAllowed as extracted } from '../files/utils.js';

const ITERATIONS = parseInt(process.argv[2] || '5000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

// Local copy matching the previous inline form in handler.js. Keeps
// the same control flow (one `let allowed = false` plus branches).
function inline(reqOrigin, headers, ctx) {
	if (ctx.allowedOrigins === '*') return true;
	let allowed = false;
	if (!reqOrigin) {
		allowed = ctx.hasUpgradeHook;
	} else if (ctx.allowedOrigins === 'same-origin') {
		try {
			const parsed = new URL(reqOrigin);
			const requestHost = (ctx.hostHeader && headers[ctx.hostHeader]) || headers['host'];
			if (!requestHost) {
				allowed = false;
			} else {
				const requestScheme = ctx.protocolHeader
					? (headers[ctx.protocolHeader] || (ctx.isTls ? 'https' : 'http'))
					: (ctx.isTls ? 'https' : 'http');
				const requestPort = ctx.portHeader ? headers[ctx.portHeader] : undefined;
				let expectedHost = requestHost;
				if (requestPort) {
					expectedHost = requestHost.replace(/:\d+$/, '') + ':' + requestPort;
				}
				const defaultPort = requestScheme === 'https' ? '443' : '80';
				expectedHost = expectedHost.replace(':' + defaultPort, '');
				allowed = parsed.host === expectedHost && parsed.protocol === requestScheme + ':';
			}
		} catch {
			allowed = false;
		}
	} else if (Array.isArray(ctx.allowedOrigins)) {
		allowed = ctx.allowedOrigins.includes(reqOrigin);
	}
	return allowed;
}

// Realistic input mix. The Origin validation in production sees a
// blend of same-origin success (the common case for a browser app
// hosted at the same origin), '*' wildcard (some public APIs), array
// allowlist (typical multi-tenant), and the rare malformed Origin.
const INPUTS = [
	// Same-origin success (browser app, no proxy headers)
	{
		reqOrigin: 'https://example.com',
		headers: { host: 'example.com', origin: 'https://example.com' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: false }
	},
	// Same-origin success with default port stripping
	{
		reqOrigin: 'https://example.com',
		headers: { host: 'example.com:443', origin: 'https://example.com' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: false }
	},
	// Same-origin success with proxy headers
	{
		reqOrigin: 'https://api.example.com',
		headers: {
			host: 'internal',
			origin: 'https://api.example.com',
			'x-forwarded-host': 'api.example.com',
			'x-forwarded-proto': 'https'
		},
		ctx: {
			allowedOrigins: 'same-origin',
			hostHeader: 'x-forwarded-host',
			protocolHeader: 'x-forwarded-proto',
			isTls: false,
			hasUpgradeHook: true
		}
	},
	// Same-origin reject (mismatched host)
	{
		reqOrigin: 'https://evil.com',
		headers: { host: 'example.com', origin: 'https://evil.com' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: false }
	},
	// Wildcard
	{
		reqOrigin: 'https://anywhere.com',
		headers: { host: 'example.com', origin: 'https://anywhere.com' },
		ctx: { allowedOrigins: '*', isTls: true, hasUpgradeHook: false }
	},
	// Array allowlist member
	{
		reqOrigin: 'https://app.example.com',
		headers: { host: 'api.example.com', origin: 'https://app.example.com' },
		ctx: {
			allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
			isTls: true,
			hasUpgradeHook: false
		}
	},
	// Array allowlist non-member
	{
		reqOrigin: 'https://other.com',
		headers: { host: 'api.example.com', origin: 'https://other.com' },
		ctx: {
			allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
			isTls: true,
			hasUpgradeHook: false
		}
	},
	// No Origin header, no upgrade hook -> reject
	{
		reqOrigin: undefined,
		headers: { host: 'example.com' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: false }
	},
	// No Origin header with upgrade hook -> accept (non-browser client)
	{
		reqOrigin: undefined,
		headers: { host: 'example.com' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: true }
	},
	// Malformed Origin header (URL parse throws)
	{
		reqOrigin: 'not a url',
		headers: { host: 'example.com', origin: 'not a url' },
		ctx: { allowedOrigins: 'same-origin', isTls: true, hasUpgradeHook: false }
	}
];

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function runOnce(fn) {
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const input = INPUTS[i % INPUTS.length];
		if (fn(input.reqOrigin, input.headers, input.ctx)) acc++;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds`);
console.log(`isOriginAllowed   (input mix: 10 cases incl. wildcard, same-origin pass/fail, array, malformed)`);

// Warmup
for (let i = 0; i < 3; i++) { runOnce(inline); runOnce(extracted); }

const inlineMs = [];
const extractedMs = [];
let aSum = 0, bSum = 0;
for (let r = 0; r < ROUNDS; r++) {
	const a = runOnce(inline); aSum += a.acc; inlineMs.push(a.ms);
	const b = runOnce(extracted); bSum += b.acc; extractedMs.push(b.ms);
	process.stdout.write(`  Round ${r + 1}/${ROUNDS}: inline ${a.ms.toFixed(1)}ms  extracted ${b.ms.toFixed(1)}ms\n`);
}

if (aSum !== bSum) {
	console.log(`  WARNING: accumulator mismatch inline=${aSum} extracted=${bSum} (functional drift)`);
}

const aMed = median(inlineMs);
const bMed = median(extractedMs);
const aSd = stddev(inlineMs);
const bSd = stddev(extractedMs);
// Positive delta = extracted slower (took longer) = bad
const deltaPct = ((bMed - aMed) / aMed) * 100;
const noiseFloor = (aSd / aMed) * 100;

console.log(`  ${'inline'.padEnd(20)} median ${aMed.toFixed(2).padStart(8)}ms  +/- ${aSd.toFixed(2)}`);
console.log(`  ${'extracted'.padEnd(20)} median ${bMed.toFixed(2).padStart(8)}ms  +/- ${bSd.toFixed(2)}`);
console.log(`  ${'delta (slowdown)'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = extracted slower)`);
if (Math.abs(deltaPct) <= noiseFloor) {
	console.log(`  VERDICT: noise (within baseline stddev ${noiseFloor.toFixed(2)}%) -> safe to extract`);
} else if (deltaPct < 0) {
	console.log(`  VERDICT: extracted FASTER by ${Math.abs(deltaPct).toFixed(2)}% -> safe to extract`);
} else if (deltaPct < 1) {
	console.log(`  VERDICT: extracted slower by <1% (${deltaPct.toFixed(2)}%) -> borderline`);
} else {
	console.log(`  VERDICT: extracted slower by ${deltaPct.toFixed(2)}% -> KEEP INLINE`);
}
console.log();
