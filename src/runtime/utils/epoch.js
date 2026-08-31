import { now, randomU32, randomUuid } from '../runtime.js';

/**
 * Per-process generation for the in-memory per-topic seq space.
 *
 * Latched once, on first read, and constant for the life of the worker. It
 * changes only across a process restart - which is exactly when the in-memory
 * seq counters (the map a publisher mutates via `nextTopicSeq`) reset to 1. A
 * reconnecting client presents the generation it last saw; a server that
 * presents a different one is serving a freshly reset seq space, and the
 * client must re-read from scratch instead of trusting its old offsets.
 *
 * A single worker shares this one value across every topic. A backend whose
 * seq authority can reset per topic independently (a separate store) overrides
 * the carried value per topic without changing the wire shape.
 *
 * An OPAQUE token, not a timestamp. It is a random 32-bit integer from the
 * seam's RNG, and the ONLY comparison the wire cares about is equality across
 * a reconnect: any two consecutive boots differ (a 2^-32 collision with the
 * immediately-previous value is the sole failure mode, and it degrades to one
 * missed reset, not corruption). A wall-clock epoch would have distinguished
 * restarts just as well, but it also handed every unauthenticated client the
 * process start time - uptime, deploy timing, and a correlation fingerprint
 * across sockets behind a load balancer - so the token carries no time. Never
 * persisted; a fresh process is a fresh seq space. Latching on first read
 * (rather than at module import) lets a controlled simulation that has seeded
 * the RNG latch a reproducible value after `resetProcessEpoch()`.
 *
 * @returns {number}
 */
let _processEpoch;
export function processEpoch() {
	if (_processEpoch === undefined) _processEpoch = randomU32();
	return _processEpoch;
}

/** Clear the latched generation so the next read re-latches. Simulation use only. */
export function resetProcessEpoch() { _processEpoch = undefined; }

/**
 * Per-topic epoch overrides, layered over the process generation.
 *
 * A topic's epoch normally IS the process generation: every in-memory seq
 * counter resets together, so one token describes them all. An override exists
 * for the case where ONE topic's history can no longer be served from a
 * client-held offset while the process lives on - a confirmed relay loss: the
 * frames are gone, delivered sequences have already stepped past them, and any
 * offset taken before the loss would gap-fill from beyond frames its holder
 * never received. Minting a new epoch for that topic makes every such offset
 * die at its next resume through the ordinary epoch-mismatch answer, for
 * opted-in and plain clients alike, using machinery every client already
 * implements. The mint is worker-local and needs to be nothing more: each
 * worker's generation is its own random latch, so the losing worker's answer
 * is the only one a pre-loss offset could still match, and the repudiation
 * lasts as long as the override below does.
 *
 * The map is bounded: relay losses are rare, but nothing should grow without a
 * ceiling. At the cap the oldest override is dropped - reads then fall back to
 * the process generation, which for a long-dead loss window is the honest
 * degradation (an offset old enough to outlive the cap has usually cycled
 * through a resume, and the cap is far above any plausible concurrent count).
 */
const TOPIC_EPOCH_OVERRIDE_MAX = 4096;
/** @type {Map<string, number>} */
const _topicEpochs = new Map();

/**
 * The epoch for one topic: its override when a loss minted one, else the
 * process generation. This is the single read authority - the per-connection
 * platform's `topicEpoch`, the subscribe ack, and every resume compare route
 * through it.
 * @param {string} topic
 * @returns {number}
 */
export function topicEpochValue(topic) {
	const override = _topicEpochs.get(topic);
	return override !== undefined ? override : processEpoch();
}

/**
 * Install a topic's minted epoch. Re-installing refreshes the entry's
 * recency, so the cap always evicts the longest-undisturbed override.
 * @param {string} topic
 * @param {number} epoch
 * @returns {void}
 */
export function overrideTopicEpoch(topic, epoch) {
	if (_topicEpochs.delete(topic) === false && _topicEpochs.size >= TOPIC_EPOCH_OVERRIDE_MAX) {
		const oldest = _topicEpochs.keys().next().value;
		if (oldest !== undefined) _topicEpochs.delete(oldest);
	}
	_topicEpochs.set(topic, epoch);
}

/** Clear every topic override. Simulation and harness use only. */
export function resetTopicEpochs() { _topicEpochs.clear(); }

