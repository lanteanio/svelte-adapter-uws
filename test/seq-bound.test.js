import { describe, it, expect, afterEach } from 'vitest';
import { createSeqBound, fnv32 } from '../src/runtime/utils/seq-bound.js';
import { stampSeqValue } from '../src/runtime/utils/epoch.js';
import { recordSeen, recordStampedSeen } from '../src/runtime/handler/state.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

function makeBound(overrides = {}) {
	const seqMap = overrides.seqMap ?? new Map();
	const seenMap = overrides.seenMap ?? new Map();
	const protectedTopics = overrides.protectedTopics ?? new Set();
	const overCaps = [];
	const bound = createSeqBound({
		seqMap,
		seenMap,
		capacity: 4,
		floorCap: 8,
		isProtected: (topic) => protectedTopics.has(topic),
		onOverCap: (size) => { overCaps.push(size); },
		...overrides.config
	});
	return { bound, seqMap, seenMap, protectedTopics, overCaps };
}

// The production shape: a counter topic is stamped AND recorded as observed,
// so the seen map is the wider of the two registries. Both writes report to
// the bound, exactly as the publish lanes do - a model that set the seen map
// directly would be testing a runtime that no longer exists.
function publish(bound, seqMap, seenMap, topic) {
	const seq = stampSeqValue(undefined, seqMap, topic, bound);
	recordStampedSeen(seenMap, topic, seq, bound);
	return seq;
}

