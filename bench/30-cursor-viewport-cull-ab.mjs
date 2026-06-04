// Cursor viewport-culling perf gate. Three scenarios:
//
//   1. Cull reduction at scale. 5000 movers spread on a large board; 100
//      subscribers each report a 1920x1080 viewport at a random position
//      (the board is sized so a viewport holds ~100 movers). A = culling
//      off (every subscriber receives the full coalesced frame, the way the
//      shared C++ fan-out delivers it); B = culling on (each subscriber
//      receives only the movers inside its viewport). Reports the per-
//      subscriber entry-count and wire-byte reduction.
//
//   2. INDEX_CROSSOVER sweep. The same per-subscriber slice computed two
//      ways at a range of mover counts: a flat bounds scan over every mover
//      vs. building a transient cell index and walking only the viewport's
//      cells. Reports the crossover mover-count where the index starts to
//      win, which fixes the INDEX_CROSSOVER constant in server.js.
//
//   3. Lazy reporter gate. Enabling culling on a topic whose clients do NOT
//      report a viewport must NOT regress to one send per subscriber: the
//      flush stays on the shared C++ fan-out until a reporter exists. This
//      confirms the gate keeps "enable culling everywhere" free on the topics
//      that have no reporters.
//
// Pure JS, no uWS, no real WS. Scenario 1 drives the real tick scheduler so
// the 5000 movers coalesce into one flush (a short await lets the timer
// fire); scenarios 2-3 are synchronous micro-benchmarks. Deterministic via a
// seeded PRNG; runs in well under a second.

import { performance } from 'node:perf_hooks';
import { createCursor } from '../plugins/cursor/server.js';

const CURSOR = '__cursor:board';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG (mulberry32) so the bench is reproducible run to run.
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function mockWs(userData) {
	return { getUserData: () => userData };
}

