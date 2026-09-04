// Microbenchmark: A/B how a per-connection runtime slot is WRITTEN onto the
// socket's userData object.
//
// The runtime keeps per-connection state on `ws.getUserData()` under
// `Symbol.for` keys. A plain `ud[KEY] = value` performs [[Set]], which walks
// the prototype chain: an accessor installed for that key on Object.prototype
// takes the write and creates no own property. Every one of these sites is a
// lazy init or a state transition guarded by a falsy test, so a swallowed
// write does not merely lose the value - the guard never closes, and the lane
// re-does its initialization on every pass. The coalescing lane is the sharp
// case: it re-allocates its pending Map per message and coalesces nothing.
//
// Four ways to write the slot, over the three phases a connection actually
// runs:
//
//   open        the upgrade path builds userData and writes the open-time
//               slots. Once per connection, on the connection-churn path.
//   transition  a later state write onto an object that already exists -
//               a capability grant, a lease, a lazy Map init. Per subscribe
//               or per grant, not per frame.
//   read        the per-message half. Nothing is written here; this is the
//               hot lane reading slots off whatever object shape the arm
//               produced, which is where a dictionary-mode object would be
//               paid for on every frame rather than once.
//
// `assign` is the shipped shape and also runs a second time as `control`.
// The two are the same code on the same data, so the spread between them is
// this bench's noise floor. Read every other arm against control, never
// against zero.
//
// Usage:
//   node bench/micro-userdata-slot-write-ab.mjs [iterations] [rounds]
// Defaults: 2_000_000 iterations, 9 rounds.

const ITERATIONS = parseInt(process.argv[2] || '2000000', 10);
const ROUNDS = parseInt(process.argv[3] || '9', 10);

// The keys are Symbol.for in the runtime so that duplicated module instances
// resolve the same slot. Spelling them the same way here keeps the operand
// shape honest: a registered symbol is not a different property-lookup cost
// than a unique one, but the bench should not quietly test a cheaper thing
// than the code it stands in for.
const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');
const WS_PLATFORM = Symbol.for('adapter-uws.ws.platform');
const WS_SESSION_ID = Symbol.for('adapter-uws.ws.session-id');
const WS_REQUEST_ID = Symbol.for('adapter-uws.ws.request-id');
const WS_TRACE_CONTEXT = Symbol.for('adapter-uws.ws.trace-context');
const WS_STATS = Symbol.for('adapter-uws.ws.stats');
const WS_CAPS = Symbol.for('adapter-uws.ws.caps');
const WS_LEASE = Symbol.for('adapter-uws.ws.lease');
const WS_COALESCED = Symbol.for('adapter-uws.ws.coalesced');
const WS_PUBLISH_GRANT = Symbol.for('adapter-uws.ws.publish-grant');

// Every slot the arms below touch, in the order the connection reaches them.
// `predefine` needs the whole list up front; the others ignore it.
const SLOTS = [
	WS_SUBSCRIPTIONS, WS_PLATFORM, WS_SESSION_ID, WS_REQUEST_ID,
	WS_TRACE_CONTEXT, WS_STATS, WS_CAPS, WS_LEASE, WS_COALESCED,
	WS_PUBLISH_GRANT
];

const PLATFORM = { publish() {} };
const STATS = { messages: 0, bytes: 0 };
const CAPS = { presence: true, cursor: true };

// - Arm A: the shipped shape. A bare assignment on every write. --
function openAssign(ip, requestId, trace) {
	const ud = { remoteAddress: ip };
	ud[WS_SUBSCRIPTIONS] = new Set();
	ud[WS_PLATFORM] = PLATFORM;
	ud[WS_SESSION_ID] = requestId;
	ud[WS_REQUEST_ID] = requestId;
	ud[WS_TRACE_CONTEXT] = trace;
	ud[WS_STATS] = STATS;
	return ud;
}

function transitionAssign(ud, topic) {
	ud[WS_CAPS] = CAPS;
	ud[WS_LEASE] = { gate: 1, saturation: 0 };
	let pending = ud[WS_COALESCED];
	if (!pending) {
		pending = new Map();
		ud[WS_COALESCED] = pending;
	}
	ud[WS_PUBLISH_GRANT] = topic;
	return pending;
}

