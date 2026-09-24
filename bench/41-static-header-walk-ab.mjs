// A/B one header walk against the lookups the built static lane makes today.
//
// The static and prerendered lanes read seven request headers by lookup
// (accept-encoding, if-none-match, range, if-range, if-match,
// if-unmodified-since, if-modified-since) and the route wrapper one more
// (transfer-encoding). A lookup cannot see a framing header sent empty or sent
// twice, and bench/39 priced a walk ADDED to the lookups at about 8%. This
// prices the walk INSTEAD of them: one pass that collects the same seven values
// and both framing headers, noticing an empty or repeated one on the way.
//
// Arms, one route each, all serving through the BUILT `serveStatic`:
//
//   lookups   the shipped shape: the framing lookup, then the seven lookups
//   walk      one req.forEach collecting all nine, refusing an ambiguous
//             framing header, then serveStatic with the collected values
//   control   `lookups` a second time, which gives the run its noise band
//
// What it has answered, on this host: 8 rounds of 5s with the control inside
// +0.15% of the arm it duplicates, the walk -9.49%; an earlier run on a busier
// host, control -5.97%, put it at -8.02%. Replacing the lookups saves nothing
// the walk does not spend again: the walk alone costs what bench/39 priced it
// at on top of them. The lane keeps its lookups.
//
// Usage:
//   node bench/41-static-header-walk-ab.mjs [rounds] [duration]
// Defaults: 6 rounds of 5 seconds per arm. Honors PORT (default 9015).

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
const PORT = parseInt(process.env.PORT || '9015', 10);
const CONNECTIONS = 100;
const PIPELINING = 10;

const ASSET = Buffer.from('body{font:16px system-ui}main{max-width:60rem;margin:0 auto}\n'.repeat(4));

const builtStatic = path.join(ROOT, 'test/fixture/build/handler/static-assets.js');
if (!fs.existsSync(builtStatic)) {
	console.error('no built fixture at test/fixture/build - run `npx vite build` in test/fixture first.');
	process.exit(1);
}
const mod = await import('file:///' + builtStatic.replace(/\\/g, '/'));
const { staticCache } = await import('file:///' + path.join(ROOT, 'test/fixture/build/handler/state.js').replace(/\\/g, '/'));
const dir = fs.mkdtempSync(path.join(ROOT, 'bench', '_tmp_walk-'));
fs.writeFileSync(path.join(dir, 'asset.css'), ASSET);
mod.cacheDir(dir, '/built', false);
const entry = staticCache.get('/built/asset.css');
fs.rmSync(dir, { recursive: true, force: true });
if (!entry) {
	console.error('the built static lane did not cache the asset; nothing to measure against.');
	process.exit(1);
}

function refuse(res) {
	res.cork(() => {
		res.writeStatus('400 Bad Request');
		res.writeHeader('content-type', 'text/plain');
		res.end('Bad Request', true);
	});
}

/** The shipped shape. */
function lookups(res, req) {
	if (framingRefusal(req.getHeader('transfer-encoding') || undefined, undefined) !== null) return refuse(res);
	mod.serveStatic(
		res, entry, req.getHeader('accept-encoding'), req.getHeader('if-none-match'), false,
		req.getHeader('range'), req.getHeader('if-range'), req.getHeader('if-match'),
		req.getHeader('if-unmodified-since'), req.getHeader('if-modified-since')
	);
}

/** The candidate: one pass, every value the lane needs, framing seen whole. */
function walk(res, req) {
	let acceptEncoding = '';
	let ifNoneMatch = '';
	let range = '';
	let ifRange = '';
	let ifMatch = '';
	let ifUnmodifiedSince = '';
	let ifModifiedSince = '';
	let te;
	let cl;
	let repeated = false;
	req.forEach((key, value) => {
		switch (key) {
			case 'accept-encoding': acceptEncoding = value; break;
			case 'if-none-match': ifNoneMatch = value; break;
			case 'range': range = value; break;
			case 'if-range': ifRange = value; break;
			case 'if-match': ifMatch = value; break;
			case 'if-unmodified-since': ifUnmodifiedSince = value; break;
			case 'if-modified-since': ifModifiedSince = value; break;
			case 'transfer-encoding': if (te !== undefined) repeated = true; te = value; break;
			case 'content-length': if (cl !== undefined) repeated = true; cl = value; break;
		}
	});
	if (repeated || framingRefusal(te, cl) !== null) return refuse(res);
	mod.serveStatic(res, entry, acceptEncoding, ifNoneMatch, false, range, ifRange, ifMatch, ifUnmodifiedSince, ifModifiedSince);
}

const app = uWS.App()
	.get('/lookups', lookups)
	.get('/control', lookups)
	.get('/walk', walk);

const ARMS = ['lookups', 'walk', 'control'];

function runArm(route, evidence) {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${PORT}${route}`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
			// A browser's header set: a walk's cost is per header.
			headers: {
				'accept': 'text/css,*/*;q=0.1',
				'accept-encoding': 'gzip, deflate, br',
				'accept-language': 'en-GB,en;q=0.9',
				'user-agent': 'bench/41',
				'sec-fetch-dest': 'style',
				'sec-fetch-mode': 'no-cors',
				'sec-fetch-site': 'same-origin',
				'referer': `http://127.0.0.1:${PORT}/`
			}
		}, (err, result) => {
			if (err) return reject(err);
			addEvidence(evidence, result);
			resolve(result.requests.average);
		});
	});
}

await new Promise((resolve, reject) => {
	app.listen('127.0.0.1', PORT, (token) => (token ? resolve(token) : reject(new Error(`port ${PORT} busy`))));
});

const samples = Object.fromEntries(ARMS.map((arm) => [arm, []]));
const evidence = Object.fromEntries(ARMS.map((arm) => [arm, emptyEvidence()]));
for (let round = 1; round <= ROUNDS; round++) {
	const order = round % 2 ? ARMS : [...ARMS].reverse();
	for (const arm of order) samples[arm].push(await runArm('/' + arm, evidence[arm]));
	process.stdout.write(`round ${round}/${ROUNDS} done\n`);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const floor = median(samples.lookups);
console.log(`\narms alternated, ${ROUNDS} rounds of ${DURATION}s, ${CONNECTIONS} connections, pipelining ${PIPELINING}`);
console.log('arm         req/s (median)   vs lookups   evidence');
for (const arm of ARMS) {
	const m = median(samples[arm]);
	const delta = ((m - floor) / floor) * 100;
	console.log(`${arm.padEnd(12)}${String(Math.round(m)).padStart(12)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%   ${isClean(evidence[arm]) ? 'clean' : evidenceLabel(evidence[arm])}`);
}
process.exit(0);