/**
 * Mint and install a fresh generation for ONE topic, returning it. The same
 * mint the confirmed-relay-loss drain performs, exposed for the app-driven
 * case: the explicit seq lane is single-authority per topic, so an app that
 * CHANGES a topic's authority - moves it from the counter to an external
 * allocator, repoints it at a different partition, resets the store behind
 * it - must repudiate every offset clients recorded under the old one, and
 * nothing else does. The re-roll guard exists because a mint that equals the
 * value being replaced is a no-op for exactly the offsets the caller asked
 * to repudiate; the loss drain tolerates its 2^-32 as one missed heal, but a
 * deliberate bump has the current value in hand and can simply not collide.
 *
 * Worker-local like every override in the map above: app code runs on every
 * worker, each mints independently, and the epoch is equality-only, so
 * independent values repudiate old offsets on every worker identically.
 *
 * @param {string} topic
 * @returns {number} the installed epoch
 */
export function mintTopicEpoch(topic) {
	const current = topicEpochValue(topic);
	let minted = randomU32();
	while (minted === current) minted = randomU32();
	overrideTopicEpoch(topic, minted);
	return minted;
}

/**
 * Allocate the next monotonic sequence number for a topic, mutating
 * `seqMap` in place. The first call for a topic returns 1; subsequent
 * calls return the previous value plus one. Each topic has an
 * independent counter.
 *
 * Pure with respect to inputs other than the supplied map. Suitable
 * for unit tests that pass a fresh map per case.
 *
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @returns {number}
 */
export function nextTopicSeq(seqMap, topic) {
	const next = (seqMap.get(topic) ?? 0) + 1;
	seqMap.set(topic, next);
	return next;
}

/**
 * Refuse a seq the wire cannot carry. One throw site shared by `stampSeq`'s
 * numeric arm and the batch's per-entry pre-pass, so the two spellings of the
 * same contract cannot drift apart in message or in meaning. Cold path: it is
 * only ever reached to throw, so the call costs nothing on a valid publish.
 *
 * @param {unknown} value
 * @returns {never}
 * @throws {TypeError} always
 */
export function throwInvalidSeq(value) {
	throw new TypeError(
		`publish seq must be a positive integer number or bigint (an explicit authority's value), ` +
		`true (the in-memory counter), or false/null (no seq); received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`
	);
}

/**
 * Refuse a seq whose value the wire's double space cannot keep distinct. Its
 * own throw site, and its own message: the value IS a positive integer, so the
 * legal-forms message would send a caller looking for a spelling mistake that
 * is not there. What is wrong is the magnitude, and the fix is a different
 * authority, so the message says that.
 *
 * @param {number | bigint} value
 * @returns {never}
 * @throws {TypeError} always
 */
export function throwUncarryableSeq(value) {
	throw new TypeError(
		`seq ${typeof value === 'bigint' ? `${value}n` : value} exceeds the wire's safe-integer range ` +
		`(at most 9007199254740991): the seq space is IEEE-754 double, which stops having a neighbour at ` +
		`distance one above that, so ids a caller means to be different collapse onto a single value. ` +
		`Because watermarks advance on a strict greater-than, the second frame then fails to advance the ` +
		`client's watermark and resume dedup goes ambiguous with nothing on the wire to notice by. Keep ` +
		`the wide id in the event data and give seq an authority inside the range, or offset it by a ` +
		`per-topic base; do not truncate, which destroys the ordering seq exists for`
	);
}

/**
 * Validate an EXPLICIT seq value - the number and bigint spellings of one
 * authority - and project it into the wire's seq space.
 *
 * That space is IEEE-754 double, and the range it carries FAITHFULLY is the
 * safe-integer range: at most 2^53 - 1. Both spellings are held to it.
 *
 * Above that range a double no longer has a neighbour at distance one, so two
 * ids a caller means to be different land on one value. Every max-seen guard
 * and every client watermark advances on a strict greater-than, so the second
 * frame does not advance the watermark and resume dedup goes ambiguous -
 * silently, on exactly the snowflakes and large Kafka offsets a caller reaches
 * for bigint to carry. The refusal is loud instead.
 *
 * Exact representability is NOT the test, though it looks like the natural
 * one. It fails on both ends. The JSON envelope serializes through
 * `String(double)`, which emits the shortest round-tripping decimal rather
 * than the integer: 2^60 is an exact double and still reaches a subscriber as
 * 1152921504606847000, a number nobody issued. And in the band just above
 * 2^53, where the gap is two, an exactness test would take a caller's EVEN
 * offsets and refuse the ODD ones - a contract that fails on half a stream,
 * by parity, is worse than one that refuses the range outright.
 *
 * The two spellings therefore agree everywhere, including on refusal: this is
 * one rule about the value, not a property of how it was written. Carrying a
 * wider seq exactly is not available - the seq space is frozen with the
 * protocol revision - so a caller whose ids exceed the range keeps them in the
 * event data and gives `seq` an authority that fits.
 *
 * @param {number | bigint} value
 * @returns {number}
 */
