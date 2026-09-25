// A/B the request-target guard in front of the lane where it costs the most:
// the built static answer.
//
// The guard refuses a target carrying a byte outside visible ASCII (0x21-0x7E)
// or a `#`, in the path or the query, with 400. The catch-all asks it in front
// of the built-asset lookup, so a built asset pays it on every request. The
// static lane already reads the path; what the guard adds there is a scan of
// it, one read of the query and a scan of that.
//
// Arms, one route each, all serving through the BUILT `serveStatic`:
//
//   real       the built lane, no guard - the floor
//   urlread    plus the path read the static lane makes anyway, so the arm
//              below is compared with a floor that already pays it
//   guard      plus the query read and the scan of both - the shipped check
//   control    the floor a second time, which gives the run its noise band
//
// A delta inside the control's own spread is noise. Alternating every round
// controls for drift. The fixture must be built (`test/fixture/build`).
//
// What it has answered, on this host, guard against urlread: -0.12% with the
// control at -2.49% (6 rounds, quiet); +1.28% with the control at +2.07% (10
// rounds, quiet); -3.05% with the control at -2.49% (6 rounds, taken while
// other work ran on the host). Inside the noise band on every quiet run.
//
// Usage:
//   node bench/40-request-target-guard-ab.mjs [rounds] [duration]
// Defaults: 6 rounds of 5 seconds per arm. Honors PORT (default 9014).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { emptyEvidence, addEvidence, isClean, evidenceLabel } from './autocannon-evidence.mjs';
import { invalidRequestTarget } from '../src/runtime/utils/request-target.js';

const require = createRequire(import.meta.url);
const uWS = require('uWebSockets.js');
const autocannon = require('autocannon');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = parseInt(process.argv[2] || '6', 10);
const DURATION = parseInt(process.argv[3] || '5', 10);
const PORT = parseInt(process.env.PORT || '9014', 10);
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
const dir = fs.mkdtempSync(path.join(ROOT, 'bench', '_tmp_target-'));
fs.writeFileSync(path.join(dir, 'asset.css'), ASSET);
mod.cacheDir(dir, '/built', false);
const entry = staticCache.get('/built/asset.css');
fs.rmSync(dir, { recursive: true, force: true });
if (!entry) {
	console.error('the built static lane did not cache the asset; nothing to measure against.');
	process.exit(1);
}

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
		res.end('Bad Request');
	});
}

let sink = 0;
const app = uWS.App()
	.get('/real', (res, req) => serveReal(res, req))
	.get('/control', (res, req) => serveReal(res, req))
	.get('/urlread', (res, req) => {
		sink += req.getUrl().length;
		serveReal(res, req);
	})
	.get('/guard', (res, req) => {
		const url = req.getUrl();
		sink += url.length;
		if (invalidRequestTarget(url, req.getQuery())) return refuse(res);
		serveReal(res, req);
	});

const ARMS = ['real', 'urlread', 'guard', 'control'];

function runArm(route, evidence) {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${PORT}${route}?v=1`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
			headers: {
				'accept': 'text/css,*/*;q=0.1',
				'accept-encoding': 'gzip, deflate, br',
				'accept-language': 'en-GB,en;q=0.9',
				'user-agent': 'bench/40',
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
const floor = median(samples.real);
const urlFloor = median(samples.urlread);
const controlDrift = ((median(samples.control) - floor) / floor) * 100;

console.log(`\narms alternated, ${ROUNDS} rounds of ${DURATION}s, ${CONNECTIONS} connections, pipelining ${PIPELINING}`);
console.log('arm         req/s (median)   vs real   evidence');
for (const arm of ARMS) {
	const m = median(samples[arm]);
	const delta = ((m - floor) / floor) * 100;
	console.log(`${arm.padEnd(12)}${String(Math.round(m)).padStart(12)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%   ${isClean(evidence[arm]) ? 'clean' : evidenceLabel(evidence[arm])}`);
}
const guardVsUrl = ((median(samples.guard) - urlFloor) / urlFloor) * 100;
console.log(`\nguard vs urlread (what the static lane pays): ${guardVsUrl >= 0 ? '+' : ''}${guardVsUrl.toFixed(2)}%`);
console.log(`control drift (noise band): ${controlDrift >= 0 ? '+' : ''}${controlDrift.toFixed(2)}%`);
if (sink === -1) console.log('unreachable');
process.exit(0);
