// A/B the framing guard that every request now passes through, in front of the
// lane where it costs the most: the built static answer, which is a Map lookup
// and a handful of header reads with nothing for a per-request check to hide
// behind.
//
// The rule itself lives in `framingRefusal` (src/runtime/utils/request-headers.js)
// and every lane that builds a header set asks it of the whole set for free.
// What this prices is the form that runs in FRONT of the lanes that answer
// without building one - a built asset, a prerendered page, the health probes -
// where the cost is paid per request forever. Three forms can be asked there:
// one header lookup, two, or a walk of the header list. Only the walk can see a
// framing header sent EMPTY or sent TWICE, because a lookup answers the empty
// string for an absent header and for an empty one alike.
//
// Arms, one route each, all serving through the BUILT `serveStatic` so the
// floor is the real lane and not a bare 200 (measuring against a bare 200
// overstates the guard, since the real lane does seven header reads of its own
// before it answers):
//
//   real       the built lane, no guard - the floor
//   telookup   plus ONE lookup, refusing a Transfer-Encoding that is present
//              and is not chunked - the only ambiguous shape the fast path can
//              be handed that a lookup can see at all
//   lookups    plus the two-name form; the second lookup buys nothing a lookup
//              can see, so this arm prices what that second one costs
//   walk       plus a walk of the header list, the only form that sees an empty
//              or repeated framing header
//   walkfast   plus the same walk with an integer compare on the key length
//              ahead of the string compare, a candidate for a cheaper walk
//   control    the floor a second time, which gives the run its noise band
//
// A delta inside the control's own spread is noise. Alternating every round
// controls for drift. The fixture must be built (`test/fixture/build`); without
// it there is no real lane to measure and this exits saying so.
//
// What it has answered so far, two runs of 6 rounds of 4s. On a host whose
// control arm drifted +0.80%: telookup +0.43%, lookups -2.43%, walk -7.68%,
// walkfast -8.22%. On a busier one, control -2.48%: telookup -4.38%, lookups
// -3.26%, walk -8.75%, walkfast -8.87%.
//
// What survives both: a walk costs about 8%, far outside either run's noise
// band, and the integer compare on the key length buys nothing. The two lookup
// forms sit within a few percent and swapped order between the runs - one
// lookup cannot really cost more than two - so they are not separable from
// noise on a loaded host, and the quiet run put one lookup inside the control's
// own drift. That is the whole basis for the shape: not that one lookup is free
// to three decimal places, but that the walk is the only arm whose cost is
// measurable on a host like this one - three times the dearest lookup arm on
// the quiet run, twice it on the busy one. Rerun on an idle host before moving
// the line.
//
// Usage:
//   node bench/39-request-framing-guard-ab.mjs [rounds] [duration]
// Defaults: 6 rounds of 5 seconds per arm. Honors PORT (default 9013).
//
// Environment: native (uWebSockets.js) plus autocannon; idle, fixed-power host.
// A machine running anything else reports its own load, not this guard.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { emptyEvidence, addEvidence, isClean, evidenceLabel } from './autocannon-evidence.mjs';
import { framingRefusal } from '../src/runtime/utils/request-headers.js';

const require = createRequire(import.meta.url);
const uWS = require('uWebSockets.js');
const autocannon = require('autocannon');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = parseInt(process.argv[2] || '6', 10);
const DURATION = parseInt(process.argv[3] || '5', 10);
const PORT = parseInt(process.env.PORT || '9013', 10);
const CONNECTIONS = 100;
const PIPELINING = 10;

const ASSET = Buffer.from('body{font:16px system-ui}main{max-width:60rem;margin:0 auto}\n'.repeat(4));