export function explicitSeqValue(value) {
	if (typeof value === 'number') {
		if (Number.isSafeInteger(value) && value >= 1) return value;
		// An integer too large to be safe is a magnitude fault, not a spelling
		// one, and gets the message that says so.
		if (Number.isInteger(value) && value >= 1) throwUncarryableSeq(value);
	} else if (typeof value === 'bigint' && value >= 1n) {
		// The typeof is load-bearing, not decoration: `>= 1n` is a VALUE
		// comparison, and a relational compare of a string against a bigint
		// runs StringToBigInt - so a bare `value >= 1n` let `'7'` through this
		// arm and returned 7, quietly making the exported validator accept a
		// spelling every caller of it refuses.
		//
		// `Number.isSafeInteger` then answers exactness and range together: a
		// bigint at or above 2^53 cannot land on a safe integer, and one below
		// it converts exactly. No BigInt is allocated on the accepting path.
		const projected = Number(value);
		if (Number.isSafeInteger(projected)) return projected;
		throwUncarryableSeq(value);
	}
	throwInvalidSeq(value);
}

/**
 * Resolve one batch entry's `seq` into its override form, speaking the same
 * table as {@link stampSeqValue} so the entry spelling and the options
 * spelling cannot disagree. ONE resolver for every surface that carries the
 * batch contract - production, the createTestServer harness, and the Vite
 * dev plugin - because the pre-pass used to be hand-copied into each, and a
 * table change landing in one alone is exactly the mirror drift the parity
 * suite exists to catch.
 *
 * A refusal names the entry's POSITION. One bad value refuses the whole
 * batch, so without the index a caller handing over two hundred entries gets
 * one message and no way to tell which of them carried it; the array is the
 * caller's own, so the index is all they need to find it. Rethrown around the
 * shared validators rather than parameterised into them, so the entry lane and
 * the options lane keep one table and one wording - the position is a prefix,
 * not a second contract.
 *
 * Only a VALUE refusal is prefixed. The counter-draw refusal an entry can also
 * trigger (`seq: true` on a clustered runtime) is left alone deliberately: it
 * is a plain Error about the DEPLOYMENT, not this entry, and its remedy - the
 * options renouncing the counter with an authority on each entry - is the same
 * whichever entry happened to surface it, so a position would point at a
 * scapegoat rather than at the fault. A value refusal is the opposite: exactly
 * one entry holds the offending value.
 *
 * The catch also refuses to dress up an error it did not cause. Coercing the
 * value for the message runs user code (`Symbol.toPrimitive`), and something
 * thrown from there is the caller's, not a seq verdict.
 *
 * @param {unknown} value the entry's `seq` field, read once by the caller
 * @param {number} [index] the entry's position, named in a refusal
 * @returns {number | boolean | undefined} `undefined` inherits the shared
 *   options; a NUMBER is the validated explicit authority (callers gate their
 *   authority assertion on this form); `true` draws the entry its own counter
 *   value; `false` (the resolution of both `false` and `null`) leaves the
 *   entry seq-less. Anything else throws naming the legal forms - before the
 *   caller has stamped or delivered anything.
 */
export function resolveEntrySeq(value, index) {
	try {
		return resolveEntrySeqValue(value);
	} catch (error) {
		if (index === undefined || !(error instanceof TypeError)) throw error;
		throw new TypeError(`batch entry ${index}: ${error.message}`, { cause: error });
	}
}

/** @param {unknown} value @returns {number | boolean | undefined} */
function resolveEntrySeqValue(value) {
	if (value === undefined) return undefined;
	if (typeof value === 'number' || typeof value === 'bigint') return explicitSeqValue(value);
	if (value === false || value === null) return false;
	if (value === true) return true;
	throwInvalidSeq(value);
}