// Walk-capable mock platform that accounts the position-frame entries and
// wire bytes on both the shared (publish) and per-subscriber (send) paths.
function walkPlatform() {
	const subscribers = new Map();
	const p = {
		entries: 0,
		bytes: 0,
		frames: 0,
		account(topic, event, data) {
			p.frames++;
			p.entries += Array.isArray(data) ? data.length : 1;
			try { p.bytes += Buffer.byteLength(JSON.stringify({ topic, event, data })); } catch { /* ignore */ }
		},
		publish(topic, event, data) { p.account(topic, event, data); return true; },
		send(ws, topic, event, data) { p.account(topic, event, data); return 1; },
		forEachSubscriber(fullTopic, fn) {
			const set = subscribers.get(fullTopic);
			if (set) for (const ws of set) fn(ws, ws.getUserData());
		},
		bufferedAmount() { return 0; },
		addSubscriber(ws, fullTopic) {
			let set = subscribers.get(fullTopic);
			if (!set) { set = new Set(); subscribers.set(fullTopic, set); }
			set.add(ws);
		},
		reset() { p.entries = 0; p.bytes = 0; p.frames = 0; }
	};
	return p;
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// ----------------------------------------------------------------------
// Scenario 1: cull reduction at scale
// ----------------------------------------------------------------------

async function runReductionScenario() {
	const MOVERS = 5000;
	const SUBSCRIBERS = 100;
	const BOARD = 10000; // square board; a 1920x1080 view holds ~100 movers
	const VW = 1920, VH = 1080;

	async function flushOnce(cullOn) {
		const cursors = createCursor({
			throttle: 0,
			topicThrottle: 16,
			viewport: cullOn ? { enabled: true } : undefined,
			select: (ud) => ({ id: ud.id })
		});
		const p = walkPlatform();
		const rand = rng(1234);

		for (let i = 0; i < SUBSCRIBERS; i++) {
			const ws = mockWs({ id: 's' + i });
			p.addSubscriber(ws, CURSOR);
			if (cullOn) {
				const x = rand() * (BOARD - VW);
				const y = rand() * (BOARD - VH);
				cursors.viewport(ws, 'board', { x, y, w: VW, h: VH, zoom: 1 });
			}
		}
		for (let i = 0; i < MOVERS; i++) {
			cursors.update(mockWs({ id: 'm' + i }), 'board', { x: rand() * BOARD, y: rand() * BOARD }, p);
		}
		// Drop the join frames; measure only the coalesced position flush.
		p.reset();
		await wait(40); // let the topicThrottle tick fire the single big flush
		const stats = cursors.stats();
		cursors.clear();
		return { entries: p.entries, bytes: p.bytes, frames: p.frames, stats };
	}

	const off = await flushOnce(false);
	const on = await flushOnce(true);

	// A delivers the shared frame to every subscriber, so the per-subscriber-
	// equivalent volume is one frame x SUBSCRIBERS.
	const offEntries = off.entries * SUBSCRIBERS;
	const offBytes = off.bytes * SUBSCRIBERS;

	console.log('\nScenario 1: ' + MOVERS + ' movers, ' + SUBSCRIBERS + ' subscribers, ' + VW + 'x' + VH + ' viewports on a ' + BOARD + 'x' + BOARD + ' board');
	console.log('  culling off  entries ' + String(offEntries).padStart(8) + '  bytes ' + String(offBytes).padStart(9) + '  (one ' + off.entries + '-entry frame x ' + SUBSCRIBERS + ')');
	console.log('  culling on   entries ' + String(on.entries).padStart(8) + '  bytes ' + String(on.bytes).padStart(9) + '  (' + on.frames + ' per-subscriber frames)');
	console.log('  reduction    entries ' + (offEntries / Math.max(1, on.entries)).toFixed(1) + 'x  bytes ' + (offBytes / Math.max(1, on.bytes)).toFixed(1) + 'x');
	console.log('  mean entries/subscriber-frame ' + (on.entries / Math.max(1, on.frames)).toFixed(1) + '  culledEntriesDropped ' + on.stats.culledEntriesDropped);
}

// ----------------------------------------------------------------------
// Scenario 2: INDEX_CROSSOVER sweep (direct vs indexed)
// ----------------------------------------------------------------------

const CELL = 256;
const PAD = 256;
const packCell = (cx, cy) => ((cx & 0xffff) << 16) | (cy & 0xffff);

function cullDirect(items, b) {
	const out = [];
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it.x >= b.minX && it.x <= b.maxX && it.y >= b.minY && it.y <= b.maxY) out.push(it);
	}
	return out;
}

function buildIndex(items) {
	const cells = new Map();
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		const ck = packCell(Math.floor(it.x / CELL), Math.floor(it.y / CELL));
		let bucket = cells.get(ck);
		if (!bucket) { bucket = []; cells.set(ck, bucket); }
		bucket.push(it);
	}
	return cells;
}

function cullIndexedQuery(cells, M, b, out) {
	out.length = 0;
	const cx0 = Math.floor(b.minX / CELL), cy0 = Math.floor(b.minY / CELL);
	const cx1 = Math.floor(b.maxX / CELL), cy1 = Math.floor(b.maxY / CELL);
	if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > M) return out;
	for (let cy = cy0; cy <= cy1; cy++) {
		for (let cx = cx0; cx <= cx1; cx++) {
			const bucket = cells.get(packCell(cx, cy));
			if (!bucket) continue;
			for (const it of bucket) {
				if (it.x >= b.minX && it.x <= b.maxX && it.y >= b.minY && it.y <= b.maxY) out.push(it);
			}
		}
	}
	return out;
}

