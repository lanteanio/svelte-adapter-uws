// A/B bench: per-topic throttle vs per-key throttle for multi-publisher
// streams (cursor moves, typing indicators, presence pings, etc).
//
// The current throttle plugin keeps a single shared `pending` slot per
// topic. When N publishers share one topic, fast publishers overwrite
// slow publishers' pending payloads during the cooldown window, so slow
// publishers' updates almost never reach subscribers.
//
// A per-key variant keys the (lastEmit, pending) state by an extracted
// key (e.g. userId), so each publisher gets its own cooldown bucket and
// fast publishers cannot starve slow ones.
//
// Workload: cursor-style mix.
//   100 users total: 10 fast (60 Hz) + 90 slow (5 Hz)
//   Throttle interval: 33 ms (≈ 30 Hz cap per bucket)
//   Sim duration: 5000 ms
//
// Measures per-user delivery rate (delivered / generated) under each
// strategy and reports fast vs slow buckets separately. The fairness
// claim is: per-topic starves slow users; per-key does not.
//
// Pure JS simulation (no uWS, no real WS) — this is an algorithmic
// fairness property, not a network property. Deterministic, repeatable,
// runs in < 50 ms.

const FAST_USERS = 10;
const SLOW_USERS = 90;
const FAST_HZ = 60;
const SLOW_HZ = 5;
const DURATION_MS = 5000;
const INTERVAL_MS = 33;

function buildEvents() {
	const events = [];
	for (let u = 0; u < FAST_USERS + SLOW_USERS; u++) {
		const hz = u < FAST_USERS ? FAST_HZ : SLOW_HZ;
		const step = 1000 / hz;
		const userId = 'u' + u;
		for (let t = 0; t < DURATION_MS; t += step) {
			events.push({ t, userId });
		}
	}
	events.sort((a, b) => a.t - b.t);
	return events;
}

// Leading-edge + trailing-edge throttle, matching plugins/throttle/server.js.
// state has shape: { timer: number | null, pending: userId | null }
// `timer` holds the absolute sim time the trailing-edge tick should fire.
function runThrottle(events, getBucketKey) {
	const buckets = new Map(); // bucketKey -> state
	const delivered = new Map(); // userId -> count
	const generated = new Map(); // userId -> count

	const deliver = (userId) => {
		delivered.set(userId, (delivered.get(userId) ?? 0) + 1);
	};

	// Drain trailing-edge ticks for every bucket up to time `t`.
	const drainTicks = (t) => {
		for (const [k, st] of buckets) {
			while (st.timer !== null && st.timer <= t) {
				if (st.pending !== null) {
					deliver(st.pending);
					st.pending = null;
					st.timer = st.timer + INTERVAL_MS;
				} else {
					st.timer = null;
					buckets.delete(k);
					break;
				}
			}
		}
	};

	for (const ev of events) {
		generated.set(ev.userId, (generated.get(ev.userId) ?? 0) + 1);
		drainTicks(ev.t);

		const k = getBucketKey(ev.userId);
		let st = buckets.get(k);
		if (!st) {
			st = { timer: null, pending: null };
			buckets.set(k, st);
		}
		if (st.timer === null) {
			deliver(ev.userId);
			st.timer = ev.t + INTERVAL_MS;
		} else {
			st.pending = ev.userId; // overwrite any prior pending in this bucket
		}
	}

	// Final drain at end of sim window.
	drainTicks(DURATION_MS);

	return { delivered, generated };
}

function summarize(label, { delivered, generated }) {
	let totalGen = 0, totalDel = 0;
	let fastGen = 0, fastDel = 0;
	let slowGen = 0, slowDel = 0;
	for (const [u, gen] of generated) {
		const del = delivered.get(u) ?? 0;
		totalGen += gen; totalDel += del;
		const isFast = Number(u.slice(1)) < FAST_USERS;
		if (isFast) { fastGen += gen; fastDel += del; }
		else { slowGen += gen; slowDel += del; }
	}
	const pct = (n, d) => d === 0 ? '  -- ' : (n / d * 100).toFixed(1).padStart(5) + '%';
	console.log('  ' + label.padEnd(28) +
		' total ' + String(totalDel).padStart(5) + '/' + String(totalGen).padEnd(5) + ' ' + pct(totalDel, totalGen) +
		'   fast ' + String(fastDel).padStart(4) + '/' + String(fastGen).padEnd(4) + ' ' + pct(fastDel, fastGen) +
		'   slow ' + String(slowDel).padStart(4) + '/' + String(slowGen).padEnd(4) + ' ' + pct(slowDel, slowGen));
}

console.log('Setup: ' + FAST_USERS + ' fast (' + FAST_HZ + ' Hz) + ' + SLOW_USERS + ' slow (' + SLOW_HZ + ' Hz) over ' + DURATION_MS + ' ms');
console.log('Throttle interval: ' + INTERVAL_MS + ' ms');
console.log();

const events = buildEvents();

console.log('Per-topic throttle (current shape — single shared bucket):');
summarize('per-topic', runThrottle(events, () => 'shared'));

console.log();
console.log('Per-key throttle (proposed — bucket keyed by userId):');
summarize('per-key', runThrottle(events, (userId) => userId));

console.log();
console.log('Fairness check: slow-user delivery % under per-key should be near 100;');
console.log('under per-topic it collapses because fast users overwrite the shared pending slot.');