/**
 * Resolve the SEND lanes' `seq` option - the gap-fill channel a resume hook
 * replays history through. Explicit forms only: number and bigint validate
 * exactly as the publish lanes' explicit authority
 * ({@link explicitSeqValue}); `false`, `null` and absent mean no seq, the
 * lanes' historical shape. `true` throws its own message rather than the
 * publish table's: a single-target send has no counter to draw - gap-fill
 * replays history that is already accounted - and silently meaning
 * something else here is how the publish table's misuse class started.
 *
 * ONE resolver for every surface carrying the send lanes, for the same
 * anti-drift reason {@link resolveEntrySeq} is one.
 *
 * @param {unknown} opt
 * @returns {number | null}
 */
export function resolveSendSeq(opt) {
	if (opt === undefined || opt === false || opt === null) return null;
	if (typeof opt === 'number' || typeof opt === 'bigint') return explicitSeqValue(opt);
	throw new TypeError(
		'send seq must be an explicit positive integer number or bigint (a replay authority\'s value), ' +
		'or false/null/absent for no seq; the send lanes never draw the in-memory counter'
	);
}

/**
 * Resolve the sequence number to stamp on a publish, honoring an explicit
 * caller-supplied authority. Shared by every publish entry point so the
 * three-way resolution never drifts between them.
 *
 * Keyed STRICTLY on the `seq` option type, one spelling for every publish
 * lane and for `publishWireBatch`'s per-entry `seq`:
 *
 * - a NUMBER or BIGINT: stamp that explicit value (validated and projected by
 *   {@link explicitSeqValue}) and do NOT advance the in-memory per-worker
 *   counter. This is a cluster-authoritative seq a replay backend already
 *   allocated (a Redis Lua INCR, a Postgres CTE, or the in-memory buffer's
 *   own counter), so the broadcast wire seq and the replay seq occupy ONE
 *   space instead of diverging. Explicit seqs originate on different workers
 *   and interleave on arrival, so a caller that tracks a max-seen map must
 *   record them through the monotone-max guard (`recordSeen`), never a bare
 *   set - a bare set could regress the local max.
 * - `false` or `null`: no seq. Returns null so the field is omitted from the
 *   envelope and the topic stays out of the cross-worker SEQUENCE comparison
 *   (it has no number to compare). Such a topic is still contiguity-checked
 *   over the relay, which numbers frames independently of the publish seq.
 *   `null` means no-seq rather than the counter because it is what a nullable
 *   column or a JSON round trip hands a caller who KNOWS no seq - silently
 *   drawing the counter for it would mark the topic non-authoritative behind
 *   the caller's back.
 * - absent (`undefined`) or `true`: the in-memory per-worker counter - the
 *   zero-config default, so resume dedup works without the caller naming an
 *   authority. A topic already in the map advances by one, exactly as every
 *   prior release did. A topic NEW to the map starts at 1 for a caller that
 *   passes no `bound`, and at the bound's carried floor plus one for a caller
 *   that does - the registry may forget a topic, but the counter it hands out
 *   must never repeat a number a client has already seen.
 * - anything else - a string from a JSON column, an object, a symbol - THROWS
 *   naming the legal forms. A string meant as a seq used to draw the counter
 *   silently, which degraded resume dedup with no signal; the misuse now has
 *   one failure mode instead of two.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `nextTopicSeq`), so a unit test can pass a fresh map per case.
 *
 * @param {{ seq?: boolean | number | bigint | null } | null | undefined} options
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @param {{ floorOf(topic: string): number, onInsert(topic: string): void } | undefined} [bound]
 * @returns {number | null}
 */
export function stampSeq(options, seqMap, topic, bound) {
	return stampSeqValue(options != null ? options.seq : undefined, seqMap, topic, bound);
}

/**
 * The value form of `stampSeq`, for callers that already hold the `seq`
 * option as a local. The hot publish lanes read each option field exactly
 * once, up front, so the value the cluster-authority check judged and the
 * value stamped here are the same read - a stateful accessor cannot answer
 * the check with `false` and hand the stamp a number. Same three-way
 * resolution, same validation, same counter semantics as the options form,
 * which delegates here so the rule cannot drift.
 *
 * @param {boolean | number | bigint | null | undefined} opt
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @param {{ floorOf(topic: string): number, onInsert(topic: string): void } | undefined} [bound]
 * @returns {number | null}
 */