// - Arm B: defineProperty at every write. Consults no prototype, and pays a
//   descriptor object each time. --
function define(target, key, value) {
	// A fresh descriptor literal, not a reused template: the shipped helper
	// would be written this way, and a reused object forces the generic path
	// that re-reads every descriptor field through a lookup.
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function openDefine(ip, requestId, trace) {
	const ud = { remoteAddress: ip };
	define(ud, WS_SUBSCRIPTIONS, new Set());
	define(ud, WS_PLATFORM, PLATFORM);
	define(ud, WS_SESSION_ID, requestId);
	define(ud, WS_REQUEST_ID, requestId);
	define(ud, WS_TRACE_CONTEXT, trace);
	define(ud, WS_STATS, STATS);
	return ud;
}

function transitionDefine(ud, topic) {
	define(ud, WS_CAPS, CAPS);
	define(ud, WS_LEASE, { gate: 1, saturation: 0 });
	let pending = ud[WS_COALESCED];
	if (!pending) {
		pending = new Map();
		define(ud, WS_COALESCED, pending);
	}
	define(ud, WS_PUBLISH_GRANT, topic);
	return pending;
}

// - Arm C: define every slot once at open, then assign. Once an OWN data
//   property exists, [[Set]] finds it before the prototype chain and no
//   accessor can intercept - so only the first write per slot has to be a
//   definition, and the per-transition and per-message halves stay bare
//   assignments on a fully populated object. --
function openPredefine(ip, requestId, trace) {
	const ud = { remoteAddress: ip };
	for (let i = 0; i < SLOTS.length; i++) define(ud, SLOTS[i], undefined);
	ud[WS_SUBSCRIPTIONS] = new Set();
	ud[WS_PLATFORM] = PLATFORM;
	ud[WS_SESSION_ID] = requestId;
	ud[WS_REQUEST_ID] = requestId;
	ud[WS_TRACE_CONTEXT] = trace;
	ud[WS_STATS] = STATS;
	return ud;
}

// - Arm E: one object literal that declares every slot. A computed key in a
//   literal is CreateDataProperty, not [[Set]], so the literal is already
//   immune without a single defineProperty call - and every later write lands
//   on an own property that shadows whatever the prototype carries. This is
//   the shape available wherever the runtime builds userData itself. --
function openLiteral(ip, requestId, trace) {
	const ud = {
		remoteAddress: ip,
		[WS_SUBSCRIPTIONS]: new Set(),
		[WS_PLATFORM]: PLATFORM,
		[WS_SESSION_ID]: requestId,
		[WS_REQUEST_ID]: requestId,
		[WS_TRACE_CONTEXT]: trace,
		[WS_STATS]: STATS,
		[WS_CAPS]: undefined,
		[WS_LEASE]: undefined,
		[WS_COALESCED]: undefined,
		[WS_PUBLISH_GRANT]: undefined
	};
	return ud;
}

// - Arm F: the same immunity, but with the slot list in one place. Spreading a
//   shared template also copies with CreateDataProperty, and repeating the
//   slot names at each construction site is the maintenance shape where a slot
//   added later is silently left out. Priced separately because a spread is
//   not free by assumption. --
const SLOT_TEMPLATE = Object.freeze({
	[WS_SUBSCRIPTIONS]: undefined,
	[WS_PLATFORM]: undefined,
	[WS_SESSION_ID]: undefined,
	[WS_REQUEST_ID]: undefined,
	[WS_TRACE_CONTEXT]: undefined,
	[WS_STATS]: undefined,
	[WS_CAPS]: undefined,
	[WS_LEASE]: undefined,
	[WS_COALESCED]: undefined,
	[WS_PUBLISH_GRANT]: undefined
});

function openSpread(ip, requestId, trace) {
	const ud = {
		...SLOT_TEMPLATE,
		remoteAddress: ip,
		[WS_SUBSCRIPTIONS]: new Set(),
		[WS_PLATFORM]: PLATFORM,
		[WS_SESSION_ID]: requestId,
		[WS_REQUEST_ID]: requestId,
		[WS_TRACE_CONTEXT]: trace,
		[WS_STATS]: STATS
	};
	return ud;
}

// - Arm G: the shape the APP-SUPPLIED path is stuck with. When an upgrade hook
//   returns its own object the runtime must keep that identity, so it cannot
//   build a literal - it can only add own slots to what it was handed. One
//   `defineProperties` with a prebuilt descriptor map instead of a
//   defineProperty per slot. --
const SLOT_DESCRIPTORS = Object.freeze(Object.fromEntries(
	SLOTS.map((key) => [key, { value: undefined, writable: true, enumerable: true, configurable: true }])
));

function openDefineProperties(ip, requestId, trace) {
	const ud = { remoteAddress: ip };
	Object.defineProperties(ud, SLOT_DESCRIPTORS);
	ud[WS_SUBSCRIPTIONS] = new Set();
	ud[WS_PLATFORM] = PLATFORM;
	ud[WS_SESSION_ID] = requestId;
	ud[WS_REQUEST_ID] = requestId;
	ud[WS_TRACE_CONTEXT] = trace;
	ud[WS_STATS] = STATS;
	return ud;
}

// - Arm D: a null-prototype object, bare assignments. There is no chain to
//   walk, so nothing can intercept - but the object may leave V8's fast mode,
//   which the read phase is there to price. --
function openNullProto(ip, requestId, trace) {
	const ud = Object.create(null);
	ud.remoteAddress = ip;
	ud[WS_SUBSCRIPTIONS] = new Set();
	ud[WS_PLATFORM] = PLATFORM;
	ud[WS_SESSION_ID] = requestId;
	ud[WS_REQUEST_ID] = requestId;
	ud[WS_TRACE_CONTEXT] = trace;
	ud[WS_STATS] = STATS;
	return ud;
}

// The per-message half. Three slot reads and a falsy test, which is what the
// send and coalesce lanes do before they touch a frame.
function readHot(ud) {
	const platform = ud[WS_PLATFORM];
	const subs = ud[WS_SUBSCRIPTIONS];
	const pending = ud[WS_COALESCED];
	return (platform !== undefined ? 1 : 0) + (subs !== undefined ? 1 : 0) + (pending ? pending.size : 0);
}

const ARMS = [
	['assign', openAssign, transitionAssign],
	['control', openAssign, transitionAssign],
	['define', openDefine, transitionDefine],
	['predefine', openPredefine, transitionAssign],
	['literal', openLiteral, transitionAssign],
	['spread', openSpread, transitionAssign],
	['defineprops', openDefineProperties, transitionAssign],
	['nullproto', openNullProto, transitionAssign]
];

function timeOpen(open, iterations) {
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) {
		const ud = open('127.0.0.1', i, null);
		sink += ud[WS_SESSION_ID] === i ? 1 : 0;
	}
	return { ns: Number(process.hrtime.bigint() - start), sink };
}