describe('bounded seq registries (unit)', () => {
	it('keeps the bare-map stamp byte-identical: first call is 1, then previous plus one', () => {
		const map = new Map();
		expect(stampSeqValue(undefined, map, 't')).toBe(1);
		expect(stampSeqValue(undefined, map, 't')).toBe(2);
		expect(stampSeqValue(true, map, 't')).toBe(3);
		expect(stampSeqValue(false, map, 't')).toBe(null);
		expect(stampSeqValue(9, map, 't')).toBe(9);
		// The numeric authority never advanced the counter.
		expect(map.get('t')).toBe(3);
	});

	it('evicts the oldest unprotected topic at the cap, from both registries, carrying its floor', () => {
		const { bound, seqMap, seenMap } = makeBound();
		for (const t of ['a', 'b', 'c', 'd']) publish(bound, seqMap, seenMap, t);
		publish(bound, seqMap, seenMap, 'a'); // a -> 2, still oldest-inserted
		expect(seqMap.get('a')).toBe(2);

		stampSeqValue(undefined, seqMap, 'e', bound); // insert at cap: evicts a
		expect(seqMap.has('a')).toBe(false);
		// Both registries forget it together, or their memberships drift.
		expect(seenMap.has('a')).toBe(false);
		expect(seqMap.size).toBe(4);

		// The re-inserted topic resumes ABOVE its evicted watermark, so a
		// client's dedup floor of 2 never sees a duplicate seq.
		expect(stampSeqValue(undefined, seqMap, 'a', bound)).toBe(3);
	});

	it('never evicts the entry just admitted, a protected topic, or beyond the scan limit', () => {
		const { bound, seqMap, protectedTopics, overCaps } = makeBound();
		for (const t of ['a', 'b', 'c', 'd']) stampSeqValue(undefined, seqMap, t, bound);
		protectedTopics.add('a').add('b').add('c').add('d');

		stampSeqValue(undefined, seqMap, 'e', bound);
		// Every candidate protected: admitted over the cap, warned with the
		// size that tripped it, evicted nothing.
		expect(seqMap.size).toBe(5);
		expect(overCaps).toEqual([5]);
		expect([...seqMap.keys()]).toContain('e');

		// The sweep is bounded at two passes of scanLimit each rather than
		// walking a huge map: five protected topics against a scanLimit of 2
		// exhaust both passes (the first rotates two, the second another
		// two), so the insert is admitted over the cap rather than sweeping
		// the whole registry looking for a victim.
		const tight = makeBound({ config: { capacity: 5, scanLimit: 2 } });
		for (const t of ['p1', 'p2', 'p3', 'p4', 'p5']) tight.protectedTopics.add(t);
		for (const t of ['p1', 'p2', 'p3', 'p4', 'p5']) stampSeqValue(undefined, tight.seqMap, t, tight.bound);
		stampSeqValue(undefined, tight.seqMap, 'u1', tight.bound);
		expect(tight.seqMap.size).toBe(6);
		expect(tight.overCaps).toEqual([6]);
	});

	it('merges a floor hash collision to the maximum, which can only inflate', () => {
		// A genuine fnv32 collision pair, found by exhaustive search once and
		// pinned. The assertion below re-verifies it against the REAL hash, so
		// a changed hash function fails loudly here instead of silently
		// testing nothing.
		const first = 'topic-5pwu';
		const second = 'topic-g5fa';
		expect(fnv32(first)).toBe(fnv32(second));
		expect(first).not.toBe(second);

		const { bound, seqMap } = makeBound({ config: { capacity: 1, scanLimit: 4 } });
		// Drive the FIRST colliding topic to seq 5, then evict it.
		for (let i = 0; i < 5; i++) stampSeqValue(undefined, seqMap, first, bound);
		stampSeqValue(undefined, seqMap, 'filler', bound); // evicts first (floor 5)
		expect(seqMap.has(first)).toBe(false);

		// The SECOND topic shares the floor slot: its first stamp starts at 6.
		// Inflated, never regressed - a counter may skip numbers, never repeat.
		expect(stampSeqValue(undefined, seqMap, second, bound)).toBe(6);
	});

	it('collapses the floor map into a high-water mark that still forbids reuse', () => {
		const { bound, seqMap } = makeBound({ config: { capacity: 1, floorCap: 2, scanLimit: 4 } });
		expect(bound.highWaterMark()).toBe(0);

		// Drive one topic high, then let each new topic evict the previous.
		for (let i = 0; i < 9; i++) stampSeqValue(undefined, seqMap, 'tall', bound);
		stampSeqValue(undefined, seqMap, 't2', bound); // evict tall, floors=1
		stampSeqValue(undefined, seqMap, 't3', bound); // evict t2,   floors=2
		expect(bound.highWaterMark()).toBe(0);
		expect(bound.floorSize()).toBe(2);

		stampSeqValue(undefined, seqMap, 't4', bound); // evict t3 -> floors would be 3: collapse
		expect(bound.floorSize()).toBe(0);
		// The collapse keeps the HIGHEST forgotten counter, not the latest.
		expect(bound.highWaterMark()).toBe(9);

		// Every topic re-entering after a collapse - including the tall one
		// whose exact floor is gone, and one never seen before - resumes above
		// the high-water mark, so no client watermark can be met twice. This
		// is the property the epoch machinery would otherwise have to signal.
		expect(stampSeqValue(undefined, seqMap, 'tall', bound)).toBe(10);
		expect(stampSeqValue(undefined, seqMap, 'brand-new', bound)).toBe(10);
	});

	it('never regresses the counter across repeated collapse cycles', () => {
		const { bound, seqMap } = makeBound({ config: { capacity: 1, floorCap: 2, scanLimit: 4 } });
		const handed = [];
		for (let round = 0; round < 40; round++) {
			const topic = 'r' + (round % 3);
			handed.push(stampSeqValue(undefined, seqMap, topic, bound));
			handed.push(stampSeqValue(undefined, seqMap, topic, bound));
		}
		// A client on any of these three topics only ever needs one guarantee:
		// a number it has seen is never handed out again for that topic.
		const perTopic = new Map();
		for (let i = 0; i < handed.length; i += 2) {
			const topic = 'r' + ((i / 2) % 3);
			const prev = perTopic.get(topic) ?? 0;
			expect(handed[i], topic).toBeGreaterThan(prev);
			expect(handed[i + 1]).toBeGreaterThan(handed[i]);
			perTopic.set(topic, handed[i + 1]);
		}
	});

	it('bounds the seen registry even when counter topics fill the scan window', () => {
		// The shape that defeats a scan which can only SKIP counter topics:
		// every candidate at the head of insertion order is a counter topic,
		// so the observed-only inserts behind them could never evict anything.
		const { bound, seqMap, seenMap } = makeBound({ config: { capacity: 4, scanLimit: 2 } });
		for (const t of ['c1', 'c2', 'c3', 'c4']) publish(bound, seqMap, seenMap, t);
		expect(seenMap.size).toBe(4);

		// Relay-observed topics arrive; each insert is over the cap.
		for (let i = 0; i < 24; i++) recordSeen(seenMap, 'o' + i, 10, bound);

		// Both registries stay at the ceiling instead of growing forever.
		expect(seenMap.size).toBeLessThanOrEqual(5);
		expect(seqMap.size).toBeLessThanOrEqual(4);
		// The counter topics that were evicted to make room carried their
		// floors, so re-publishing one does not repeat a delivered seq.
		expect(stampSeqValue(undefined, seqMap, 'c1', bound)).toBeGreaterThan(1);
	});

	// The order that defeats a bound the counter lane never reports to: the
	// observed registry is filled FIRST by an external seq authority, so it is
	// already at the ceiling by the time ordinary counter publishing starts,
	// and every counter topic then adds an entry the bound never hears about.
	// The counter registry stays honest the whole time, which is what makes
	// this invisible from the seq side - the operator sizes for one ceiling
	// and pays for two.
	it('bounds the seen registry when an external authority fills it before the counters arrive', () => {
		const { bound, seqMap, seenMap } = makeBound({ config: { capacity: 4 } });
		for (let i = 0; i < 4; i++) recordSeen(seenMap, 'external:' + i, 10_000 + i, bound);
		expect(seenMap.size).toBe(4);

		for (let i = 0; i < 4; i++) publish(bound, seqMap, seenMap, 'counter:' + i);

		expect(seqMap.size).toBeLessThanOrEqual(4);
		expect(seenMap.size).toBeLessThanOrEqual(4);
	});

	// The same bypass sustained: alternating authorities over many topics must
	// hold ONE ceiling between them, not one each.
	it('holds a single ceiling across sustained mixed-authority arrival', () => {
		const { bound, seqMap, seenMap } = makeBound({ config: { capacity: 8, scanLimit: 16 } });
		for (let i = 0; i < 200; i++) {
			if (i % 2 === 0) recordSeen(seenMap, 'ext:' + i, 5_000_000 + i, bound);
			else publish(bound, seqMap, seenMap, 'ctr:' + i);
		}
		// No quiet probe and nothing protected, so the sweep always finds a
		// victim and neither registry has an overshoot allowance to spend.
		expect(seenMap.size).toBeLessThanOrEqual(8);
		expect(seqMap.size).toBeLessThanOrEqual(8);
	});

	it('keeps the monotone-max guard for a known topic and bounds only new ones', () => {
		const { bound, seenMap } = makeBound();
		recordSeen(seenMap, 'o1', 10, bound);
		recordSeen(seenMap, 'o1', 5, bound);
		expect(seenMap.get('o1')).toBe(10);
		recordSeen(seenMap, 'o1', 11, bound);
		expect(seenMap.get('o1')).toBe(11);
		// A non-number seq is ignored exactly as before.
		recordSeen(seenMap, 'o2', undefined, bound);
		expect(seenMap.has('o2')).toBe(false);
	});

	it('evicts only what the quiet probe positively judges quiet', () => {
		const judged = new Map();
		const { bound, seqMap } = makeBound({ config: { capacity: 2, scanLimit: 8 } });
		bound.useQuietProbe((topic) => judged.get(topic) === 'quiet');

		for (const t of ['a', 'b'] ) stampSeqValue(undefined, seqMap, t, bound);
		// Nothing judged yet: an unjudged topic is NOT evictable, because a
		// sibling worker could still be comparing it on the active lane. The
		// insert is admitted over the cap instead - deliberately.
		stampSeqValue(undefined, seqMap, 'c', bound);
		expect(seqMap.size).toBe(3);
		// Judged, but ACTIVE: still not evictable.
		judged.set('a', 'active');
		judged.set('b', 'active');
		stampSeqValue(undefined, seqMap, 'd', bound);
		expect(seqMap.has('a')).toBe(true);
		expect(seqMap.has('b')).toBe(true);

		// Positively quiet: eviction resumes and the registry comes back
		// down. Driving several inserts here rather than one, because a
		// blocked sweep waves the next few through before trying again.
		judged.set('a', 'quiet');
		judged.set('b', 'quiet');
		const sizeBefore = seqMap.size;
		for (let i = 0; i < 40; i++) stampSeqValue(undefined, seqMap, 'churn:' + i, bound);
		expect(seqMap.has('a')).toBe(false);
		expect(seqMap.has('b')).toBe(false);
		expect(seqMap.size).toBeLessThan(sizeBefore + 40);
	});

	// A wedged registry must not re-pay the full two-pass sweep on every
	// insert: the sweep that finds nothing is the expensive one, and its
	// answer does not change until something becomes evictable.
	it('backs off after a sweep finds nothing, and resumes when one does', () => {
		let sweepJudgments = 0;
		const seqMap = new Map();
		let everythingProtected = true;
		const bound = createSeqBound({
			seqMap,
			seenMap: new Map(),
			capacity: 4,
			floorCap: 64,
			scanLimit: 4,
			isProtected: () => { sweepJudgments++; return everythingProtected; },
			onOverCap: () => {}
		});
		for (let i = 0; i < 4; i++) stampSeqValue(undefined, seqMap, 'p:' + i, bound);

		stampSeqValue(undefined, seqMap, 'first', bound);
		const afterFirstSweep = sweepJudgments;
		expect(afterFirstSweep).toBeGreaterThan(0);
		// The next several over-cap inserts cost no judgments at all.
		for (let i = 0; i < 8; i++) stampSeqValue(undefined, seqMap, 'skipped:' + i, bound);
		expect(sweepJudgments).toBe(afterFirstSweep);

		// Once the backoff lapses the sweep runs again - and when the block
		// clears, eviction resumes rather than staying backed off.
		everythingProtected = false;
		for (let i = 0; i < 40; i++) stampSeqValue(undefined, seqMap, 'later:' + i, bound);
		expect(sweepJudgments).toBeGreaterThan(afterFirstSweep);
		expect(seqMap.size).toBeLessThanOrEqual(5 + 16);
	});

	// The floor protects the numbering THIS worker issues. An
	// externally-authored seq recorded for the same topic belongs to an
	// authority that keeps issuing its own numbers, and carrying it would
	// leak that seq space into the worker-wide mark - starting every future
	// topic near a billion, which costs five varint bytes per binary frame
	// instead of one, on every topic.
	it('keeps a foreign seq space out of the worker-wide mark', () => {
		const { bound, seqMap, seenMap } = makeBound({ config: { capacity: 1, floorCap: 2, scanLimit: 4 } });
		stampSeqValue(undefined, seqMap, 'mixed', bound);
		seenMap.set('mixed', 1_000_000_000);

		stampSeqValue(undefined, seqMap, 'other', bound); // evicts 'mixed'
		expect(seqMap.has('mixed')).toBe(false);
		// The floor carries the counter, not the foreign number...
		expect(stampSeqValue(undefined, seqMap, 'mixed', bound)).toBe(2);
		// ...so no later topic inherits a billion-wide varint.
		for (const t of ['fresh-a', 'fresh-b', 'fresh-c', 'fresh-d']) {
			expect(stampSeqValue(undefined, seqMap, t, bound), t).toBeLessThan(1000);
		}
		expect(bound.highWaterMark()).toBeLessThan(1000);
	});

	it('records no floor for a topic only the observed registry held', () => {
		const { bound, seqMap, seenMap } = makeBound({ config: { capacity: 1, floorCap: 2, scanLimit: 4 } });
		recordSeen(seenMap, 'external', 5_000_000, bound);
		recordSeen(seenMap, 'external-2', 6_000_000, bound);
		expect(seenMap.has('external')).toBe(false);
		// Every number that topic carried came from an authority that still
		// owns it; this worker's counters are not raised on its account.
		expect(bound.highWaterMark()).toBe(0);
		expect(stampSeqValue(undefined, seqMap, 'external', bound)).toBe(1);
	});

	// The failure mode a fixed scan window has and a sweep does not: enough
	// permanently-unevictable topics at the head to fill the window. A scan
	// that restarts at the head re-judges that same prefix forever and the
	// registry grows without limit - which is the very thing this bound
	// exists to prevent, reintroduced by its own guard.
	it('keeps sweeping past a full window of unevictable topics instead of jamming', () => {
		for (const blocker of ['quiet-probe', 'subscriber']) {
			const busy = new Set(Array.from({ length: 16 }, (_, i) => 'busy:' + i));
			const seqMap = new Map();
			const bound = createSeqBound({
				seqMap,
				seenMap: new Map(),
				capacity: 20,
				floorCap: 64,
				scanLimit: 16,
				// Either judgment must be non-jamming, so run the same shape
				// through both of them.
				isProtected: (topic) => blocker === 'subscriber' && busy.has(topic),
				onOverCap: () => {}
			});
			if (blocker === 'quiet-probe') bound.useQuietProbe((topic) => !busy.has(topic));

			// The unevictable topics are inserted FIRST, so they occupy the
			// whole window in insertion order.
			for (const topic of busy) stampSeqValue(undefined, seqMap, topic, bound);
			for (let i = 0; i < 500; i++) stampSeqValue(undefined, seqMap, 'churn:' + i, bound);

			// The registry stays near its ceiling instead of growing to 516...
			expect(seqMap.size, blocker).toBeLessThanOrEqual(21);
			// ...and every unevictable topic is still there, untouched.
			for (const topic of busy) expect(seqMap.has(topic), blocker + ' ' + topic).toBe(true);
		}
	});

	// The bypass above was not a missing case in the bound; it was a publish
	// lane writing the registry behind the bound's back, and five lanes shared
	// that shape. A unit test over the bound's own surface cannot see a caller
	// that never calls it, so this walks the runtime sources instead.
	//
	// Two forms reproduce the defect and both are refused here: writing the
	// observed registry directly, and calling a recorder WITHOUT the bound -
	// `bound` is an optional parameter, so `recordStampedSeen(maxSeenSeq,
	// topic, seq)` compiles, records the topic, and reports nothing. The
	// second form is why this reads the syntax tree rather than the text: an
	// argument count is not something a line regex can count.
	//
	// Aliasing the map defeats the first check, so every way of binding it to
	// another name is refused too - a declaration, an assignment, and an
	// object property, which is the spelling the runtime itself uses when it
	// hands the map to the bound's factory. That one construction site is the
	// single exemption, and naming it here is what keeps the rule absolute
	// everywhere else.
	it('leaves every runtime write to the observed registry with the recorders, bound included', () => {
		const runtimeDir = fileURLToPath(new URL('../src/runtime/', import.meta.url));
		// The recorders bound the observed registry; stampSeq/stampSeqValue bound
		// the counter one. Both take the bound as a trailing argument, and
		// omitting it reintroduces the same defect on whichever map it owns.
		const recorders = new Set(['recordSeen', 'recordStampedSeen', 'stampSeq', 'stampSeqValue']);
		// Where the map is legitimately handed to the bound that owns it.
		const factoryWiring = 'handler/seq-bound.js';
		/** @type {string[]} */
		const offenders = [];
		let scanned = 0;

		/** @param {any} node @param {(n: any) => void} visit */
		function walkAst(node, visit) {
			if (!node || typeof node !== 'object') return;
			visit(node);
			for (const value of Object.values(node)) {
				if (Array.isArray(value)) for (const child of value) walkAst(child, visit);
				else if (value && typeof value === 'object' && typeof value.type === 'string') walkAst(value, visit);
			}
		}

		/** The name a member expression reads, computed or not. */
		const memberName = (node) => node.computed
			? (node.property?.type === 'Literal' ? node.property.value : null)
			: node.property?.name;

		/** The node handler, factored out so a synthetic source can run it too. */
		const visitor = (rel, found) => (node) => {
				const at = () => rel + ':' + node.loc.start.line;
				// `maxSeenSeq.set(...)`, and the same write reached through a
				// namespace import - `state.maxSeenSeq.set(...)` - which is the
				// shipped defect with a different callee node.
				const writesSeenMap = node.type === 'MemberExpression' && memberName(node) === 'set' &&
					(node.object?.name === 'maxSeenSeq' ||
						(node.object?.type === 'MemberExpression' && memberName(node.object) === 'maxSeenSeq'));
				if (writesSeenMap) {
					found.push(at() + ': writes maxSeenSeq directly instead of through a recorder');
				}
				const aliases = node.type === 'VariableDeclarator' ? node.init
					: node.type === 'AssignmentExpression' ? node.right
						: node.type === 'Property' ? node.value
							: null;
				if (aliases?.type === 'Identifier' && aliases.name === 'maxSeenSeq' && rel !== factoryWiring) {
					found.push(at() + ': binds maxSeenSeq to another name, which puts its writes out of reach of this check');
				}
				// A recorder reached through a namespace import is the same
				// call with a different callee node, so both spellings are
				// held to the argument count.
				const callee = node.type === 'CallExpression'
					? (node.callee?.type === 'Identifier' ? node.callee.name
						: node.callee?.type === 'MemberExpression' ? memberName(node.callee) : null)
					: null;
				if (callee !== null && recorders.has(callee)) {
					// A COUNT is not enough: `recordStampedSeen(map, topic, seq, undefined)`
					// has four arguments and reports nothing.
					const bound = node.arguments[3];
					const named = bound?.type === 'Identifier' && bound.name !== 'undefined';
					if (!named) {
						found.push(at() + ': ' + callee + ' is called with ' +
							(node.arguments.length < 4 ? 'no bound argument' : 'a bound that is not a named binding') +
							', so the registry bound never hears about the topic it admits');
					}
				}
		};

		/** Count the modules the walk should reach, so the floor is derived. */
		function countJsFiles(dir) {
			return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => total +
				(entry.isDirectory() ? countJsFiles(join(dir, entry.name)) : entry.name.endsWith('.js') ? 1 : 0), 0);
		}

		/** Run the same visitor over a synthetic module. */
		function offendersIn(source, rel = 'probe.js') {
			const found = [];
			const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
			walkAst(ast, visitor(rel, found));
			return found;
		}

		/** @param {string} dir */
		function walk(dir) {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!entry.name.endsWith('.js')) continue;
				// state.js is where the two recorders live, and the writes
				// inside them are the ones every lane is routed through.
				if (full.endsWith(join('handler', 'state.js'))) continue;
				scanned++;
				const rel = relative(runtimeDir, full).split(String.fromCharCode(92)).join('/');
				const ast = parse(readFileSync(full, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
				walkAst(ast, visitor(rel, offenders));
			}
		}
		walk(runtimeDir);
		// A tree that stopped being walked would report no offenders, so the
		// walk's reach is asserted against the tree's own size rather than a
		// pinned number that an ordinary refactor would break.
		const runtimeModules = countJsFiles(runtimeDir);
		expect(scanned).toBe(runtimeModules - 1); // every module but state.js
		expect(offenders).toEqual([]);

		// POSITIVE CONTROL. `offenders` staying empty proves nothing unless the
		// visitor can still produce one: a broken walk and a clean tree look
		// identical from here. Each refused form is fed through the same
		// visitor and must be caught.
		const mutants = {
			'direct write': 'maxSeenSeq.set(topic, seq);',
			'computed write': "maxSeenSeq['set'](topic, seq);",
			'namespace write': 'state.maxSeenSeq.set(topic, seq);',
			'declaration alias': 'const m = maxSeenSeq; m.set(topic, seq);',
			'assignment alias': 'let m; m = maxSeenSeq; m.set(topic, seq);',
			'property alias': 'const cfg = { seen: maxSeenSeq };',
			'missing bound': 'recordStampedSeen(maxSeenSeq, topic, seq);',
			'undefined bound': 'recordStampedSeen(maxSeenSeq, topic, seq, undefined);',
			'namespace recorder': 'state.recordStampedSeen(maxSeenSeq, topic, seq);',
			'unbounded stamp': 'stampSeqValue(undefined, topicSeqs, topic);'
		};
		for (const [name, source] of Object.entries(mutants)) {
			expect(offendersIn(source), name).not.toEqual([]);
		}
	});

	it('disables entirely at capacity 0', () => {
		const { bound, seqMap, seenMap, overCaps } = makeBound({ config: { capacity: 0, floorCap: 0 } });
		for (let i = 0; i < 32; i++) {
			stampSeqValue(undefined, seqMap, 't' + i, bound);
			recordSeen(seenMap, 's' + i, 1, bound);
		}
		expect(seqMap.size).toBe(32);
		expect(seenMap.size).toBe(32);
		expect(overCaps).toEqual([]);
	});

	it('protects rather than authorizes when the subscriber probe throws', () => {
		const seqMap = new Map();
		const overCaps = [];
		const bound = createSeqBound({
			seqMap,
			seenMap: new Map(),
			capacity: 2,
			floorCap: 8,
			isProtected: () => { throw new Error('probe unavailable'); },
			onOverCap: (size) => { overCaps.push(size); }
		});
		// A throwing probe must not take a topic a client may be holding: the
		// wired bound catches inside isProtected, and a probe that escapes
		// entirely must not silently evict either.
		expect(() => {
			for (const t of ['a', 'b', 'c']) stampSeqValue(undefined, seqMap, t, bound);
		}).toThrow('probe unavailable');
		expect(seqMap.has('a')).toBe(true);
		expect(seqMap.has('b')).toBe(true);
	});
});