export function stampSeqValue(opt, seqMap, topic, bound) {
	if (opt === false || opt === null) return null;
	if (typeof opt === 'number') {
		// An explicit seq is a cluster-authoritative value that must survive BOTH
		// the JSON envelope and the 0x03 binary frame and drive the client's resume
		// gap-fill, so it must be a positive integer. The binary frame reserves 0 as
		// its "no seq" sentinel (a stamped 0 would vanish for binary subscribers),
		// and a non-finite / negative / fractional value would emit invalid JSON,
		// diverge from the varint, and poison the monotone-max guard. The in-memory
		// counter and every shipped authority (Redis INCR) are 1-based; a 0-based
		// external source must offset by 1. Fail fast rather than corrupt the wire.
		// Inlined from explicitSeqValue so the overwhelmingly common number
		// spelling keeps its single call frame on the hot path; SAFE integer,
		// because the wire carries the value faithfully only inside that range.
		if (Number.isSafeInteger(opt) && opt >= 1) return opt;
		// Cold: let the shared validator pick between the two refusals, so the
		// inlined arm cannot drift from it on which message a value earns.
		// RETURNED, not called for effect: if the two predicates ever diverge
		// so that the validator ACCEPTS a number this arm rejected, returning
		// hands back the accepted value instead of throwing the legal-forms
		// error over it - drift-proof in both directions rather than one.
		return explicitSeqValue(opt);
	}
	if (typeof opt === 'bigint') return explicitSeqValue(opt);
	if (opt !== undefined && opt !== true) throwInvalidSeq(opt);
	// The in-memory per-worker counter, inlined from `nextTopicSeq` rather than
	// called, so the common publish stays a single call frame (a wrapper call
	// measured a few percent on the isolated publish-resolution micro-bench).
	// Same increment semantics for a known topic: previous value plus one.
	const current = seqMap.get(topic);
	if (current !== undefined) {
		const next = current + 1;
		seqMap.set(topic, next);
		return next;
	}
	// A topic new to the map - the cold path. A caller holding a bound resumes
	// above any floor a prior eviction carried (the counter never goes
	// backward, so held client watermarks stay valid) and then lets the bound
	// enforce its cap; a bare-map caller keeps the historical first-call-is-1.
	const next = (bound !== undefined ? bound.floorOf(topic) : 0) + 1;
	seqMap.set(topic, next);
	if (bound !== undefined) bound.onInsert(topic);
	return next;
}

/**
 * Never read: `assertStampableSeq` returns before the counter arm for the only
 * two spellings that reach it. Passed rather than omitted so an edit that moved
 * a map read above the value arms fails loudly here, instead of quietly
 * counting into a scratch map no publish ever stamps from.
 */
const NO_COUNTER = /** @type {Map<string, number>} */ (/** @type {unknown} */ (null));

/**
 * Refuse a `seq` option the publish lanes could not stamp - without stamping,
 * drawing a counter, or touching a map.
 *
 * The lanes validate as a side effect of stamping, and the stamp is the LAST
 * thing they do: the egress ceiling and the batch fan-out both run before it.
 * So a value refusal used to arrive after a decision had already been taken -
 * a caller under an armed ceiling was answered `false`, which is also the
 * ordinary answer under load, and only got the TypeError once the ceiling
 * relaxed. Calling this first makes the refusal unconditional and puts it
 * ahead of anything irreversible.
 *
 * Delegated to {@link stampSeqValue} rather than restating its table. A second
 * copy of the spellings is the drift {@link resolveEntrySeq} was made shared to
 * prevent, and a checker that accepted what the stamp refuses would leave the
 * throw exactly where it was.
 *
 * @param {unknown} opt the `seq` option, read once by the caller
 * @returns {void}
 * @throws {TypeError} if the stamp would refuse this value
 */
export function assertStampableSeq(opt) {
	// The counter spellings cannot be refused, and they are the only arms that
	// read the map - returning here is what lets the delegation run without one.
	if (opt === undefined || opt === true) return;
	stampSeqValue(/** @type {boolean | number | bigint | null} */ (opt), NO_COUNTER, '');
}

/**
 * Build a hybrid logical clock the platform projects as `platform.hlc()`.
 *
 * Each returned stamp is `{ wall, logical, nodeId }`:
 *
 * - `wall` is a NON-DECREASING wall-clock value in epoch milliseconds, read
 *   from the injectable runtime clock. When the clock advances, `wall` moves
 *   up and `logical` resets to `0`. When two stamps land in the same
 *   millisecond, or the clock steps backward, `wall` holds its previous value
 *   and `logical` increments instead. The `(wall, logical)` pair is therefore
 *   strictly increasing across calls even when the underlying clock is coarse
 *   or briefly regresses.
 * - `logical` is the same-millisecond / backward-step tiebreaker.
 * - `nodeId` is a short, stable per-process identity assigned once from the
 *   injectable runtime RNG (so a seeded harness reproduces it). In clustered
 *   mode it is effectively the worker identity.
 *
 * The returned function is intentionally cheap, but it is meant to be called
 * only when an event needs a causal stamp - not on every publish.
 *
 * @returns {() => { wall: number, logical: number, nodeId: string }}
 */