function timeTransition(open, transition, iterations) {
	// One object per iteration would time `open` again. Reuse a small ring so
	// the transition runs on objects that already exist, which is when the
	// runtime performs these writes.
	const ring = [];
	for (let i = 0; i < 64; i++) ring.push(open('127.0.0.1', i, null));
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) {
		const pending = transition(ring[i & 63], 'room');
		sink += pending.size + 1;
	}
	return { ns: Number(process.hrtime.bigint() - start), sink };
}

function timeRead(open, transition, iterations) {
	const ring = [];
	for (let i = 0; i < 64; i++) {
		const ud = open('127.0.0.1', i, null);
		transition(ud, 'room');
		ring.push(ud);
	}
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) sink += readHot(ring[i & 63]);
	return { ns: Number(process.hrtime.bigint() - start), sink };
}

// An arm that cannot survive an inherited accessor is not a candidate, however
// fast it is. Prove immunity before printing a number for it, on the same code
// the timing loops call.
function immune(open, transition) {
	const key = WS_PUBLISH_GRANT;
	let stolen = null;
	let ok = false;
	Object.defineProperty(Object.prototype, key, {
		set(v) { stolen = v; },
		get() { return undefined; },
		configurable: true
	});
	try {
		const ud = open('127.0.0.1', 1, null);
		transition(ud, 'room');
		ok = stolen === null && ud[key] === 'room';
	} finally {
		delete Object.prototype[key];
	}
	return ok;
}

const med = (xs) => xs.slice().sort((p, q) => p - q)[xs.length >> 1];
const pct = (v, base) => (((v - base) / base) * 100).toFixed(2) + '%';

const results = new Map();
for (const [name] of ARMS) results.set(name, { open: [], transition: [], read: [] });
let totalSink = 0;

// Warm every arm through the three timing loops before any of them is timed.
// The loops take the arm's functions as arguments, so whichever arm runs first
// gets a monomorphic call site and every later arm pays a megamorphic one:
// timing arm-by-arm made the control column read 148% slower than the
// identical arm ahead of it. Warm all arms first, then round-robin, so every
// arm meets the same inline caches.
for (const [, open, transition] of ARMS) {
	totalSink += timeOpen(open, 20000).sink;
	totalSink += timeTransition(open, transition, 20000).sink;
	totalSink += timeRead(open, transition, 20000).sink;
}

for (let round = 0; round < ROUNDS; round++) {
	for (const [name, open, transition] of ARMS) {
		const bucket = results.get(name);
		const o = timeOpen(open, ITERATIONS);
		const t = timeTransition(open, transition, ITERATIONS);
		const r = timeRead(open, transition, ITERATIONS);
		bucket.open.push(o.ns);
		bucket.transition.push(t.ns);
		bucket.read.push(r.ns);
		totalSink += o.sink + t.sink + r.sink;
	}
}

for (const [name, open, transition] of ARMS) {
	const bucket = results.get(name);
	results.set(name, {
		open: med(bucket.open) / ITERATIONS,
		transition: med(bucket.transition) / ITERATIONS,
		read: med(bucket.read) / ITERATIONS,
		immune: immune(open, transition)
	});
}

const base = results.get('assign');
console.log(`iterations ${ITERATIONS}   rounds ${ROUNDS}   node ${process.version}`);
console.log('');
console.log('arm         open ns/conn      transition ns/op     read ns/op        accessor-immune');
for (const [name, r] of results) {
	console.log(
		name.padEnd(11) +
		`${r.open.toFixed(1).padStart(7)} ${pct(r.open, base.open).padStart(9)}   ` +
		`${r.transition.toFixed(1).padStart(7)} ${pct(r.transition, base.transition).padStart(9)}   ` +
		`${r.read.toFixed(2).padStart(6)} ${pct(r.read, base.read).padStart(9)}   ` +
		(r.immune ? 'yes' : 'NO').padStart(8)
	);
}
console.log('');
console.log('control is `assign` run twice: its column is the noise floor, not an effect.');
// Defeats dead-code elimination of the writes and reads above.
console.log('sink', totalSink);