function runCrossoverSweep() {
	// The index is built ONCE per flush and queried by every reporting
	// subscriber, so the meaningful comparison is the whole-flush cost at a
	// realistic subscriber count: direct = N flat scans; indexed = one build
	// plus N cell-walk queries. Board scaled with mover count so a viewport
	// holds ~100 movers throughout, isolating the build-vs-scan trade-off.
	const VW = 1920, VH = 1080;
	const N = 100; // reporting subscribers per flush
	const BOARD = 8000; // fixed, so the viewport always fits and density grows with M
	const Ms = [16, 32, 48, 64, 96, 128, 192, 256, 512, 1000];
	const ROUNDS = 200;
	const out = [];

	console.log('\nScenario 2: per-flush cull cost at N=' + N + ' subscribers on an ' + BOARD + 'x' + BOARD + ' board, ns/flush (median of ' + ROUNDS + ')');
	console.log('  movers     direct   indexed   winner');
	let crossover = null;
	for (const M of Ms) {
		const rand = rng(7 + M);
		const items = [];
		const bounds = [];
		for (let i = 0; i < M; i++) items.push({ key: 'm' + i, data: 0, x: rand() * BOARD, y: rand() * BOARD });
		for (let s = 0; s < N; s++) {
			const x = rand() * (BOARD - VW), y = rand() * (BOARD - VH);
			bounds.push({ minX: x - PAD, minY: y - PAD, maxX: x + VW + PAD, maxY: y + VH + PAD });
		}

		const dT = [], iT = [];
		for (let r = 0; r < ROUNDS; r++) {
			let s = performance.now();
			for (let k = 0; k < N; k++) cullDirect(items, bounds[k]);
			dT.push(performance.now() - s);

			s = performance.now();
			const cells = buildIndex(items);
			for (let k = 0; k < N; k++) cullIndexedQuery(cells, M, bounds[k], out);
			iT.push(performance.now() - s);
		}
		const d = median(dT) * 1e6, i = median(iT) * 1e6;
		const winner = i < d ? 'indexed' : 'direct';
		// Only count the genuine cell-walk region (M past a viewport's cell span,
		// where the deliver-all clamp no longer short-circuits) as a crossover.
		if (crossover === null && i < d && M >= 96) crossover = M;
		console.log('  ' + String(M).padStart(5) + '   ' + d.toFixed(0).padStart(8) + '   ' + i.toFixed(0).padStart(7) + '   ' + winner);
	}
	// Note: the apparent "indexed wins" below ~70 movers is the deliver-all
	// clamp short-circuiting (the viewport spans more cells than there are
	// movers), not the cell walk. In the genuine walk region the direct scan
	// wins until the per-subscriber mover count is large, because a cell probe
	// is a Map lookup costing several inline bounds compares.
	console.log('  real crossover (cell-walk indexed beats direct) ~' + (crossover ?? '>1000') + ' movers -> INDEX_CROSSOVER (currently 512)');
}

// ----------------------------------------------------------------------
// Scenario 3: walk overhead for non-reporters
// ----------------------------------------------------------------------

async function runWalkOverheadScenario() {
	const MOVERS = 1000;
	console.log('\nScenario 3: lazy reporter gate, ' + MOVERS + ' movers, subscribers do NOT report a viewport');
	console.log('  subscribers   cull-off frames   cull-on frames   (gate keeps both at 1)');
	for (const S of [10, 100, 1000]) {
		async function run(cullOn) {
			const cursors = createCursor({ throttle: 0, topicThrottle: 16, viewport: cullOn ? { enabled: true } : undefined, select: (ud) => ({ id: ud.id }) });
			const p = walkPlatform();
			for (let i = 0; i < S; i++) p.addSubscriber(mockWs({ id: 's' + i }), CURSOR); // non-reporters
			for (let i = 0; i < MOVERS; i++) cursors.update(mockWs({ id: 'm' + i }), 'board', { x: i, y: i }, p);
			p.reset();
			await wait(40);
			cursors.clear();
			return { frames: p.frames, bytes: p.bytes };
		}
		const shared = await run(false);
		const gated = await run(true);
		console.log('  ' + String(S).padStart(11) + '   ' + String(shared.frames).padStart(15) + '   ' + String(gated.frames).padStart(14) + '   ' + (gated.frames === 1 ? 'gate held' : 'REGRESSED to ' + gated.frames));
	}
	console.log('  (a viewport-enabled topic with no reporters stays on the shared fan-out - no per-subscriber walk)');
}

await runReductionScenario();
runCrossoverSweep();
await runWalkOverheadScenario();
console.log();