export function createHlc() {
	const nodeId = randomUuid().slice(0, 8);
	let lastWall = 0;
	let logical = 0;
	return function hlc() {
		const w = now();
		if (w > lastWall) {
			lastWall = w;
			logical = 0;
		} else {
			// Same millisecond or a backward clock step: hold the wall value
			// and advance the tiebreaker so the pair still increases.
			logical += 1;
		}
		return { wall: lastWall, logical, nodeId };
	};
}

/**
 * Complete a JSON envelope started by an `envelopePrefix` builder.
 *
 * Appends the JSON-encoded data and an optional `seq` field, plus the
 * closing brace. When `seq` is `null` or `undefined` the field is
 * omitted entirely so the wire shape matches the legacy
 * `{topic,event,data}` envelope verbatim. When `seq` is a number the
 * resulting envelope is `{topic,event,data,seq}`.
 *
 * An optional `jitterMs` stamps a `j` field carrying the de-herd WINDOW (not a
 * pre-rolled offset - one frame fans out to every subscriber, so a single rolled
 * value would defer them all identically and spread nothing). Each client rolls
 * its own delay in `[0, j)` before dispatching, so the receivers ramp instead of
 * spiking. Omitted (`null`/`undefined`) leaves the wire shape unchanged.
 *
 * No JSON.stringify on seq/jitter: numbers serialize identically via plain string
 * concatenation, saving a stringify call on the publish hot path. The no-jitter
 * tail is byte-identical to the legacy envelope.
 *
 * @param {string} prefix  output of envelopePrefix(topic, event)
 * @param {unknown} data
 * @param {number | null | undefined} seq
 * @param {number | null | undefined} [jitterMs]  de-herd window in ms
 * @returns {string}
 */
export function completeEnvelope(prefix, data, seq, jitterMs) {
	const body = prefix + JSON.stringify(data ?? null);
	const tail = jitterMs == null ? '}' : ',"j":' + jitterMs + '}';
	return seq == null ? body + tail : body + ',"seq":' + seq + tail;
}

/**
 * Complete a client-relay (`game` lane) envelope: the standard
 * `{topic, event, data, seq}` shape with the sender's client `id` echoed to the
 * other receivers when present, for input ordering / prediction-reconcile. `id`
 * is JSON-encoded so a string id (with quotes / unicode) is emitted safely; a
 * numeric id serializes to the same bytes a hand-rolled concat would. Absent
 * `id` (or `seq`) leaves that field off, so the frame stays a plain envelope.
 *
 * @param {string} prefix  output of envelopePrefix(topic, event)
 * @param {unknown} data
 * @param {number | null | undefined} seq
 * @param {number | string | null | undefined} id  the sender's client input id
 * @returns {string}
 */
export function completeGameEnvelope(prefix, data, seq, id) {
	const body = prefix + JSON.stringify(data ?? null);
	const seqTail = seq == null ? '' : ',"seq":' + seq;
	const idTail = id == null ? '' : ',"id":' + JSON.stringify(id);
	return body + seqTail + idTail + '}';
}

/**
 * Wrap an array of pre-built per-event envelope strings into a single
 * `{"type":"batch","events":[...]}` wire frame. Each input string is
 * a complete `{topic, event, data, seq?}` envelope as produced by
 * `completeEnvelope`. The output is the wire format
 * `platform.publishBatched` emits for clients that have advertised
 * the `'batch'` capability.
 *
 * Pure helper: pure string concatenation, no allocations beyond the
 * result string and the intermediate join. Cheap enough to live on
 * the publishBatched hot path.
 *
 * @param {string[]} eventEnvelopes
 * @returns {string}
 */
export function wrapBatchEnvelope(eventEnvelopes) {
	if (eventEnvelopes.length === 0) return '{"type":"batch","events":[]}';
	return '{"type":"batch","events":[' + eventEnvelopes.join(',') + ']}';
}