// ---- the built lane ---------------------------------------------------------
const builtStatic = path.join(ROOT, 'test/fixture/build/handler/static-assets.js');
if (!fs.existsSync(builtStatic)) {
	console.error('no built fixture at test/fixture/build - run `npx vite build` in test/fixture first.');
	process.exit(1);
}
const mod = await import('file:///' + builtStatic.replace(/\\/g, '/'));
const { staticCache } = await import('file:///' + path.join(ROOT, 'test/fixture/build/handler/state.js').replace(/\\/g, '/'));
const dir = fs.mkdtempSync(path.join(ROOT, 'bench', '_tmp_framing-'));
fs.writeFileSync(path.join(dir, 'asset.css'), ASSET);
mod.cacheDir(dir, '/built', false);
const entry = staticCache.get('/built/asset.css');
fs.rmSync(dir, { recursive: true, force: true });
if (!entry) {
	console.error('the built static lane did not cache the asset; nothing to measure against.');
	process.exit(1);
}

/** The shipped static answer, identical in every arm. */
function serveReal(res, req) {
	mod.serveStatic(
		res, entry, req.getHeader('accept-encoding'), req.getHeader('if-none-match'), false,
		req.getHeader('range'), req.getHeader('if-range'), req.getHeader('if-match'),
		req.getHeader('if-unmodified-since'), req.getHeader('if-modified-since')
	);
}

function refuse(res) {
	res.cork(() => {
		res.writeStatus('400 Bad Request');
		res.writeHeader('content-type', 'text/plain');
		res.end('Bad Request', true);
	});
}

// The two walking candidates. Neither ships, so both are transcribed here
// rather than imported: what ships is one header lookup, and these are what it
// is read against. Each gathers the two values a lookup cannot gather and then
// asks `framingRefusal`. They answer a repeat before asking that question
// rather than after, which is the opposite of the order the collector settled
// on; the work done per header is the same either way, which is what is being
// priced here.
function scanFramingWalk(req) {
	let transferEncoding;
	let contentLength;
	let repeated = null;
	req.forEach((key, value) => {
		if (key === 'transfer-encoding') {
			if (transferEncoding !== undefined && repeated === null) repeated = 'transfer-encoding';
			transferEncoding = value;
		} else if (key === 'content-length') {
			if (contentLength !== undefined && repeated === null) repeated = 'content-length';
			contentLength = value;
		}
	});
	if (repeated !== null) return repeated;
	return framingRefusal(transferEncoding, contentLength);
}

// The same walk, with each header paying an integer compare before it can pay a
// string compare.
const TE_LEN = 'transfer-encoding'.length;
const CL_LEN = 'content-length'.length;
function scanFramingByLength(req) {
	let transferEncoding;
	let contentLength;
	let repeated = null;
	req.forEach((key, value) => {
		const n = key.length;
		if (n === TE_LEN) {
			if (key !== 'transfer-encoding') return;
			if (transferEncoding !== undefined && repeated === null) repeated = 'transfer-encoding';
			transferEncoding = value;
		} else if (n === CL_LEN) {
			if (key !== 'content-length') return;
			if (contentLength !== undefined && repeated === null) repeated = 'content-length';
			contentLength = value;
		}
	});
	if (repeated !== null) return repeated;
	return framingRefusal(transferEncoding, contentLength);
}

const app = uWS.App()
	.get('/real', (res, req) => serveReal(res, req))
	.get('/control', (res, req) => serveReal(res, req))
	.get('/telookup', (res, req) => {
		// One lookup, for the only shape the fast path can be attacked with that
		// a lookup can see: a Transfer-Encoding naming something other than
		// chunked. Every other spelling is either refused by the parser before
		// this runs, or invisible to a lookup and left to the lanes that build a
		// header set.
		// The shipped CALL, verbatim. Not the shipped shape: production reaches
		// it through a wrapper closure around each route, so a served request
		// pays one call frame this arm does not.
		if (framingRefusal(req.getHeader('transfer-encoding') || undefined, undefined) !== null) {
			return refuse(res);
		}
		serveReal(res, req);
	})
	.get('/lookups', (res, req) => {
		if (framingRefusal(
			req.getHeader('transfer-encoding') || undefined,
			req.getHeader('content-length') || undefined
		) !== null) return refuse(res);
		serveReal(res, req);
	})
	.get('/walk', (res, req) => {
		if (scanFramingWalk(req) !== null) return refuse(res);
		serveReal(res, req);
	})
	.get('/walkfast', (res, req) => {
		if (scanFramingByLength(req) !== null) return refuse(res);
		serveReal(res, req);
	});