describeUWS('bounded seq registries (real server)', () => {
	let server;
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	async function connectClient(url) {
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		return ws;
	}

	function collect(ws) {
		const frames = [];
		const waiters = [];
		ws.on('message', (data) => {
			const frame = JSON.parse(data.toString());
			frames.push(frame);
			for (const w of [...waiters]) {
				if (w.match(frame)) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(frame);
				}
			}
		});
		return {
			frames,
			next(match, ms = 4000) {
				const found = frames.find(match);
				if (found) return Promise.resolve(found);
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('frame timeout')), ms);
					waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
				});
			}
		};
	}

	it('a client dedup floor survives evict-and-reinsert: the delivered seq resumes above the old watermark', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ maxTopicSeqEntries: 4 });

		// Build the watermark, then leave the topic unsubscribed and evictable.
		server.platform.publish('t-a', 'tick', { n: 1 });
		server.platform.publish('t-a', 'tick', { n: 2 });
		// Four fresh topics; the last insert is at the cap and evicts t-a.
		for (const t of ['t-b', 't-c', 't-d', 't-e']) server.platform.publish(t, 'tick', {});

		const ws = server.track(await connectClient(server.wsUrl));
		const inbox = collect(ws);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 't-a', ref: 1 }));
		await inbox.next((f) => f.type === 'subscribed' && f.topic === 't-a');

		server.platform.publish('t-a', 'tick', { n: 3 });
		const frame = await inbox.next((f) => f.topic === 't-a' && f.event === 'tick');
		// A client that saw seq 2 before the eviction must never be handed 1
		// again; the floor carry resumes the counter above the old watermark.
		expect(frame.seq).toBe(3);
	});

	it('passes over a live subscriber: the subscribed topic keeps its counter through cap pressure', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ maxTopicSeqEntries: 4 });

		const ws = server.track(await connectClient(server.wsUrl));
		const inbox = collect(ws);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'held', ref: 1 }));
		await inbox.next((f) => f.type === 'subscribed' && f.topic === 'held');

		server.platform.publish('held', 'tick', { n: 1 });
		await inbox.next((f) => f.topic === 'held' && f.seq === 1);

		// Cap pressure from five other topics: 'held' is oldest but protected,
		// so the scan passes over it and evicts an unprotected sibling.
		for (const t of ['x1', 'x2', 'x3', 'x4', 'x5']) server.platform.publish(t, 'tick', {});

		server.platform.publish('held', 'tick', { n: 2 });
		const frame = await inbox.next((f) => f.topic === 'held' && f.event === 'tick' && f.seq !== 1);
		expect(frame.seq).toBe(2);
	});

	it('holds the epoch steady through eviction, so a subscribed client is never asked to rehydrate', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ maxTopicSeqEntries: 4 });

		const ws = server.track(await connectClient(server.wsUrl));
		const inbox = collect(ws);
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'epoch-probe', ref: 1 }));
		const before = await inbox.next((f) => f.type === 'subscribed' && f.topic === 'epoch-probe');
		expect(typeof before.epoch).toBe('number');

		// Far more evictions than the floor map can name, so the high-water
		// collapse fires many times over.
		for (let i = 0; i < 3000; i++) server.platform.publish('one-shot-' + i, 'tick', {});

		const ws2 = server.track(await connectClient(server.wsUrl));
		const inbox2 = collect(ws2);
		ws2.send(JSON.stringify({ type: 'subscribe', topic: 'epoch-probe-2', ref: 1 }));
		const after = await inbox2.next((f) => f.type === 'subscribed' && f.topic === 'epoch-probe-2');
		// The whole point of carrying floors instead of resetting the space:
		// the epoch does not move, so no client - including one subscribed
		// server-side that never receives an ack - is silently invalidated.
		expect(after.epoch).toBe(before.epoch);
	}, 30000);
});