const ARMS = ['real', 'telookup', 'lookups', 'walk', 'walkfast', 'control'];

/**
 * @param {string} path
 * @param {ReturnType<typeof emptyEvidence>} evidence accumulated across rounds
 */
function runArm(path, evidence) {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${PORT}${path}`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
			// The header set a browser actually sends, because a walk's cost is
			// per header: a request with three headers would price a request
			// nobody makes.
			headers: {
				'accept': 'text/css,*/*;q=0.1',
				'accept-encoding': 'gzip, deflate, br',
				'accept-language': 'en-GB,en;q=0.9',
				'user-agent': 'bench/39',
				'sec-fetch-dest': 'style',
				'sec-fetch-mode': 'no-cors',
				'sec-fetch-site': 'same-origin',
				'referer': `http://127.0.0.1:${PORT}/`
			}
		}, (err, result) => {
			if (err) return reject(err);
			// Read the counters a rate alone hides: a saturated or erroring run
			// still prints a healthy-looking number.
			addEvidence(evidence, result);
			resolve(result.requests.average);
		});
	});
}

await new Promise((resolve, reject) => {
	app.listen('127.0.0.1', PORT, (token) => (token ? resolve(token) : reject(new Error(`port ${PORT} busy`))));
});

/** @type {Record<string, number[]>} */
const samples = Object.fromEntries(ARMS.map((arm) => [arm, []]));
/** @type {Record<string, ReturnType<typeof emptyEvidence>>} */
const evidence = Object.fromEntries(ARMS.map((arm) => [arm, emptyEvidence()]));

for (let round = 1; round <= ROUNDS; round++) {
	for (const arm of ARMS) {
		samples[arm].push(await runArm('/' + arm, evidence[arm]));
	}
	process.stdout.write(`round ${round}/${ROUNDS} done\n`);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const floor = median(samples.real);
const controlDrift = ((median(samples.control) - floor) / floor) * 100;

console.log(`\narms alternated, ${ROUNDS} rounds of ${DURATION}s, ${CONNECTIONS} connections, pipelining ${PIPELINING}`);
console.log('arm         req/s (median)   vs real   evidence');
let dirty = false;
for (const arm of ARMS) {
	const m = median(samples[arm]);
	const delta = ((m - floor) / floor) * 100;
	const clean = isClean(evidence[arm]);
	if (!clean) dirty = true;
	console.log(
		`${arm.padEnd(12)}${String(Math.round(m)).padStart(12)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%` +
		`   ${clean ? 'clean' : evidenceLabel(evidence[arm])}`
	);
}

console.log(`\nThe control arm is the same code as 'real'. It drifted ${controlDrift >= 0 ? '+' : ''}${controlDrift.toFixed(2)}%,`);
console.log("which is this run's noise band: read any arm inside it as unchanged.");
if (dirty) {
	console.log('\nAn arm reported errors, timeouts or non-2xx responses, so the rates above are');
	console.log('NOT comparable: the run saturated or something answered wrongly. Run it again.');
}
if (Math.abs(controlDrift) >= 3) {
	console.log('\nThe control drifted 3% or more from the arm it duplicates, so this host was not');
	console.log('still enough to price a per-request check. Run it again on an idle machine.');
}
// A walk of the whole header list cannot come back FASTER than reading two
// named headers out of it. When it does, the host moved more than the thing
// being measured, whatever the control arm happened to report.
//
// Only that pair is checked. The two lookup arms differ by one header read and
// land within a few percent of each other, so which of them comes out ahead is
// a coin flip on any host; gating on their order would call half of the
// healthy runs broken.
if (median(samples.lookups) < median(samples.walk)) {
	console.log('\nThe walk arm came back faster than reading two named headers, which is not');
	console.log('an order the work can produce. This run measured the host, not the guard.');
}
process.exit(0);
