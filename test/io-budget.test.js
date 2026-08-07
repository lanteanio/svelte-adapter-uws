// Deterministic hot-path budgets. These count calls and bulk copies at the
// runtime's existing I/O boundaries; they deliberately never read a clock.
//
// The numbers are measured contracts, not performance wishes. Lowering a
// budget is welcome. Raising one is a design decision and must record the
// reason beside the changed budget in the same change.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { send400, send413, send500 } from '../src/runtime/handler/http-helpers.js';
import { writeChunkWithBackpressure } from '../src/runtime/utils/backpressure.js';
import { buildBinaryFrame, parseBinaryFrame } from '../src/runtime/wire.js';
import { dispatchIngressFrame } from '../src/runtime/handler/ingress.js';
import { deliverStatefulWireBatch } from '../src/runtime/handler/wire-fanout.js';
import { WS_CAPS, WS_INGRESS_BINDINGS, WS_SUBSCRIPTIONS, WS_TOPIC_IDS } from '../src/runtime/utils.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

/**
 * The scaling detector shared by every "6x input must not multiply X" gate.
 * It refuses zero work so an unexercised seam cannot pass vacuously.
 */
function assertScaleInvariant(name, small, large) {
	if (!(small > 0)) throw new Error(`${name}: small fixture exercised zero operations`);
	if (large !== small) throw new Error(`${name}: scaled from ${small} to ${large}`);
}

function countingResponse(writeResult = true) {
	const counts = { cork: 0, status: 0, header: 0, write: 0, end: 0, writable: 0 };
	return {
		counts,
		cork(fn) { counts.cork++; fn(); },
		writeStatus() { counts.status++; },
		writeHeader() { counts.header++; },
		write() { counts.write++; return writeResult; },
		end() { counts.end++; },
		onWritable() { counts.writable++; }
	};
}

function countedFrame(payloadLength, builder = buildBinaryFrame) {
	const counts = { allocations: 0, copies: 0 };
	const io = {
		allocate(length) {
			counts.allocations++;
			return new Uint8Array(length);
		},
		copy(target, source, offset) {
			counts.copies++;
			target.set(source, offset);
		}
	};
	const payload = new Uint8Array(payloadLength).fill(0xa5);
	const frame = builder(3, 300, 5_000_000_000, payload, io);
	const parsed = parseBinaryFrame(frame);
	expect(parsed).not.toBeNull();
	// subarray(), not slice(): inbound framing exposes a view over the original
	// network buffer and performs zero bulk copies.
	expect(parsed.payload.buffer).toBe(frame.buffer);
	expect(parsed.payload.byteLength).toBe(payloadLength);
	return counts;
}

function countedIngressDispatch(payloadLength) {
	const counts = { sliceCopies: 0, decodes: 0, routes: 0 };
	class CountedNetworkBytes extends Uint8Array {
		slice(start, end) {
			counts.sliceCopies++;
			return super.slice(start, end);
		}
	}
	const payload = new Uint8Array(payloadLength).fill(0x5a);
	const frame = buildBinaryFrame(3, 300, 5_000_000_000, payload);
	// A non-zero offset proves dispatch preserves the actual network view, not
	// merely a same-length allocation that happens to contain equal bytes.
	const storage = new CountedNetworkBytes(frame.length + 8);
	storage.set(frame, 4);
	const message = storage.subarray(4, 4 + frame.length);
	let decodedPayload = null;
	const ud = {};
	ud[WS_INGRESS_BINDINGS] = new Map([[300, {
		target: null,
		state: null,
		decode(value) {
			counts.decodes++;
			decodedPayload = value;
			return value;
		},
		route() { counts.routes++; }
	}]]);
	dispatchIngressFrame({}, ud, message, null);
	expect(decodedPayload).not.toBeNull();
	expect(decodedPayload.buffer).toBe(message.buffer);
	expect(decodedPayload.byteOffset).toBe(message.byteOffset + frame.length - payloadLength);
	expect(decodedPayload.byteLength).toBe(payloadLength);
	return counts;
}

function executeCatchRestCopy(bytes) {
	try {
		throw bytes;
	} catch ([...copy]) {
		return copy;
	}
}

function executeCatchAliasClone(bytes) {
	try {
		throw bytes;
	} catch (alias) {
		return structuredClone(alias);
	}
}

function hiddenByteCloneTag(_strings, bytes) {
	return structuredClone(bytes);
}

function executeTaggedTemplateClone(bytes) {
	return hiddenByteCloneTag`${bytes}`;
}

function executeCatchDefaultClone(bytes) {
	try {
		throw {};
	} catch ({ missing: alias = bytes }) {
		return structuredClone(alias);
	}
}

function executeLocalThrowClone(bytes) {
	function throwBytes() { throw bytes; }
	try {
		throwBytes();
	} catch (alias) {
		return structuredClone(alias);
	}
}

function executeReturnedTaggedClone(bytes) {
	function getBytes() { return bytes; }
	return hiddenByteCloneTag`${getBytes()}`;
}

function executeGetterTaggedClone(bytes) {
	const box = { get value() { return bytes; } };
	return hiddenByteCloneTag`${box.value}`;
}

function executeGetterDestructureRestCopy(bytes) {
	const box = { get value() { return bytes; } };
	const { value: hiddenBytes } = box;
	const [...copy] = hiddenBytes;
	return copy;
}

function executeGeneratorIterationClone(bytes) {
	function* values() { yield bytes; }
	for (const value of values()) return structuredClone(value);
	throw new Error('byte generator yielded no value');
}

function executeClassCatchRestCopy(bytes) {
	class ByteBox { static get value() { return bytes; } }
	try {
		throw ByteBox.value;
	} catch ([...copy]) {
		return copy;
	}
}

function executeClassGetterClone(bytes) {
	class ByteBox { static get value() { return bytes; } }
	return structuredClone(ByteBox.value);
}

function executeGeneratorClone(bytes) {
	function* byteValues() { yield bytes; }
	return structuredClone(byteValues().next().value);
}

function executeDefaultProducerClone(bytes) {
	function byteValue(value = bytes) { return value; }
	return structuredClone(byteValue());
}

function executeNestedGetterClone(bytes) {
	const box = { nested: { get value() { return bytes; } } };
	return structuredClone(box.nested.value);
}

function hiddenThunkCloneTag(_strings, thunk) {
	return structuredClone(thunk());
}

function executeThunkTaggedClone(bytes) {
	return hiddenThunkCloneTag`${() => bytes}`;
}

async function executeAsyncDefaultClone(bytes) {
	async function clone(value = bytes) { return structuredClone(value); }
	return clone();
}

function countedStructuredClone(value, counts) {
	const clone = structuredClone(value);
	counts.copies++;
	counts.bytes += value.byteLength;
	return clone;
}

function executeDiscardedSendClones(values) {
	const counts = { copies: 0, bytes: 0 };
	const clones = [];
	for (const value of values) {
		if (value instanceof Uint8Array) clones.push(countedStructuredClone(value, counts));
	}
	return { counts, clones };
}

function executeDiscardedDefaultCopyClone(source) {
	const counts = { copies: 0, bytes: 0 };
	const hidden = countedStructuredClone(source, counts);
	const target = new Uint8Array(source.byteLength);
	target.set(source, 0);
	return { counts, hidden, target };
}

function executeDiscardedParseClone(bytes) {
	const counts = { copies: 0, bytes: 0 };
	const hidden = countedStructuredClone(bytes, counts);
	return { counts, hidden, parsed: parseBinaryFrame(bytes) };
}

function executeDelegatedSendClones(values) {
	const counts = { copies: 0, bytes: 0, writes: 0 };
	const baseSend = (_ws, _value, _binary) => { counts.writes++; return 1; };
	const delegatedSend = (ws, value, binary) => {
		if (value instanceof Uint8Array) countedStructuredClone(value, counts);
		return baseSend(ws, value, binary);
	};
	for (const value of values) delegatedSend({}, value, true);
	return counts;
}

function executeDelegatedDefaultFrameIOClone(source) {
	const counts = { copies: 0, bytes: 0 };
	const nativeFrameIO = Object.freeze({
		allocate: (length) => new Uint8Array(length),
		copy: (target, value, offset) => target.set(value, offset)
	});
	let activeFrameIO = nativeFrameIO;
	const delegatedFrameIO = Object.create(activeFrameIO);
	Object.defineProperty(delegatedFrameIO, 'copy', {
		value(target, value, offset) {
			countedStructuredClone(value, counts);
			return nativeFrameIO.copy(target, value, offset);
		}
	});
	activeFrameIO = delegatedFrameIO;
	return { counts, frame: buildBinaryFrame(3, 1, 0, source, activeFrameIO) };
}

function executeDiscardedByteReaderClone(bytes) {
	const counts = { copies: 0, bytes: 0 };
	class CloningByteReader {
		constructor(buf) {
			this.hidden = countedStructuredClone(buf, counts);
			this._buf = buf;
			this.pos = 0;
		}
		u8() { return this._buf[this.pos++]; }
		varint() {
			let result = 0;
			let mul = 1;
			let value;
			do {
				value = this._buf[this.pos++];
				result += (value & 0x7f) * mul;
				mul *= 128;
			} while (value & 0x80);
			return result;
		}
	}
	const reader = new CloningByteReader(bytes);
	reader.u8();
	const schemaVersion = reader.u8();
	const topicId = reader.varint();
	const seq = reader.varint();
	return {
		counts,
		hidden: reader.hidden,
		parsed: { schemaVersion, topicId, seq, payload: bytes.subarray(reader.pos) }
	};
}

function executeEvalSendRebindClones(values) {
	const counts = { copies: 0, bytes: 0, writes: 0 };
	let send = (_io, _ws, _value, _binary) => { counts.writes++; return 1; };
	eval('send = ((baseSend) => (io, ws, value, binary) => { if (value instanceof Uint8Array) countedStructuredClone(value, counts); return baseSend(io, ws, value, binary); })(send)');
	for (const value of values) send({}, {}, value, true);
	return counts;
}

function executePrototypeSetDelegation(source) {
	const counts = { copies: 0, bytes: 0 };
	let cloning = false;
	const ownDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
	const baseSet = Uint8Array.prototype.set;
	Object.defineProperty(Uint8Array.prototype, 'set', {
		configurable: true,
		writable: true,
		value(value, offset) {
			if (!cloning && value instanceof Uint8Array) {
				cloning = true;
				try { countedStructuredClone(value, counts); }
				finally { cloning = false; }
			}
			return Reflect.apply(baseSet, this, [value, offset]);
		}
	});
	try {
		return { counts, frame: buildBinaryFrame(3, 1, 0, source) };
	} finally {
		if (ownDescriptor) Object.defineProperty(Uint8Array.prototype, 'set', ownDescriptor);
		else delete Uint8Array.prototype.set;
	}
}

function executePrototypeSubarrayDataViewDelegation(frame) {
	const counts = { copies: 0, bytes: 0 };
	const clones = [];
	let cloning = false;
	const ownDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'subarray');
	const baseSubarray = Uint8Array.prototype.subarray;
	Object.defineProperty(Uint8Array.prototype, 'subarray', {
		configurable: true,
		writable: true,
		value(start, end) {
			if (!cloning) {
				cloning = true;
				try {
					const view = new DataView(this.buffer, this.byteOffset, this.byteLength);
					clones.push(countedStructuredClone(view, counts));
				} finally {
					cloning = false;
				}
			}
			return Reflect.apply(baseSubarray, this, [start, end]);
		}
	});
	try {
		return { counts, clones, parsed: parseBinaryFrame(frame) };
	} finally {
		if (ownDescriptor) Object.defineProperty(Uint8Array.prototype, 'subarray', ownDescriptor);
		else delete Uint8Array.prototype.subarray;
	}
}

async function executeExportedPrototypeSetMutation(mutantSource, source) {
	const copySlot = '__ioBudgetHiddenCopies';
	const ownDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
	globalThis[copySlot] = [];
	try {
		const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(mutantSource)}`;
		const wire = await import(moduleUrl);
		wire.allocWireId({}, Symbol('wire-id'), 'budget-topic');
		const frame = wire.buildBinaryFrame(3, 1, 0, source);
		return { clones: globalThis[copySlot], frame, parsed: wire.parseBinaryFrame(frame) };
	} finally {
		if (ownDescriptor) Object.defineProperty(Uint8Array.prototype, 'set', ownDescriptor);
		else delete Uint8Array.prototype.set;
		delete globalThis[copySlot];
	}
}

function executeModulePrototypeSetMutation(source, mutation = null) {
	const copySlot = '__ioBudgetModuleCopies';
	const ownDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
	globalThis[copySlot] = [];
	if (mutation) {
		Function(mutation)();
	} else {
		const nativeSet = Uint8Array.prototype.set;
		Uint8Array.prototype.set = function(sourceBytes, offset) {
			globalThis.__ioBudgetModuleCopies.push(structuredClone(sourceBytes));
			return nativeSet.call(this, sourceBytes, offset);
		};
	}
	try {
		const frame = buildBinaryFrame(3, 1, 0, source);
		return { clones: globalThis[copySlot], frame, parsed: parseBinaryFrame(frame) };
	} finally {
		if (ownDescriptor) Object.defineProperty(Uint8Array.prototype, 'set', ownDescriptor);
		else delete Uint8Array.prototype.set;
		delete globalThis[copySlot];
	}
}

function executeIngressModulePrototypeSubarrayMutation(frame) {
	const copySlot = '__ioBudgetIngressModuleCopies';
	const ownDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'subarray');
	globalThis[copySlot] = [];
	const nativeSubarray = Uint8Array.prototype.subarray;
	Uint8Array.prototype.subarray = function(start, end) {
		globalThis.__ioBudgetIngressModuleCopies.push(structuredClone(
			new DataView(this.buffer, this.byteOffset, this.byteLength)
		));
		return nativeSubarray.call(this, start, end);
	};
	let decodedPayload = null;
	const ud = {};
	ud[WS_INGRESS_BINDINGS] = new Map([[300, {
		target: null,
		state: null,
		decode(value) { decodedPayload = value; return value; },
		route() {}
	}]]);
	try {
		dispatchIngressFrame({}, ud, frame, null);
		return { clones: globalThis[copySlot], decodedPayload };
	} finally {
		if (ownDescriptor) Object.defineProperty(Uint8Array.prototype, 'subarray', ownDescriptor);
		else delete Uint8Array.prototype.subarray;
		delete globalThis[copySlot];
	}
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIRE_SOURCE = readFileSync(path.join(ROOT, 'src/runtime/wire.js'), 'utf8');
const PLATFORM_SOURCE = readFileSync(path.join(ROOT, 'src/runtime/handler/platform.js'), 'utf8');
const FANOUT_SOURCE = readFileSync(path.join(ROOT, 'src/runtime/handler/wire-fanout.js'), 'utf8');
const INGRESS_SOURCE = readFileSync(path.join(ROOT, 'src/runtime/handler/ingress.js'), 'utf8');
const UTILS_SOURCE = readFileSync(path.join(ROOT, 'src/runtime/utils.js'), 'utf8');
const COPY_AUTHORITY_MODULE_PATHS = Object.freeze({
	ingress: path.join(ROOT, 'src/runtime/handler/ingress.js'),
	platform: path.join(ROOT, 'src/runtime/handler/platform.js'),
	'wire-fanout': path.join(ROOT, 'src/runtime/handler/wire-fanout.js'),
	wire: path.join(ROOT, 'src/runtime/wire.js')
});
const EXTERNAL_CLONE_TAG = 'function hiddenByteCloneTag(_strings, bytes) { return structuredClone(bytes); }\n';
const EXTERNAL_THUNK_CLONE_TAG = 'function hiddenThunkCloneTag(_strings, thunk) { return structuredClone(thunk()); }\n';

// These hashes seal the complete syntax of the production functions that own
// frame bytes. The semantic checks below explain known copy paths and keep safe
// near-misses usable, while this closed boundary makes every new syntax form a
// deliberate budget review instead of an unmodeled parser escape.
// Re-pinned after review of the diagnostics/tracing wiring that moved them:
// the drift is added imports, an `activeTraceContext()` getter, cluster
// sequence-authority assertions, and promise handling around the ingress
// route call. No copy primitive entered either body - the only byte
// construction on the ingress path is the pre-existing zero-copy
// `new Uint8Array(message)` VIEW over an ArrayBuffer argument.
const COPY_AUTHORITY_SYNTAX = Object.freeze({
	publishWire: '7c1abe91f3ecfb8b8b28f31451f06b7fd0529efc027dd508137ae4a8ea79cc49',
	deliverStatelessWireFanout: '98c4246e4bea446d1647f6bf0b13fb0e0cde521ac27dfe899eff42b884113afa',
	dispatchIngressFrame: '5ff5ed75d331620ed0bbdd4ffd9fe57ecb993b3b3d97923bdb7edf48e7483e5b',
	send: 'c900028ed26614f6a0d83b1d57a6649a52db522503def86eee3000541d285b11',
	encodeStatelessWirePayload: 'fcacd501dd3d1bdcc14a5eff364da905f2b5e65999d12c1e8b8ad197ec2fd062',
	allocate: 'd76794d74a23fee1aa0913a38cc231f8dc42793accba687e0167bedd5d6ab1ba',
	copy: '2d371b9cbe141c928ad53c75ea116f666dc3091ea8e4d2b948c327682021c576',
	buildBinaryFrame: '84b0b451c4aa442f8268f81a848a0fdebfd11b93572351a9e06936dd875f2c8d',
	parseBinaryFrame: '4fe040811c87ecdbe7671341abe4548c8ab48ca5be0281a631091e752f2ef527'
});

// Named-function seals are necessary but not sufficient: ESM bindings can be
// reassigned or delegated outside a function body, and classes/active objects
// can hide work behind an unchanged caller. Canonical module seals close the
// actual reachable object graph, every module-evaluation statement, and the
// transitive local ESM evaluation graph behind static and reachable dynamic
// imports.
// Comments, locations, and inert unreferenced function bodies remain free to
// change; executable module edits require a deliberate copy-budget review.
const COPY_AUTHORITY_MODULE_SYNTAX = Object.freeze({
	// Re-pinned for the relay frame-ceiling counters. The drift is in
	// observability-manifest.js, which both this graph and the platform graph
	// reach through utils.js -> utils/metrics.js: two added signal
	// declarations (relay_frame_refused_total, relay_frame_oversized_total)
	// and one label-domain entry (the refusal's lane enum) - frozen object and
	// array literals, data only. No statement executes on any frame path, no
	// byte is read, allocated or copied, and no copy primitive entered either
	// graph.
	//
	// Re-pinned for the pending-subscribe budget, which reaches this graph
	// through utils.js -> utils/ws-symbols.js and utils/subscribe-policy.js:
	// one symbol declaration and a number accessor, one counter increment
	// beside the existing inflight increment, four counter decrements beside
	// the existing inflight decrements, one pure comparison predicate, and a
	// frozen number constant in utils/caps.js. Nothing on any frame path
	// executes differently; no byte is read, allocated or copied, and no copy
	// primitive entered the graph.
	//
	// Re-pinned again with the budget's review repairs, in the same two
	// modules: the derived observer lane now consults the same predicate
	// before it enrols (one comparison, an early `return false`), and the
	// predicate itself gained a type guard on its count so a non-numeric
	// slot value fails closed instead of removing the bound. Comparisons and
	// one early return - no byte is read, allocated or copied, and no copy
	// primitive entered.
	//
	// Re-pinned for the per-entry batch seq, whose only drift in THIS graph is
	// utils/epoch.js reached through utils.js: `throwInvalidSeq`, a cold
	// throw-only helper, and stampSeq's numeric refusal arm now calling it
	// instead of throwing inline - the same TypeError from one shared site so
	// the batch pre-pass and the resolver cannot drift in message or meaning.
	// The valid-seq path is untouched; nothing executes differently on any
	// frame path, no byte is read, allocated or copied, and no copy primitive
	// entered the graph.
	ingress: 'af1f4c2860256b4350ca484c7b7db5b7436009f6940f9606c342cad4e94d8b12',
	// Re-pinned after review of the publishWireBatch stamping-loop change: the
	// drift is three scalar locals (a running highest seq and message/byte
	// accumulators) plus the move of `maxSeenSeq.set`, `stats.m/b` and
	// `counters.publishCountWindow` to AFTER the loop, so a batch that aborts
	// mid-serialisation advances none of them. No copy primitive entered the
	// body: the single added `.set(` is `maxSeenSeq.set(topic, highestSeq)`, a
	// Map of numbers, not `Uint8Array.prototype.set`, and no byte is read,
	// allocated or copied by any of it.
	//
	// Re-pinned again for the pressure freshness field: the drift is one added
	// property read, `sampledAt: p.sampledAt` in the introspect() literal. That
	// path is off the fan-out entirely (one plain object per admin call), and a
	// number-or-null property read owns no bytes and copies none.
	//
	// Re-pinned again for the batch one-read rule: publishWireBatch and
	// sendWireBatch now read each caller entry's fields once into plain arrays
	// (`datas`, and `excludes` only once an entry carries one) instead of
	// re-reading the caller's objects after application toJSON has run. The
	// arrays hold REFERENCES to payloads and sockets - no byte is read, copied
	// or allocated by any of it.
	//
	// Re-pinned again to make the allocation claim above TRUE of both functions.
	// It was written for publishWireBatch, whose `needsData` gate really does
	// skip `datas` unless a binary subscriber or the relay will read it - but it
	// was recorded as covering sendWireBatch too, and that one allocated `datas`
	// unconditionally, ABOVE its capability test. So a caps-less, poisoned or
	// stateless-codec subscriber paid an N-array on the JSON-only send where it
	// had paid none before, and the binary send paid two (a verbatim copy of an
	// already-private array) where it had paid one. sendWireBatch now decides at
	// the same place publishWireBatch does: the JSON-only send takes the pinned
	// array when one exists and reads the caller's entry when it does not, so it
	// allocates nothing again, and the binary send hands its one array to the
	// codec instead of copying it. Both are back to the pre-rule allocation
	// count. The drift here is a parameter on the inner JSON walk and one moved
	// array construction - control flow and references only, no byte read,
	// copied or allocated by any of it, and no copy primitive entered.
	//
	// Re-pinned again for one added condition on the per-socket capability test:
	// `|| !needsData`. The counter that decides `needsData` and the per-socket
	// caps set can disagree for one window while a connection releases its count
	// before leaving the live set, and there are then no payloads to encode from;
	// the socket takes the JSON branch instead of encoding an empty batch. Pure
	// control flow - one boolean read - and it moves work AWAY from the binary
	// path, never toward it. No byte read, copied or allocated, no copy primitive.
	//
	// Re-pinned again for the relay ring's spill ceiling, which reaches this
	// graph through handler/relay.js. The drift is entirely control flow: the
	// byte ceiling now compares against the BACKLOG alone rather than the backlog
	// plus the frame being handed over, the empty-ring branch loses its ceiling
	// test outright (a large frame is not a peer fault and the byte stream is
	// built to carry it in pieces), and `pendingSince` is re-stamped when a push
	// makes progress so the age ceiling means "stopped draining" rather than
	// "backlog non-empty since". Comparisons and one timestamp assignment - no
	// byte is read, copied or allocated by any of it, and no copy primitive
	// entered. It also REMOVES a refusal that ran after `_push` had committed, so
	// no path can leave a partial frame in the shared stream.
	//
	// Re-pinned again for the sender-side relay frame ceiling, which reaches this
	// graph through handler/relay.js. The drift there is a module-level number
	// and callback, one setter, and a length comparison per relayed message that
	// allocates nothing unless something is actually over the ceiling; in
	// relay-ring.js it is one comparison against the frame's own length PREFIX
	// before the reader decides to hold it. Lengths and references only - no byte
	// is read, copied or allocated by any of it, and no copy primitive entered.
	// The single added `.push(` is `admitted.push(m)`, an array of the same
	// message references the batch already held.
	//
	// The added `.push(` calls are the existing per-socket exclusion filter now
	// pushing payload references rather than entry objects, and `.set(` is
	// unchanged.
	//
	// Re-pinned again when the batch sequence check moved AHEAD of the entries
	// inspection (the refusal is a property of the surface, not of the array):
	// the drift is the options copy and the assert call relocating above the
	// `Array.isArray` guard, and the assert losing its count argument. Pure
	// control flow before any byte exists - nothing is read, allocated or copied
	// by it.
	// Re-pinned with the ingress seal above (the manifest data literals reached
	// through utils.js), plus one one-word fix in handler/relay.js: the batched
	// lane's ceiling read `events[i].envelope.length`, a field this lane does
	// not carry - platform.publishBatched relays `{ topic, env, seq }` - so
	// every clustered publishBatched threw under a finite ceiling. It now reads
	// `events[i].env.length`. A member-name change in an existing length read;
	// no byte is read, allocated or copied, and no copy primitive entered.
	//
	// Re-pinned for the pending-subscribe budget: platform.js itself gains one
	// predicate call and two imports ahead of beginPendingSubscribe, and the
	// graph reaches the same utils/ws-symbols.js counter statements and
	// utils/subscribe-policy.js predicate the ingress seal names. Number reads,
	// number arithmetic on userData, and comparisons only - no byte is read,
	// allocated or copied, and no copy primitive entered.
	//
	// Re-pinned again with the budget's review repairs named on the ingress
	// seal above - the derived lane's pre-enrolment check and the predicate's
	// count guard, both reached through the same utils graph. Same review, same
	// verdict: no byte read, allocated or copied, no copy primitive entered.
	//
	// Re-pinned for publishWireBatch's snapshot pass: the stamping loop was
	// split so every entry's `data` and `excludeWs` are read BEFORE the first
	// completeEnvelope runs the payload's toJSON. The drift is one added loop
	// of property reads and stores, the same reads moved out of the loop
	// below, and `datas` losing its `needsData` guard - it now always exists,
	// because N payload REFERENCES have to be held before the first
	// serialise. References, not bytes: nothing is read out of a payload,
	// nothing is copied, and no copy primitive entered. Allocation is one
	// array of length N on the JSON path that previously allocated none,
	// measured against the interleaved shape at 1, 8 and 64 entries and
	// within run noise (bench/micro-wire-batch-alias-ab.mjs, variant F).
	//
	// Re-pinned for the per-entry batch seq. The drift in publishWireBatch's
	// two branches: the snapshot passes also read each entry's `seq`
	// (validating any they find through the shared refusal, and asserting the
	// clustered relay rule once on the first one), an `entrySeqs` array of
	// length N allocated only when an entry actually carries a seq, the
	// stamping loop drawing from that snapshot behind one hoisted boolean,
	// the stateless reroute's per-entry options carrying the seq through to
	// publishWire, and the max-seen record folding per entry (monotone-max
	// for explicit seqs, bare set for counter seqs) when - and only when -
	// explicit seqs are present; the no-seq batch keeps its single bare set.
	// The graph also gains cluster-sequence-policy.js's
	// assertBatchEntrySequenceAuthority (comparisons and a throw) and
	// utils/epoch.js's throwInvalidSeq (cold throw-only helper, named on the
	// ingress seal). Numbers, references and comparisons only - no byte is
	// read, allocated or copied, and no copy primitive entered. The no-seq
	// batch's cost is one property read and one typeof-test per entry in
	// the pre-pass, one boolean test per entry when stamping, and one boolean
	// test per batch at the max-seen fold, measured at 1, 8 and 64 entries
	// over four invocations and within run noise
	// (bench/micro-wire-batch-alias-ab.mjs, variant G vs F).
	//
	// Re-pinned with the review repairs to the same change: the entry
	// predicate keys on typeof number (non-numbers fall through to the shared
	// options, the family spelling) instead of refusing anything defined; the
	// options copy reads its four fields instead of spreading own properties,
	// so an inherited or accessor-carried numeric seq meets the refusal
	// instead of vanishing from the copy; the topic-stats lookup moved to
	// AFTER the serialise loop, so a refused or toJSON-aborted batch no
	// longer creates a stats entry for a topic no frame reached (publish()'s
	// own ordering); and cluster-sequence-policy.js's batch-level refusal
	// throws TypeError, the class every seq-VALUE refusal shares. Field
	// reads, comparisons and a relocated Map lookup - no byte is read,
	// allocated or copied, and no copy primitive entered.
	// Re-pinned for the operator error reference, which this graph reaches
	// through utils/operational-diagnostic.js -> error-registry.js: twenty-seven
	// added frozen entry literals and one module-scope string helper that builds
	// each entry's documented log prefix. The helper runs once at module
	// evaluation to assemble documentation strings; nothing is added to a frame
	// path, no byte is read, allocated or copied, and no copy primitive entered
	// the graph. The existing id lookup is unchanged and no second index was
	// kept - an event-keyed Map was added and then removed as unused.
	//
	// Re-pinned again after correcting operator guidance inside those same
	// frozen literals: cause, consequence, recovery and next-action strings were
	// rewritten where a review found them describing the wrong code path. The
	// digest covers literal CONTENT, so documentation wording moves it even
	// though no statement, call or allocation changed. Nothing here executes on
	// a frame path.
	platform: 'efc04e6d4c3044632a42f6272d52055191930cf293426c3463c1ffc0cca1a302',
	// Re-pinned with the batch one-read rule: deliverStatefulWireBatch takes the
	// payloads the batch already read (`io.datas`) instead of reaching back into
	// the caller's entry objects for `.data`. Same count of encodes and writes,
	// same buffers; the drift is which array the payload comes out of, and no
	// copy primitive entered the body.
	// Re-pinned with the ingress and platform seals above, same drift, same
	// review: the manifest data literals reached through utils.js.
	// Re-pinned again with those seals for the pending-subscribe budget - the
	// same utils/ws-symbols.js counter statements, utils/subscribe-policy.js
	// predicate, and utils/caps.js constant reached through utils.js; nothing
	// in this graph's own modules changed, and no copy primitive entered.
	// Re-pinned again with the other two seals for that budget's review
	// repairs - the derived lane's pre-enrolment check and the predicate's
	// count guard, both in the same shared utils modules. Nothing in this
	// graph's own modules changed, and no copy primitive entered.
	// Re-pinned with the ingress seal for the per-entry batch seq: the only
	// drift in this graph is utils/epoch.js reached through utils.js -
	// throwInvalidSeq, a cold throw-only helper, and stampSeq's numeric
	// refusal arm calling it instead of throwing inline. Nothing in this
	// graph's own modules changed, and no copy primitive entered.
	'wire-fanout': 'e09fda65aa0454213176dd219d7bb67749d324d2865492e9659918fe0b0b2e3d',
	wire: '890a44ffb6b1c17736e103dac82c0569b0cd0c6d8e15f74bf7ed1902b9aebc42'
});
const COPY_AUTHORITY_MODULE_ROOTS = Object.freeze({
	ingress: Object.freeze(['dispatchIngressFrame']),
	platform: Object.freeze(['platform', 'relayPublishWire']),
	'wire-fanout': Object.freeze([
		'send', 'encodeStatelessWirePayload', 'deliverStatelessWireFanout', 'deliverStatefulWireBatch'
	]),
	wire: Object.freeze([
		'FRAME_IO', 'activeFrameIO', 'setBinaryFrameIO', 'resetBinaryFrameIO',
		'ByteReader', 'buildBinaryFrame', 'parseBinaryFrame'
	])
});

function walkAst(node, visit, parent = null) {
	if (!node || typeof node !== 'object') return;
	visit(node, parent);
	for (const [key, value] of Object.entries(node)) {
		if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
		if (Array.isArray(value)) {
			for (const child of value) walkAst(child, visit, node);
		} else if (value && typeof value === 'object' && typeof value.type === 'string') {
			walkAst(value, visit, node);
		}
	}
}

function namedFunction(source, name) {
	const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	const found = [];
	walkAst(ast, (node) => {
		if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
		if (node.type === 'Property' && (node.key?.name ?? node.key?.value) === name &&
			(node.value?.type === 'FunctionExpression' || node.value?.type === 'ArrowFunctionExpression')) {
			found.push(node.value);
		}
	});
	if (found.length !== 1) {
		throw new Error(`I/O budget authority expected one ${name}, found ${found.length}`);
	}
	return found[0];
}

const AST_LOCATION_KEYS = new Set(['start', 'end', 'loc', 'range', 'raw']);

function canonicalAst(node) {
	if (Array.isArray(node)) return node.map(canonicalAst);
	if (typeof node === 'bigint') return { bigint: node.toString() };
	if (!node || typeof node !== 'object') return node;
	const canonical = {};
	for (const key of Object.keys(node).sort()) {
		if (!AST_LOCATION_KEYS.has(key)) canonical[key] = canonicalAst(node[key]);
	}
	return canonical;
}

function functionSyntaxDigest(source, name) {
	return createHash('sha256')
		.update(JSON.stringify(canonicalAst(namedFunction(source, name))))
		.digest('hex');
}

function collectTopLevelPatternNames(pattern, names) {
	if (!pattern) return;
	if (pattern.type === 'Identifier') { names.add(pattern.name); return; }
	if (pattern.type === 'RestElement') { collectTopLevelPatternNames(pattern.argument, names); return; }
	if (pattern.type === 'AssignmentPattern') { collectTopLevelPatternNames(pattern.left, names); return; }
	if (pattern.type === 'ArrayPattern') {
		for (const element of pattern.elements) collectTopLevelPatternNames(element, names);
		return;
	}
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) {
			collectTopLevelPatternNames(property.type === 'RestElement' ? property.argument : property.value, names);
		}
	}
}

function topLevelDeclaredNames(statement) {
	const names = new Set();
	if (statement.type === 'ImportDeclaration') {
		for (const specifier of statement.specifiers) names.add(specifier.local.name);
		return names;
	}
	const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
		? statement.declaration
		: statement;
	if (!declaration) return names;
	if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
		names.add(declaration.id.name);
	} else if (declaration.type === 'VariableDeclaration') {
		for (const item of declaration.declarations) collectTopLevelPatternNames(item.id, names);
	}
	return names;
}

function moduleEvaluationDeclaration(statement) {
	if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
		return statement.declaration;
	}
	return statement;
}

function runsDuringModuleEvaluation(statement) {
	if (statement.type === 'ImportDeclaration' || statement.type === 'ExportAllDeclaration') return true;
	if (statement.type === 'ExportNamedDeclaration' && statement.source) return true;
	const declaration = moduleEvaluationDeclaration(statement);
	if (!declaration) return false;
	if (declaration.type === 'FunctionDeclaration' || declaration.type === 'EmptyStatement') return false;
	if (declaration.type === 'VariableDeclaration') {
		return declaration.declarations.some((item) => item.init != null && !(
			item.id.type === 'Identifier' &&
			(item.init.type === 'FunctionExpression' || item.init.type === 'ArrowFunctionExpression')
		));
	}
	// Class evaluation runs computed keys, static fields, and static blocks. All
	// remaining Program-body statements are executable control flow or
	// expressions, including top-level await.
	return true;
}

function isExternallyReachableExport(statement) {
	return statement.type === 'ExportNamedDeclaration' ||
		statement.type === 'ExportDefaultDeclaration' ||
		statement.type === 'ExportAllDeclaration';
}

function staticStringValue(node) {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
		return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
	}
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		const left = staticStringValue(node.left);
		const right = staticStringValue(node.right);
		return left === null || right === null ? null : left + right;
	}
	return null;
}

function assertNoDynamicStringInvocation(statements, moduleName) {
	for (const statement of statements) {
		walkAst(statement, (node, parent) => {
			if (node.type === 'Identifier' && (node.name === 'eval' || node.name === 'Function')) {
				throw new Error(`${moduleName} module copy authority forbids dynamic string invocation`);
			}
			if (node.type !== 'MemberExpression') return;
			const name = !node.computed && node.property.type === 'Identifier'
				? node.property.name
				: node.computed
					? staticStringValue(node.property)
					: null;
			if (name === 'eval' || name === 'Function') {
				throw new Error(`${moduleName} module copy authority forbids dynamic string invocation`);
			}
			if (node.computed && name === null &&
				node.object.type === 'Identifier' && node.object.name === 'globalThis' &&
				(parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
				parent.callee === node) {
				throw new Error(`${moduleName} module copy authority forbids dynamic string invocation`);
			}
		});
	}
}

function includedModuleBody(ast, roots, moduleLabel) {
	const declared = ast.body.map(topLevelDeclaredNames);
	const declarationsByName = new Map();
	for (let index = 0; index < declared.length; index++) {
		for (const name of declared[index]) {
			const indexes = declarationsByName.get(name) || [];
			indexes.push(index);
			declarationsByName.set(name, indexes);
		}
	}
	const included = new Set(ast.body
		.map((statement, index) => runsDuringModuleEvaluation(statement) || isExternallyReachableExport(statement)
			? index
			: -1)
		.filter((index) => index !== -1));
	for (const root of roots) {
		for (const index of declarationsByName.get(root) || []) included.add(index);
	}

	// Evaluation-time statements, externally callable exports, and explicit
	// byte-owning roots are seeds.
	// Pull in declarations they reference, then repeat through those
	// declarations. Do not pull in statements merely because they consume an
	// included binding: an uncalled function declaration is inert at evaluation.
	let changed = true;
	while (changed) {
		changed = false;
		for (const index of [...included]) {
			walkAst(ast.body[index], (node) => {
				if (node.type !== 'Identifier') return;
				for (const declarationIndex of declarationsByName.get(node.name) || []) {
					if (!included.has(declarationIndex)) {
						included.add(declarationIndex);
						changed = true;
					}
				}
			});
		}
	}
	const body = ast.body.filter((_node, index) => included.has(index));
	assertNoDynamicStringInvocation(body, moduleLabel);
	return body;
}

function localModuleSpecifiers(body) {
	const specifiers = new Set();
	for (const statement of body) {
		walkAst(statement, (node) => {
			let value = null;
			if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
				node.type === 'ExportNamedDeclaration') && node.source) {
				value = staticStringValue(node.source);
			} else if (node.type === 'ImportExpression') {
				value = staticStringValue(node.source);
			}
			if (value?.startsWith('.')) specifiers.add(value);
		});
	}
	return [...specifiers].sort();
}

function moduleGraphSyntaxDigest(source, moduleName, options = {}) {
	const roots = COPY_AUTHORITY_MODULE_ROOTS[moduleName];
	const entryPath = COPY_AUTHORITY_MODULE_PATHS[moduleName];
	if (!roots || !entryPath) throw new Error(`I/O budget authority has no module graph for ${moduleName}`);
	const sourceOverrides = options.sourceOverrides || new Map();
	const modules = [];
	const visited = new Set();

	function visitModule(modulePath, moduleSource, moduleRoots) {
		const resolvedPath = path.resolve(modulePath);
		if (visited.has(resolvedPath)) return;
		visited.add(resolvedPath);
		const ast = acorn.parse(moduleSource, { ecmaVersion: 'latest', sourceType: 'module' });
		const relativePath = path.relative(ROOT, resolvedPath).replaceAll('\\', '/');
		const moduleLabel = resolvedPath === path.resolve(entryPath) ? moduleName : relativePath;
		const body = includedModuleBody(ast, moduleRoots, moduleLabel);
		modules.push({ path: relativePath, program: { type: 'Program', sourceType: ast.sourceType, body } });

		for (const specifier of localModuleSpecifiers(body)) {
			const dependencyPath = path.resolve(path.dirname(resolvedPath), specifier);
			let dependencySource;
			if (sourceOverrides.has(dependencyPath)) {
				dependencySource = sourceOverrides.get(dependencyPath);
			} else {
				try {
					dependencySource = readFileSync(dependencyPath, 'utf8');
				} catch (error) {
					if (error?.code !== 'ENOENT') throw error;
					modules.push({
						path: path.relative(ROOT, dependencyPath).replaceAll('\\', '/'),
						missing: true
					});
					continue;
				}
			}
			visitModule(dependencyPath, dependencySource, []);
		}
	}

	visitModule(entryPath, source, roots);
	modules.sort((left, right) => left.path.localeCompare(right.path));
	const graph = { entry: moduleName, modules };
	return createHash('sha256')
		.update(JSON.stringify(canonicalAst(graph)))
		.digest('hex');
}

function assertClosedCopyModuleSyntax(source, moduleName, options = {}) {
	const expected = COPY_AUTHORITY_MODULE_SYNTAX[moduleName];
	if (!expected) throw new Error(`I/O budget authority has no module seal for ${moduleName}`);
	const actual = moduleGraphSyntaxDigest(source, moduleName, options);
	if (actual !== expected) {
		throw new Error(`${moduleName} module syntax changed outside its counted copy authority: ${actual}`);
	}
}

function assertClosedCopySyntax(source, name) {
	const expected = COPY_AUTHORITY_SYNTAX[name];
	if (!expected) throw new Error(`I/O budget authority has no syntax seal for ${name}`);
	const actual = functionSyntaxDigest(source, name);
	if (actual !== expected) {
		throw new Error(`${name} syntax changed outside its counted copy authority: ${actual}`);
	}
}

function memberName(node) {
	if (!node || node.type !== 'MemberExpression') return null;
	if (!node.computed && node.property.type === 'Identifier') return node.property.name;
	if (node.computed && node.property.type === 'Literal') return String(node.property.value);
	return null;
}

function isMemberCall(node, objectName, propertyName) {
	return node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' && node.callee.object.name === objectName &&
		memberName(node.callee) === propertyName;
}

function assertFrameBuilderAuthority(source, options = {}) {
	const fn = namedFunction(source, 'buildBinaryFrame');
	let allocations = 0;
	let copies = 0;
	walkAst(fn, (node, parent) => {
		if (node.type === 'NewExpression' || node.type === 'SpreadElement' || node.type === 'ForOfStatement') {
			throw new Error(`binary frame builder contains uncounted ${node.type}`);
		}
		if (node.type === 'Identifier' && node.name === 'payload') {
			const isParameter = fn.params.includes(node);
			const isLength = parent?.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'length';
			const isCountedCopy = parent?.type === 'CallExpression' && isMemberCall(parent, 'io', 'copy') && parent.arguments[1] === node;
			if (!isParameter && !isLength && !isCountedCopy) {
				throw new Error('binary frame payload escaped the counted length/copy boundary');
			}
		}
		if (node.type !== 'CallExpression') return;
		if (isMemberCall(node, 'io', 'allocate')) { allocations++; return; }
		if (isMemberCall(node, 'io', 'copy')) { copies++; return; }
		if (isMemberCall(node, 'Math', 'floor')) return;
		if (node.callee.type === 'Identifier' && (node.callee.name === 'lengthOfVarint' || node.callee.name === 'writeVarint')) return;
		throw new Error('binary frame builder contains an uncounted call');
	});
	if (allocations !== 1 || copies !== 1) {
		throw new Error(`binary frame builder must contain one allocation and one copy, got ${allocations}/${copies}`);
	}
	if (!options.allowSyntaxExtensions) assertClosedCopyModuleSyntax(source, 'wire');
}

function containsIdentifier(node, names) {
	let found = false;
	walkAst(node, (child) => {
		if (child.type === 'Identifier' && names.has(child.name)) found = true;
	});
	return found;
}

function staticScalarExpression(node) {
	if (!node) return false;
	if (node.type === 'Literal') return true;
	if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
	if (node.type === 'UnaryExpression') return staticScalarExpression(node.argument);
	if (node.type === 'ArrayExpression') return node.elements.every(staticScalarExpression);
	if (node.type === 'ObjectExpression') {
		return node.properties.every((property) => property.type === 'Property' &&
			property.kind === 'init' && staticScalarExpression(property.value));
	}
	return false;
}

function markScalarShadowIdentifiers(fn, flow) {
	const binaryNames = new Set(flow.names);
	const visit = (node, shadows) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'Identifier' && shadows.has(node.name)) {
			flow.scalarIdentifiers.add(node);
			return;
		}
		let nestedShadows = shadows;
		if (node.type === 'BlockStatement') {
			nestedShadows = new Set(shadows);
			for (const statement of node.body) {
				if (statement.type !== 'VariableDeclaration' || statement.kind === 'var') continue;
				for (const declaration of statement.declarations) {
					if (!staticScalarExpression(declaration.init)) continue;
					const bindings = new Set();
					collectBindingNames(declaration.id, bindings);
					for (const name of bindings) if (binaryNames.has(name)) nestedShadows.add(name);
				}
			}
		}
		for (const [key, value] of Object.entries(node)) {
			if (AST_LOCATION_KEYS.has(key)) continue;
			if (Array.isArray(value)) {
				for (const child of value) visit(child, nestedShadows);
			} else if (value && typeof value === 'object' && typeof value.type === 'string') {
				visit(value, nestedShadows);
			}
		}
	};
	visit(fn.body, new Set());
}

function isFunctionNode(node) {
	return node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' ||
		node?.type === 'ArrowFunctionExpression';
}

function isClassNode(node) {
	return node?.type === 'ClassDeclaration' || node?.type === 'ClassExpression';
}

function propertyName(node) {
	if (!node) return null;
	if (!node.computed && node.key?.type === 'Identifier') return node.key.name;
	if (node.key?.type === 'Literal') return String(node.key.value);
	return null;
}

function addMemberSummary(map, object, property) {
	let properties = map.get(object);
	if (!properties) {
		properties = new Set();
		map.set(object, properties);
	}
	const before = properties.size;
	properties.add(property);
	return properties.size !== before;
}

function memberSummaryHas(map, object, property) {
	const properties = object ? map.get(object) : null;
	return !!properties && (properties.has(property) || properties.has('*'));
}

function memberValue(map, object, property) {
	if (!object) return null;
	const members = map.get(object);
	return members?.get(property) ?? members?.get('*') ?? null;
}

function resolveContainerExpression(node, flow) {
	if (!flow || !node) return null;
	if (node.type === 'ObjectExpression' || isClassNode(node)) return node;
	if (node.type === 'Identifier') {
		return flow.objectBindings.get(node.name) ?? flow.classBindings.get(node.name) ?? null;
	}
	if (node.type === 'MemberExpression') {
		const object = resolveContainerExpression(node.object, flow);
		const value = memberValue(flow.memberValues, object, memberName(node));
		return value?.type === 'ObjectExpression' || isClassNode(value) ? value : null;
	}
	if (node.type === 'NewExpression') return resolveContainerExpression(node.callee, flow);
	return null;
}

function resolveFunctionExpression(node, flow) {
	if (!flow || !node) return null;
	if (isFunctionNode(node)) return node;
	if (node.type === 'Identifier') return flow.functionBindings.get(node.name) ?? null;
	if (node.type === 'MemberExpression') {
		return memberValue(flow.memberFunctions, resolveContainerExpression(node.object, flow), memberName(node));
	}
	return null;
}

function memberFunctionSummaryHas(node, flow, map) {
	if (node?.type !== 'MemberExpression' || !flow) return false;
	return memberSummaryHas(map, resolveContainerExpression(node.object, flow), memberName(node));
}

function callReturnsBinary(node, flow) {
	if (node?.type !== 'CallExpression' || !flow) return false;
	if (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'subarray' &&
		expressionCarriesBinary(node.callee.object, flow) &&
		!node.arguments.some((argument) => expressionCarriesBinary(argument, flow))) return true;
	const fn = resolveFunctionExpression(node.callee, flow);
	if (fn && (flow.returningFunctions.has(fn) || flow.yieldingFunctions.has(fn) ||
		functionReturnsBinary(fn, flow) || functionYieldsBinary(fn, flow))) return true;
	if (memberFunctionSummaryHas(node.callee, flow, flow.returningMethods) ||
		memberFunctionSummaryHas(node.callee, flow, flow.yieldingMethods)) return true;
	return node.callee.type === 'MemberExpression' && memberName(node.callee) === 'next' &&
		expressionCarriesBinary(node.callee.object, flow);
}

function callThrowsBinary(node, flow) {
	if (node?.type !== 'CallExpression' || !flow) return false;
	const fn = resolveFunctionExpression(node.callee, flow);
	if (fn && (flow.throwingFunctions.has(fn) ||
		explicitBinaryThrowEscapes(fn.body, functionScopedFlow(fn, flow)))) return true;
	return memberFunctionSummaryHas(node.callee, flow, flow.throwingMethods);
}

function callCopiesBinary(node, flow) {
	if (node?.type !== 'CallExpression' || !flow) return false;
	const fn = resolveFunctionExpression(node.callee, flow);
	if (fn && (flow.copyingFunctions.has(fn) || functionCopiesBinary(fn, flow))) return true;
	return memberFunctionSummaryHas(node.callee, flow, flow.copyingMethods);
}

function expressionCarriesBinary(node, flowOrNames) {
	if (!node) return false;
	const flow = flowOrNames instanceof Set ? null : flowOrNames;
	const names = flow ? flow.names : flowOrNames;
	if (node.type === 'Identifier') return names.has(node.name) && !flow?.scalarIdentifiers.has(node);
	if (isFunctionNode(node) && flow) {
		return flow.returningFunctions.has(node) || flow.yieldingFunctions.has(node) ||
		functionReturnsBinary(node, flow) || functionYieldsBinary(node, flow);
	}
	if (node.type === 'MemberExpression') {
		if (memberFunctionSummaryHas(node, flow, flow?.returningGetters)) return true;
		const member = memberValue(flow?.memberValues, resolveContainerExpression(node.object, flow), memberName(node));
		if (member && expressionCarriesBinary(member, flowOrNames)) return true;
		const property = memberName(node);
		if (property === 'length' || property === 'byteLength' || property === 'byteOffset') return false;
		return expressionCarriesBinary(node.object, flowOrNames);
	}
	if (node.type === 'CallExpression') {
		return callReturnsBinary(node, flow);
	}
	if (node.type === 'NewExpression') {
		return resolveContainerExpression(node, flow) !== null &&
			(flow.returningGetters.has(resolveContainerExpression(node, flow)) ||
			flow.yieldingMethods.has(resolveContainerExpression(node, flow)));
	}
	if (node.type === 'ArrayExpression') return node.elements.some((item) => expressionCarriesBinary(item, flowOrNames));
	if (node.type === 'ObjectExpression') {
		return node.properties.some((property) => !isFunctionNode(property.value) &&
			expressionCarriesBinary(property.value ?? property.argument, flowOrNames));
	}
	if (node.type === 'ConditionalExpression') {
		return expressionCarriesBinary(node.consequent, flowOrNames) ||
			expressionCarriesBinary(node.alternate, flowOrNames);
	}
	if (node.type === 'LogicalExpression') {
		return expressionCarriesBinary(node.left, flowOrNames) || expressionCarriesBinary(node.right, flowOrNames);
	}
	if (node.type === 'BinaryExpression' || node.type === 'TemplateLiteral') return false;
	if (node.type === 'SequenceExpression') {
		return node.expressions.some((item) => expressionCarriesBinary(item, flowOrNames));
	}
	if (node.type === 'AssignmentExpression') return expressionCarriesBinary(node.right, flowOrNames);
	if (node.type === 'TaggedTemplateExpression') {
		return expressionCarriesBinary(node.tag, flowOrNames) || expressionCarriesBinary(node.quasi, flowOrNames);
	}
	if (node.type === 'AwaitExpression' || node.type === 'ChainExpression') {
		return expressionCarriesBinary(node.argument ?? node.expression, flowOrNames);
	}
	if (node.type === 'YieldExpression') return expressionCarriesBinary(node.argument, flowOrNames);
	return false;
}

function collectBindingNames(pattern, names) {
	if (!pattern) return;
	if (pattern.type === 'Identifier') {
		names.add(pattern.name);
		return;
	}
	if (pattern.type === 'MemberExpression') {
		let root = pattern.object;
		while (root?.type === 'MemberExpression') root = root.object;
		if (root?.type === 'Identifier') names.add(root.name);
		return;
	}
	if (pattern.type === 'RestElement') {
		collectBindingNames(pattern.argument, names);
		return;
	}
	if (pattern.type === 'AssignmentPattern') {
		collectBindingNames(pattern.left, names);
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		for (const element of pattern.elements) collectBindingNames(element, names);
		return;
	}
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) collectBindingNames(property.value ?? property.argument, names);
	}
}

function patternContainsRestElement(pattern) {
	if (!pattern) return false;
	if (pattern.type === 'RestElement') return true;
	if (pattern.type === 'AssignmentPattern') return patternContainsRestElement(pattern.left);
	if (pattern.type === 'ArrayPattern') {
		return pattern.elements.some((element) => patternContainsRestElement(element));
	}
	if (pattern.type === 'Property') return patternContainsRestElement(pattern.value);
	if (pattern.type === 'ObjectPattern') {
		return pattern.properties.some((property) => patternContainsRestElement(property));
	}
	return false;
}

function patternHasBinaryRestDefault(pattern, binaryValues) {
	if (!pattern) return false;
	if (pattern.type === 'AssignmentPattern') {
		if (patternContainsRestElement(pattern.left) && expressionCarriesBinary(pattern.right, binaryValues)) return true;
		return patternHasBinaryRestDefault(pattern.left, binaryValues);
	}
	if (pattern.type === 'RestElement') return patternHasBinaryRestDefault(pattern.argument, binaryValues);
	if (pattern.type === 'Property') return patternHasBinaryRestDefault(pattern.value, binaryValues);
	if (pattern.type === 'ArrayPattern') {
		return pattern.elements.some((element) => patternHasBinaryRestDefault(element, binaryValues));
	}
	if (pattern.type === 'ObjectPattern') {
		return pattern.properties.some((property) => patternHasBinaryRestDefault(property, binaryValues));
	}
	return false;
}

function collectBinaryDefaultBindings(pattern, flow, names) {
	if (!pattern) return;
	if (pattern.type === 'AssignmentPattern') {
		if (expressionCarriesBinary(pattern.right, flow)) collectBindingNames(pattern.left, names);
		collectBinaryDefaultBindings(pattern.left, flow, names);
		return;
	}
	if (pattern.type === 'RestElement') {
		collectBinaryDefaultBindings(pattern.argument, flow, names);
		return;
	}
	if (pattern.type === 'Property') {
		collectBinaryDefaultBindings(pattern.value, flow, names);
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		for (const element of pattern.elements) collectBinaryDefaultBindings(element, flow, names);
		return;
	}
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) collectBinaryDefaultBindings(property, flow, names);
	}
}

function collectBinaryPatternBindings(pattern, source, flow, names) {
	if (!pattern) return;
	if (pattern.type === 'Identifier') {
		if (expressionCarriesBinary(source, flow)) names.add(pattern.name);
		return;
	}
	if (pattern.type === 'AssignmentPattern') {
		collectBinaryPatternBindings(pattern.left, source, flow, names);
		if (expressionCarriesBinary(pattern.right, flow)) collectBindingNames(pattern.left, names);
		return;
	}
	if (pattern.type === 'RestElement') {
		if (expressionCarriesBinary(source, flow)) collectBindingNames(pattern.argument, names);
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		for (let index = 0; index < pattern.elements.length; index++) {
			const element = pattern.elements[index];
			if (!element) continue;
			const value = source?.type === 'ArrayExpression' ? source.elements[index] : null;
			collectBinaryPatternBindings(element, value, flow, names);
		}
		return;
	}
	if (pattern.type !== 'ObjectPattern') return;
	const container = resolveContainerExpression(source, flow);
	for (const property of pattern.properties) {
		if (property.type === 'RestElement') {
			if (expressionCarriesBinary(source, flow)) collectBindingNames(property.argument, names);
			continue;
		}
		const name = propertyName(property);
		const value = memberValue(flow.memberValues, container, name);
		const getterCarries = memberSummaryHas(flow.returningGetters, container, name);
		if (getterCarries) collectBindingNames(property.value, names);
		else collectBinaryPatternBindings(property.value, value, flow, names);
	}
}

function restPatternCopiesBinary(pattern, source, binaryValues) {
	return (patternContainsRestElement(pattern) && expressionCarriesBinary(source, binaryValues)) ||
		patternHasBinaryRestDefault(pattern, binaryValues);
}

function explicitBinaryThrowEscapes(node, flowOrNames) {
	if (!node || typeof node !== 'object') return false;
	if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
		node.type === 'ArrowFunctionExpression' || node.type === 'ClassDeclaration' ||
		node.type === 'ClassExpression') return false;
	if (node.type === 'ThrowStatement') {
		return expressionCarriesBinary(node.argument, flowOrNames);
	}
	if (node.type === 'CallExpression' && callThrowsBinary(node, flowOrNames instanceof Set ? null : flowOrNames)) {
		return true;
	}
	if (node.type === 'MemberExpression' && !(flowOrNames instanceof Set) &&
		memberFunctionSummaryHas(node, flowOrNames, flowOrNames.throwingGetters)) {
		return true;
	}
	if (node.type === 'TryStatement') {
		if (explicitBinaryThrowEscapes(node.finalizer, flowOrNames)) return true;
		if (node.handler) return explicitBinaryThrowEscapes(node.handler.body, flowOrNames);
		return explicitBinaryThrowEscapes(node.block, flowOrNames);
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
		if (Array.isArray(value)) {
			if (value.some((child) => explicitBinaryThrowEscapes(child, flowOrNames))) return true;
		} else if (value && typeof value === 'object' && typeof value.type === 'string' &&
			explicitBinaryThrowEscapes(value, flowOrNames)) {
			return true;
		}
	}
	return false;
}

function functionScopedFlow(fn, flow) {
	const names = new Set(flow.names);
	for (const param of fn.params) {
		const shadowed = new Set();
		collectBindingNames(param, shadowed);
		for (const name of shadowed) names.delete(name);
	}
	const scoped = { ...flow, names };
	for (const param of fn.params) collectBinaryDefaultBindings(param, flow, names);

	let changed = true;
	while (changed) {
		changed = false;
		walkOwnFunctionAst(fn.body, (node) => {
			let pattern = null;
			let value = null;
			if (node.type === 'VariableDeclarator') {
				pattern = node.id;
				value = node.init;
			} else if (node.type === 'AssignmentExpression') {
				pattern = node.left;
				value = node.right;
			} else if (node.type === 'ForOfStatement') {
				pattern = node.left.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left;
				value = node.right;
			}
			if (!pattern) return;
			const bindings = new Set();
			collectBinaryDefaultBindings(pattern, scoped, bindings);
			collectBinaryPatternBindings(pattern, value, scoped, bindings);
			for (const name of bindings) {
				if (names.has(name)) continue;
				names.add(name);
				changed = true;
			}
		});
	}
	return scoped;
}

function walkOwnFunctionAst(node, visit, root = node) {
	if (!node || typeof node !== 'object') return;
	if (node !== root && (isFunctionNode(node) || isClassNode(node))) return;
	visit(node);
	for (const [key, value] of Object.entries(node)) {
		if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
		if (Array.isArray(value)) {
			for (const child of value) walkOwnFunctionAst(child, visit, root);
		} else if (value && typeof value === 'object' && typeof value.type === 'string') {
			walkOwnFunctionAst(value, visit, root);
		}
	}
}

function expressionProducesBinary(node, flow) {
	if (!node) return false;
	if (expressionCarriesBinary(node, flow)) return true;
	if (node.type === 'CallExpression' || node.type === 'NewExpression') {
		return node.arguments.some((argument) => expressionCarriesBinary(argument, flow));
	}
	if (node.type === 'AwaitExpression' || node.type === 'ChainExpression') {
		return expressionProducesBinary(node.argument ?? node.expression, flow);
	}
	if (node.type === 'ConditionalExpression') {
		return expressionProducesBinary(node.consequent, flow) || expressionProducesBinary(node.alternate, flow);
	}
	if (node.type === 'LogicalExpression') {
		return expressionProducesBinary(node.left, flow) || expressionProducesBinary(node.right, flow);
	}
	if (node.type === 'SequenceExpression') {
		return node.expressions.some((expression) => expressionProducesBinary(expression, flow));
	}
	return false;
}

function functionReturnsBinary(fn, flow) {
	const scoped = functionScopedFlow(fn, flow);
	if (fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement') {
		return expressionProducesBinary(fn.body, scoped);
	}
	let found = false;
	const visit = (node) => {
		if (found || !node || typeof node !== 'object') return;
		if (isFunctionNode(node)) return;
		if (node.type === 'ReturnStatement' && expressionProducesBinary(node.argument, scoped)) {
			found = true;
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
			if (Array.isArray(value)) {
				for (const child of value) visit(child);
			} else if (value && typeof value === 'object' && typeof value.type === 'string') {
				visit(value);
			}
		}
	};
	visit(fn.body);
	return found;
}

function functionYieldsBinary(fn, flow) {
	if (!fn.generator) return false;
	const scoped = functionScopedFlow(fn, flow);
	let found = false;
	walkOwnFunctionAst(fn.body, (node) => {
		if (node.type === 'YieldExpression' && expressionProducesBinary(node.argument, scoped)) found = true;
	});
	return found;
}

function functionCopiesBinary(fn, flow) {
	const scoped = functionScopedFlow(fn, flow);
	let found = false;
	walkOwnFunctionAst(fn.body, (node) => {
		if (found) return;
		if (node.type === 'TryStatement' && node.handler?.param &&
			patternContainsRestElement(node.handler.param) && explicitBinaryThrowEscapes(node.block, scoped)) {
			found = true;
			return;
		}
		if (node.type === 'VariableDeclarator' && restPatternCopiesBinary(node.id, node.init, scoped)) {
			found = true;
			return;
		}
		if (node.type === 'AssignmentExpression' && restPatternCopiesBinary(node.left, node.right, scoped)) {
			found = true;
			return;
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, scoped)) {
			found = true;
			return;
		}
		if (node.type === 'TaggedTemplateExpression' && taggedTemplateConsumesBinary(node, scoped)) {
			found = true;
			return;
		}
		if (node.type === 'NewExpression' && node.arguments.some((argument) => expressionCarriesBinary(argument, scoped))) {
			found = true;
			return;
		}
		if (node.type === 'MemberExpression' && memberFunctionSummaryHas(node, scoped, scoped.copyingGetters)) {
			found = true;
			return;
		}
		if (node.type !== 'CallExpression') return;
		if (callCopiesBinary(node, scoped) || node.arguments.some((argument) => expressionCarriesBinary(argument, scoped)) ||
			(node.callee.type === 'MemberExpression' && expressionCarriesBinary(node.callee.object, scoped))) {
			found = true;
		}
	});
	return found;
}

function setMemberValue(map, object, property, value) {
	let members = map.get(object);
	if (!members) {
		members = new Map();
		map.set(object, members);
	}
	if (!members.has(property)) members.set(property, value);
}

function containerMembers(container) {
	if (container.type === 'ObjectExpression') return container.properties;
	return container.body.body;
}

function memberFunction(member) {
	if (member.type === 'Property' || member.type === 'MethodDefinition') {
		return isFunctionNode(member.value) ? member.value : null;
	}
	return null;
}

function indexContainer(container, flow) {
	if (!container || flow.containers.has(container)) return;
	flow.containers.add(container);
	for (const member of containerMembers(container)) {
		if (member.type !== 'Property' && member.type !== 'MethodDefinition' &&
			member.type !== 'PropertyDefinition') continue;
		const name = propertyName(member) ?? '*';
		const fn = memberFunction(member);
		if (fn) setMemberValue(flow.memberFunctions, container, name, fn);
		const value = member.value;
		if (!fn && value) {
			setMemberValue(flow.memberValues, container, name, value);
		}
		if (!fn && (value?.type === 'ObjectExpression' || isClassNode(value))) {
			indexContainer(value, flow);
		}
	}
}

function collectLocalFlowBindings(fn, flow) {
	const assignments = [];
	const destructuredAssignments = [];
	walkAst(fn, (node) => {
		if (node.type === 'FunctionDeclaration' && node.id?.name) {
			flow.functionBindings.set(node.id.name, node);
			return;
		}
		if (node.type === 'ClassDeclaration' && node.id?.name) {
			flow.classBindings.set(node.id.name, node);
			indexContainer(node, flow);
			return;
		}
		if (node.type === 'ObjectExpression' || isClassNode(node)) indexContainer(node, flow);
		if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
			assignments.push([node.id.name, node.init]);
		} else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
			destructuredAssignments.push([node.id, node.init]);
		} else if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
			assignments.push([node.left.name, node.right]);
		} else if (node.type === 'AssignmentExpression' && node.left.type === 'ObjectPattern') {
			destructuredAssignments.push([node.left, node.right]);
		}
	});
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, value] of assignments) {
			const functionValue = resolveFunctionExpression(value, flow);
			if (functionValue && !flow.functionBindings.has(name)) {
				flow.functionBindings.set(name, functionValue);
				changed = true;
			}
			const objectValue = resolveContainerExpression(value, flow);
			if (objectValue && !flow.objectBindings.has(name)) {
				flow.objectBindings.set(name, objectValue);
				changed = true;
			}
			const classValue = isClassNode(value)
				? value
				: value?.type === 'Identifier' ? flow.classBindings.get(value.name) : null;
			if (classValue && !flow.classBindings.has(name)) {
				flow.classBindings.set(name, classValue);
				changed = true;
			}
		}
		for (const [pattern, value] of destructuredAssignments) {
			const container = resolveContainerExpression(value, flow);
			if (!container) continue;
			for (const property of pattern.properties) {
				if (property.type !== 'Property' || property.value.type !== 'Identifier') continue;
				const fnValue = memberValue(flow.memberFunctions, container, propertyName(property));
				if (fnValue && !flow.functionBindings.has(property.value.name)) {
					flow.functionBindings.set(property.value.name, fnValue);
					changed = true;
				}
			}
		}
	}
}

function classifyFunctionProducer(fn, flow) {
	let changed = false;
	if (!flow.returningFunctions.has(fn) && functionReturnsBinary(fn, flow)) {
		flow.returningFunctions.add(fn);
		changed = true;
	}
	if (!flow.yieldingFunctions.has(fn) && functionYieldsBinary(fn, flow)) {
		flow.yieldingFunctions.add(fn);
		changed = true;
	}
	const scoped = functionScopedFlow(fn, flow);
	if (!flow.throwingFunctions.has(fn) && explicitBinaryThrowEscapes(fn.body, scoped)) {
		flow.throwingFunctions.add(fn);
		changed = true;
	}
	if (!flow.copyingFunctions.has(fn) && functionCopiesBinary(fn, flow)) {
		flow.copyingFunctions.add(fn);
		changed = true;
	}
	return changed;
}

function classifyMemberProducer(container, member, flow) {
	const fn = memberFunction(member);
	if (!fn) return false;
	const name = propertyName(member) ?? '*';
	const isGetter = member.kind === 'get';
	let changed = classifyFunctionProducer(fn, flow);
	const returning = isGetter ? flow.returningGetters : flow.returningMethods;
	const yielding = isGetter ? flow.returningGetters : flow.yieldingMethods;
	const throwing = isGetter ? flow.throwingGetters : flow.throwingMethods;
	const copying = isGetter ? flow.copyingGetters : flow.copyingMethods;
	if ((flow.returningFunctions.has(fn) || flow.yieldingFunctions.has(fn))) {
		changed = addMemberSummary(returning, container, name) || changed;
	}
	if (flow.yieldingFunctions.has(fn)) changed = addMemberSummary(yielding, container, name) || changed;
	if (flow.throwingFunctions.has(fn)) changed = addMemberSummary(throwing, container, name) || changed;
	if (flow.copyingFunctions.has(fn)) changed = addMemberSummary(copying, container, name) || changed;
	return changed;
}

function classifyLocalBinaryProducers(flow) {
	let changed = false;
	for (const fn of new Set(flow.functionBindings.values())) {
		changed = classifyFunctionProducer(fn, flow) || changed;
	}
	for (const container of flow.containers) {
		for (const member of containerMembers(container)) {
			changed = classifyMemberProducer(container, member, flow) || changed;
		}
	}
	return changed;
}

function isBinaryRestDestructuring(node, flow, binaryCatchClauses) {
	if (node.type === 'VariableDeclarator') {
		return restPatternCopiesBinary(node.id, node.init, flow);
	}
	if (node.type === 'AssignmentExpression') {
		return restPatternCopiesBinary(node.left, node.right, flow);
	}
	if (node.type === 'ForOfStatement') {
		const patterns = node.left.type === 'VariableDeclaration'
			? node.left.declarations.map((declaration) => declaration.id)
			: [node.left];
		return patterns.some((pattern) => restPatternCopiesBinary(pattern, node.right, flow));
	}
	if (node.type === 'CatchClause') {
		return (binaryCatchClauses.has(node) && patternContainsRestElement(node.param)) ||
			patternHasBinaryRestDefault(node.param, flow);
	}
	return false;
}

function deriveBinaryFlow(fn, binaryValues) {
	const flow = {
		names: binaryValues,
		scalarIdentifiers: new WeakSet(),
		binaryCatchClauses: new Set(),
		functionBindings: new Map(),
		objectBindings: new Map(),
		classBindings: new Map(),
		containers: new Set(),
		memberValues: new WeakMap(),
		memberFunctions: new WeakMap(),
		returningFunctions: new Set(),
		yieldingFunctions: new Set(),
		throwingFunctions: new Set(),
		copyingFunctions: new Set(),
		returningGetters: new WeakMap(),
		throwingGetters: new WeakMap(),
		copyingGetters: new WeakMap(),
		returningMethods: new WeakMap(),
		yieldingMethods: new WeakMap(),
		throwingMethods: new WeakMap(),
		copyingMethods: new WeakMap()
	};
	markScalarShadowIdentifiers(fn, flow);
	collectLocalFlowBindings(fn, flow);
	let changed = true;
	while (changed) {
		changed = classifyLocalBinaryProducers(flow);
		walkAst(fn, (node) => {
			let pattern = null;
			let value = null;
			let catchCarriesBinary = false;
			if (node.type === 'VariableDeclarator') {
				pattern = node.id;
				value = node.init;
			} else if (node.type === 'AssignmentExpression') {
				pattern = node.left;
				value = node.right;
			} else if (node.type === 'ForOfStatement') {
				pattern = node.left.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left;
				value = node.right;
			} else if (node.type === 'TryStatement' && node.handler?.param) {
				pattern = node.handler.param;
				catchCarriesBinary = explicitBinaryThrowEscapes(node.block, flow);
				if (catchCarriesBinary && !flow.binaryCatchClauses.has(node.handler)) {
					flow.binaryCatchClauses.add(node.handler);
					changed = true;
				}
			}
			if (!pattern) return;
			const bindings = new Set();
			collectBinaryDefaultBindings(pattern, flow, bindings);
			if (catchCarriesBinary) collectBindingNames(pattern, bindings);
			else collectBinaryPatternBindings(pattern, value, flow, bindings);
			for (const name of bindings) {
				if (binaryValues.has(name)) continue;
				binaryValues.add(name);
				changed = true;
			}
		});
	}
	return flow;
}

function taggedTemplateConsumesBinary(node, flow) {
	if (node.type !== 'TaggedTemplateExpression') return false;
	if (expressionCarriesBinary(node.tag, flow)) return true;
	return node.quasi.expressions.some((expression) => expressionCarriesBinary(expression, flow));
}

function isZeroCopyViewCall(node, flow) {
	return node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
		memberName(node.callee) === 'subarray' && expressionCarriesBinary(node.callee.object, flow) &&
		!node.arguments.some((argument) => expressionCarriesBinary(argument, flow));
}

function containsDynamicProducer(node) {
	if (node?.type !== 'CallExpression' && node?.type !== 'NewExpression') return false;
	if (containsIdentifier(node.callee, new Set(['eval', 'Function', 'Proxy']))) return true;
	return node.callee.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' && node.callee.object.name === 'Reflect';
}

function isAllowedFanoutCall(node) {
	if (node.callee.type === 'Identifier') return node.callee.name === 'send' || node.callee.name === 'buildFrame';
	if (node.callee.type !== 'MemberExpression') return false;
	const object = node.callee.object;
	const property = memberName(node.callee);
	if (object?.type !== 'Identifier') return false;
	if (object.name === 'ws') return property === 'getUserData';
	if (object.name === 'subscriptions' || object.name === 'caps') return property === 'has';
	if (object.name === 'frames') return property === 'get' || property === 'set';
	if (object.name === 'io') return property === 'isPoisoned' || property === 'ensureId' || property === 'poison';
	return false;
}

function assertSendCopyAuthority(source, options = {}) {
	const fn = namedFunction(source, 'send');
	const flow = deriveBinaryFlow(fn, new Set(['value']));
	walkAst(fn, (node) => {
		if (isBinaryRestDestructuring(node, flow, flow.binaryCatchClauses)) {
			throw new Error('wire-fanout send rest-destructures outbound bytes');
		}
		if (taggedTemplateConsumesBinary(node, flow)) {
			throw new Error('wire-fanout send passes outbound bytes to a tagged-template consumer');
		}
		if (node.type === 'MemberExpression' && expressionCarriesBinary(node.object, flow)) {
			const property = memberName(node);
			if (property !== 'length' && property !== 'byteLength' && property !== 'byteOffset' &&
				property !== 'subarray') {
				throw new Error('wire-fanout send accesses outbound backing storage');
			}
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, flow)) {
			throw new Error('wire-fanout send spreads outbound bytes');
		}
		if (node.type === 'ForOfStatement' && expressionCarriesBinary(node.right, flow)) {
			throw new Error('wire-fanout send iterates outbound bytes');
		}
		if (node.type === 'NewExpression' && node.arguments.some((argument) => expressionCarriesBinary(argument, flow))) {
			throw new Error('wire-fanout send constructs an outbound byte copy');
		}
		if (node.type !== 'CallExpression') return;
		if (containsDynamicProducer(node) || callCopiesBinary(node, flow)) {
			throw new Error('wire-fanout send invokes an uncounted binary producer');
		}
		if (isZeroCopyViewCall(node, flow)) return;
		if (node.callee.type === 'MemberExpression') {
			const object = node.callee.object;
			const property = memberName(node.callee);
			if (object?.type === 'Identifier' && object.name === 'io' && property === 'send') return;
			if (object?.type === 'Identifier' && object.name === 'ws' && property === 'send') return;
		}
		if (node.arguments.some((argument) => expressionCarriesBinary(argument, flow)) ||
			(node.callee.type === 'MemberExpression' && expressionCarriesBinary(node.callee.object, flow))) {
			throw new Error('wire-fanout send passes outbound bytes across an uncounted call boundary');
		}
	});
	if (!options.allowSyntaxExtensions) {
		assertClosedCopySyntax(source, 'send');
		assertClosedCopyModuleSyntax(source, 'wire-fanout');
	}
}

function assertDefaultFrameIOAuthority(source, options = {}) {
	const allocate = namedFunction(source, 'allocate');
	let allocations = 0;
	walkAst(allocate, (node) => {
		if (node.type !== 'NewExpression') return;
		const isDestination = node.callee.type === 'Identifier' && node.callee.name === 'Uint8Array' &&
			node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'length';
		if (!isDestination) throw new Error('default frame allocator contains an uncounted allocation');
		allocations++;
	});
	if (allocations !== 1) {
		throw new Error(`default frame allocator must contain one allocation, got ${allocations}`);
	}

	const copy = namedFunction(source, 'copy');
	const flow = deriveBinaryFlow(copy, new Set(['target', 'source']));
	let bulkCopies = 0;
	walkAst(copy, (node) => {
		if (isBinaryRestDestructuring(node, flow, flow.binaryCatchClauses)) {
			throw new Error('default frame copy rest-destructures frame bytes');
		}
		if (node.type === 'MemberExpression' && expressionCarriesBinary(node.object, flow)) {
			const property = memberName(node);
			if (property !== 'length' && property !== 'byteLength' && property !== 'byteOffset' &&
				property !== 'subarray' && property !== 'set') {
				throw new Error('default frame copy accesses binary backing storage');
			}
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, flow)) {
			throw new Error('default frame copy spreads frame bytes');
		}
		if (node.type === 'ForOfStatement' && expressionCarriesBinary(node.right, flow)) {
			throw new Error('default frame copy iterates frame bytes');
		}
		if (node.type === 'NewExpression' && node.arguments.some((argument) => expressionCarriesBinary(argument, flow))) {
			throw new Error('default frame copy constructs an uncounted binary copy');
		}
		if (node.type !== 'CallExpression') return;
		if (containsDynamicProducer(node) || callCopiesBinary(node, flow)) {
			throw new Error('default frame copy invokes an uncounted binary producer');
		}
		if (isZeroCopyViewCall(node, flow)) return;
		if (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'set' &&
			node.callee.object?.type === 'Identifier' && node.callee.object.name === 'target' &&
			node.arguments.length === 2 && expressionCarriesBinary(node.arguments[0], flow)) {
			bulkCopies++;
			return;
		}
		if (node.arguments.some((argument) => expressionCarriesBinary(argument, flow)) ||
			(node.callee.type === 'MemberExpression' && expressionCarriesBinary(node.callee.object, flow))) {
			throw new Error('default frame copy passes bytes across an uncounted call boundary');
		}
	});
	if (bulkCopies !== 1) {
		throw new Error(`default frame copy must contain one bulk copy, got ${bulkCopies}`);
	}
	if (!options.allowSyntaxExtensions) {
		assertClosedCopySyntax(source, 'allocate');
		assertClosedCopySyntax(source, 'copy');
		assertClosedCopyModuleSyntax(source, 'wire');
	}
}

function assertParseBinaryFrameAuthority(source, options = {}) {
	const fn = namedFunction(source, 'parseBinaryFrame');
	const flow = deriveBinaryFlow(fn, new Set(['bytes']));
	let readers = 0;
	let payloadViews = 0;
	walkAst(fn, (node) => {
		if (isBinaryRestDestructuring(node, flow, flow.binaryCatchClauses)) {
			throw new Error('binary frame parser rest-destructures inbound bytes');
		}
		if (node.type === 'MemberExpression' && expressionCarriesBinary(node.object, flow)) {
			const property = memberName(node);
			const isIndex = property !== null && /^\d+$/.test(property);
			if (!isIndex && property !== 'length' && property !== 'byteLength' && property !== 'byteOffset' &&
				property !== 'subarray') {
				throw new Error('binary frame parser accesses inbound backing storage');
			}
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, flow)) {
			throw new Error('binary frame parser spreads inbound bytes');
		}
		if (node.type === 'ForOfStatement' && expressionCarriesBinary(node.right, flow)) {
			throw new Error('binary frame parser iterates inbound bytes');
		}
		if (node.type === 'NewExpression') {
			const isReader = node.callee.type === 'Identifier' && node.callee.name === 'ByteReader' &&
				node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'bytes';
			if (isReader) { readers++; return; }
			if (node.arguments.some((argument) => expressionCarriesBinary(argument, flow))) {
				throw new Error('binary frame parser constructs an inbound byte copy');
			}
		}
		if (node.type !== 'CallExpression') return;
		if (containsDynamicProducer(node) || callCopiesBinary(node, flow)) {
			throw new Error('binary frame parser invokes an uncounted binary producer');
		}
		if (isZeroCopyViewCall(node, flow)) { payloadViews++; return; }
		if (node.arguments.some((argument) => expressionCarriesBinary(argument, flow)) ||
			(node.callee.type === 'MemberExpression' && expressionCarriesBinary(node.callee.object, flow))) {
			throw new Error('binary frame parser passes bytes across an uncounted call boundary');
		}
	});
	if (readers !== 1 || payloadViews < 1) {
		throw new Error(`binary frame parser must contain one reader and a zero-copy payload view, got ${readers}/${payloadViews}`);
	}
	if (!options.allowSyntaxExtensions) {
		assertClosedCopySyntax(source, 'parseBinaryFrame');
		assertClosedCopyModuleSyntax(source, 'wire');
	}
}

function assertFanoutCopyAuthority(source, functionName, options = {}) {
	const fn = namedFunction(source, functionName);
	const binaryValues = new Set(['payload', 'sharedPayload', 'frame']);
	const flow = deriveBinaryFlow(fn, binaryValues);
	const binaryCatchClauses = flow.binaryCatchClauses;

	const allowedConsumers = new Set(['buildBinaryFrame', 'buildFrame', 'deliverStatelessWireFanout', 'send']);
	walkAst(fn, (node) => {
		if (isBinaryRestDestructuring(node, flow, binaryCatchClauses)) {
			throw new Error(`${functionName} rest-destructures binary bytes outside buildBinaryFrame`);
		}
		if (node.type === 'MemberExpression' && memberFunctionSummaryHas(node, flow, flow.copyingGetters)) {
			throw new Error(`${functionName} invokes a local getter that copies binary bytes`);
		}
		if (taggedTemplateConsumesBinary(node, flow)) {
			throw new Error(`${functionName} passes binary bytes to an uncounted tagged-template consumer`);
		}
		if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && binaryValues.has(node.object.name)) {
			if (memberName(node) !== 'length' && memberName(node) !== 'subarray') {
				throw new Error(`${functionName} accesses binary backing storage outside buildBinaryFrame`);
			}
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, flow)) {
			throw new Error(`${functionName} spreads binary bytes outside buildBinaryFrame`);
		}
		if (node.type === 'NewExpression' && node.arguments.some((arg) => expressionCarriesBinary(arg, flow))) {
			throw new Error(`${functionName} constructs a binary copy outside buildBinaryFrame`);
		}
		if (functionName === 'deliverStatelessWireFanout' && node.type === 'NewExpression') {
			const isFrameMap = node.callee.type === 'Identifier' && node.callee.name === 'Map' && node.arguments.length === 0;
			if (!isFrameMap) throw new Error(`${functionName} contains an unapproved constructor`);
		}
		if ((node.type === 'CallExpression' || node.type === 'NewExpression') && containsDynamicProducer(node)) {
			throw new Error(`${functionName} invokes a dynamic producer outside its copy authority`);
		}
		if (functionName === 'deliverStatelessWireFanout' && node.type === 'CallExpression' &&
			!isZeroCopyViewCall(node, flow) && !isAllowedFanoutCall(node)) {
			throw new Error(`${functionName} contains a call outside its frame-delivery allowlist`);
		}
		if (node.type === 'CallExpression' &&
			(node.callee.type === 'Identifier' && node.callee.name === 'eval' || callCopiesBinary(node, flow))) {
			throw new Error(`${functionName} invokes an uncounted local binary producer`);
		}
		if (node.type !== 'CallExpression' || !node.arguments.some((arg) => expressionCarriesBinary(arg, flow))) return;
		if (node.callee.type === 'Identifier' && allowedConsumers.has(node.callee.name)) return;
		if (node.callee.type === 'MemberExpression') {
			const object = node.callee.object;
			const property = memberName(node.callee);
			if (object?.type === 'Identifier' && object.name === 'ws' && property === 'send') return;
			if (object?.type === 'Identifier' && object.name === 'app' && property === 'publish') return;
			if (object?.type === 'Identifier' && object.name === 'console' && property === 'log') return;
			if (object?.type === 'Identifier' && (object.name === 'frames' || object.name === 'sharedFrameById') && property === 'set') return;
		}
		throw new Error(`${functionName} passes binary bytes to an uncounted consumer`);
	});
	if (!options.allowSyntaxExtensions) {
		assertClosedCopySyntax(source, functionName);
		if (functionName === 'publishWire') {
			assertClosedCopyModuleSyntax(source, 'platform');
		} else if (functionName === 'deliverStatelessWireFanout') {
			assertClosedCopyModuleSyntax(source, 'wire-fanout');
		}
	}
}

function assertIngressCopyAuthority(source, options = {}) {
	if (!options.allowSyntaxExtensions) {
		assertClosedCopySyntax(source, 'dispatchIngressFrame');
		assertClosedCopyModuleSyntax(source, 'ingress');
	}
	const fn = namedFunction(source, 'dispatchIngressFrame');
	const binaryValues = new Set(['message', 'bytes']);
	const flow = deriveBinaryFlow(fn, binaryValues);
	const binaryCatchClauses = flow.binaryCatchClauses;
	let viewConstructors = 0;
	walkAst(fn, (node) => {
		if (isBinaryRestDestructuring(node, flow, binaryCatchClauses)) {
			throw new Error('dispatchIngressFrame rest-destructures inbound bytes');
		}
		if (taggedTemplateConsumesBinary(node, flow)) {
			throw new Error('dispatchIngressFrame passes inbound bytes to an uncounted tagged-template consumer');
		}
		if (node.type === 'MemberExpression' && memberFunctionSummaryHas(node, flow, flow.copyingGetters)) {
			throw new Error('dispatchIngressFrame invokes a local getter that copies inbound bytes');
		}
		if (node.type === 'Identifier' && node.name === 'arguments') {
			throw new Error('dispatchIngressFrame cannot read binary input through arguments');
		}
		if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && binaryValues.has(node.object.name)) {
			if (memberName(node) !== 'subarray') {
				throw new Error('dispatchIngressFrame accesses inbound backing storage outside parseBinaryFrame');
			}
		}
		if (node.type === 'SpreadElement' && expressionCarriesBinary(node.argument, flow)) {
			throw new Error('dispatchIngressFrame spreads inbound bytes');
		}
		if (node.type === 'ForOfStatement' && expressionCarriesBinary(node.right, flow)) {
			throw new Error('dispatchIngressFrame iterates inbound bytes outside parseBinaryFrame');
		}
		if (node.type === 'NewExpression') {
			const isView = node.callee.type === 'Identifier' && node.callee.name === 'Uint8Array' &&
				node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'message';
			if (!isView) throw new Error('dispatchIngressFrame contains an unapproved constructor');
			viewConstructors++;
			return;
		}
		if (node.type !== 'CallExpression') return;
		if (containsDynamicProducer(node)) {
			throw new Error('dispatchIngressFrame invokes a dynamic producer outside its copy authority');
		}
		if ((node.callee.type === 'Identifier' && node.callee.name === 'eval') || callCopiesBinary(node, flow)) {
			throw new Error('dispatchIngressFrame invokes an uncounted local binary producer');
		}
		if (node.callee.type === 'Identifier' && node.callee.name === 'parseBinaryFrame' &&
			node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'bytes') return;
		if (isZeroCopyViewCall(node, flow)) return;
		if (node.callee.type === 'MemberExpression') {
			const object = node.callee.object;
			const property = memberName(node.callee);
			if (object?.type === 'Identifier' && object.name === 'map' && property === 'get') return;
			if (object?.type === 'Identifier' && object.name === 'binding' && (property === 'decode' || property === 'route')) return;
		}
		if (node.arguments.some((argument) => expressionCarriesBinary(argument, flow)) ||
			(node.callee.type === 'MemberExpression' && expressionCarriesBinary(node.callee.object, flow))) {
			throw new Error('dispatchIngressFrame passes inbound bytes across an uncounted call boundary');
		}
	});
	if (viewConstructors !== 1) {
		throw new Error(`dispatchIngressFrame must contain one ArrayBuffer view constructor, got ${viewConstructors}`);
	}
}

describe('deterministic HTTP and frame I/O budgets', () => {
	it('writes each transport error response in one cork and one terminal write', () => {
		for (const send of [send400, send413, send500]) {
			const res = countingResponse();
			send(res);
			expect(res.counts).toEqual({
				cork: 1,
				status: 1,
				header: 1,
				write: 0,
				end: 1,
				writable: 0
			});
		}
	});

	it('6x response bytes do not multiply socket writes or cork sessions', () => {
		const measure = (length) => {
			const res = countingResponse();
			expect(writeChunkWithBackpressure(res, Buffer.alloc(length))).toBe(true);
			return res.counts;
		};
		const small = measure(64);
		const large = measure(64 * 6);
		assertScaleInvariant('HTTP socket writes', small.write, large.write);
		assertScaleInvariant('HTTP cork sessions', small.cork, large.cork);
		expect(small.write).toBe(1);
		expect(small.cork).toBe(1);
	});

	it('outbound frame size does not increase allocation/copy count and inbound parse copies zero bytes', () => {
		const small = countedFrame(32);
		const large = countedFrame(32 * 6);
		assertScaleInvariant('outbound frame allocations', small.allocations, large.allocations);
		assertScaleInvariant('outbound frame bulk copies', small.copies, large.copies);
		expect(small).toEqual({ allocations: 1, copies: 1 });
	});

	it('actual ingress dispatch keeps a zero-copy view for 6x frame bytes', () => {
		const small = countedIngressDispatch(32);
		const large = countedIngressDispatch(32 * 6);
		assertScaleInvariant('ingress decode calls', small.decodes, large.decodes);
		assertScaleInvariant('ingress route calls', small.routes, large.routes);
		expect(small).toEqual({ sliceCopies: 0, decodes: 1, routes: 1 });
		expect(large).toEqual({ sliceCopies: 0, decodes: 1, routes: 1 });
	});

	it('executable local producer probes perform real hidden copies', async () => {
		const bytes = new Uint8Array(64).fill(0x5a);
		const restCopy = executeCatchRestCopy(bytes);
		expect(restCopy).toEqual(Array.from(bytes));
		expect(executeClassCatchRestCopy(bytes)).toEqual(Array.from(bytes));

		const catchClone = executeCatchAliasClone(bytes);
		expect(catchClone).toEqual(bytes);
		expect(catchClone).not.toBe(bytes);
		expect(catchClone.buffer).not.toBe(bytes.buffer);

		const taggedClone = executeTaggedTemplateClone(bytes);
		expect(taggedClone).toEqual(bytes);
		expect(taggedClone).not.toBe(bytes);
		expect(taggedClone.buffer).not.toBe(bytes.buffer);

		for (const hiddenClone of [
			executeCatchDefaultClone(bytes),
			executeLocalThrowClone(bytes),
			executeReturnedTaggedClone(bytes),
			executeGetterTaggedClone(bytes),
			executeGeneratorIterationClone(bytes),
			executeClassGetterClone(bytes),
			executeGeneratorClone(bytes),
			executeDefaultProducerClone(bytes),
			executeNestedGetterClone(bytes),
			executeThunkTaggedClone(bytes),
			await executeAsyncDefaultClone(bytes)
		]) {
			expect(hiddenClone).toEqual(bytes);
			expect(hiddenClone).not.toBe(bytes);
			expect(hiddenClone.buffer).not.toBe(bytes.buffer);
		}
		expect(executeGetterDestructureRestCopy(bytes)).toEqual(Array.from(bytes));
	});

	it('seals the complete reachable byte-owning helper boundary', () => {
		expect(() => assertClosedCopyModuleSyntax(INGRESS_SOURCE, 'ingress')).not.toThrow();
		expect(() => assertClosedCopyModuleSyntax(PLATFORM_SOURCE, 'platform')).not.toThrow();
		expect(() => assertClosedCopyModuleSyntax(FANOUT_SOURCE, 'wire-fanout')).not.toThrow();
		expect(() => assertClosedCopyModuleSyntax(WIRE_SOURCE, 'wire')).not.toThrow();
		for (const [source, name] of [
			[FANOUT_SOURCE, 'send'],
			[FANOUT_SOURCE, 'encodeStatelessWirePayload'],
			[WIRE_SOURCE, 'allocate'],
			[WIRE_SOURCE, 'copy'],
			[WIRE_SOURCE, 'buildBinaryFrame'],
			[WIRE_SOURCE, 'parseBinaryFrame']
		]) {
			expect(() => assertClosedCopySyntax(source, name), name).not.toThrow();
		}
		expect(() => assertSendCopyAuthority(FANOUT_SOURCE)).not.toThrow();
		expect(() => assertDefaultFrameIOAuthority(WIRE_SOURCE)).not.toThrow();
		expect(() => assertFrameBuilderAuthority(WIRE_SOURCE)).not.toThrow();
		expect(() => assertParseBinaryFrameAuthority(WIRE_SOURCE)).not.toThrow();
	});

	it('rejects module-level delegation and the complete ByteReader boundary', () => {
		const sendBindingMarker = '/** Encode the one payload reused by a stateless subscriber walk. */';
		const sendBindingMutant = FANOUT_SOURCE.replace(sendBindingMarker,
			'const baseSend = send;\n' +
			'send = (...args) => {\n' +
			'\tif (args[2] instanceof Uint8Array) structuredClone(args[2]);\n' +
			'\treturn baseSend(...args);\n' +
			'};\n\n' + sendBindingMarker);
		expect(sendBindingMutant).not.toBe(FANOUT_SOURCE);
		expect(functionSyntaxDigest(sendBindingMutant, 'send')).toBe(COPY_AUTHORITY_SYNTAX.send);
		expect(() => assertSendCopyAuthority(sendBindingMutant))
			.toThrow('wire-fanout module syntax changed outside its counted copy authority');

		const activeMarker = 'let activeFrameIO = FRAME_IO;';
		const activeFrameIOMutant = WIRE_SOURCE.replace(activeMarker, activeMarker + '\n' +
			'const nativeFrameIO = activeFrameIO;\n' +
			'const delegatedFrameIO = Object.create(nativeFrameIO);\n' +
			"Object.defineProperty(delegatedFrameIO, 'copy', { value(target, source, offset) {\n" +
			'\tstructuredClone(source);\n' +
			'\treturn nativeFrameIO.copy(target, source, offset);\n' +
			'} });\n' +
			'activeFrameIO = delegatedFrameIO;');
		expect(activeFrameIOMutant).not.toBe(WIRE_SOURCE);
		for (const name of ['allocate', 'copy', 'buildBinaryFrame', 'parseBinaryFrame']) {
			expect(functionSyntaxDigest(activeFrameIOMutant, name), name).toBe(COPY_AUTHORITY_SYNTAX[name]);
		}
		expect(() => assertDefaultFrameIOAuthority(activeFrameIOMutant))
			.toThrow('wire module syntax changed outside its counted copy authority');

		const readerMarker = /constructor\(buf\) \{\r?\n\t\tthis\._buf = buf;/;
		const readerMutant = WIRE_SOURCE.replace(readerMarker,
			'constructor(buf) {\n\t\tstructuredClone(buf);\n\t\tthis._buf = buf;');
		expect(readerMutant).not.toBe(WIRE_SOURCE);
		expect(functionSyntaxDigest(readerMutant, 'parseBinaryFrame'))
			.toBe(COPY_AUTHORITY_SYNTAX.parseBinaryFrame);
		expect(() => assertParseBinaryFrameAuthority(readerMutant))
			.toThrow('wire module syntax changed outside its counted copy authority');

		const source = new Uint8Array(64).fill(0x6a);
		const frame = buildBinaryFrame(3, 1, 0, source);
		expect(frame.byteLength).toBe(68);
		expect(executeDelegatedSendClones(new Array(6).fill(frame)))
			.toEqual({ copies: 6, bytes: 408, writes: 6 });

		const delegatedIOProof = executeDelegatedDefaultFrameIOClone(source);
		expect(delegatedIOProof.counts).toEqual({ copies: 1, bytes: 64 });
		expect(delegatedIOProof.frame).toEqual(frame);

		const readerProof = executeDiscardedByteReaderClone(frame);
		expect(readerProof.counts).toEqual({ copies: 1, bytes: 68 });
		expect(readerProof.hidden).toEqual(frame);
		expect(readerProof.hidden.buffer).not.toBe(frame.buffer);
		expect(readerProof.parsed.payload.buffer).toBe(frame.buffer);
		expect(readerProof.parsed.payload).toEqual(source);
	});

	it('seals module-evaluation statements and their dependencies', () => {
		const baseline = moduleGraphSyntaxDigest(WIRE_SOURCE, 'wire');
		for (const [label, statement] of [
			['side-effect import', `import './module-eval-side-effect.js';`],
			['bound import', `import { value as moduleEvalBinding } from './module-eval-dependency.js';`],
			['re-export with source', `export { value as moduleEvalExport } from './module-eval-dependency.js';`],
			['variable initializer', 'const moduleEvalValue = 1;'],
			['expression statement', 'void 0;'],
			['class evaluation', `class ModuleEvalClass { static [String('key')] = 1; static { void this; } }`],
			['top-level control flow', 'if (false) { void 0; }'],
			['top-level await', 'await Promise.resolve();']
		]) {
			const mutant = `${WIRE_SOURCE}\n${statement}\n`;
			expect(moduleGraphSyntaxDigest(mutant, 'wire'), label).not.toBe(baseline);
			expect(() => assertClosedCopyModuleSyntax(mutant, 'wire'), label).toThrow();
		}

		const dependencySource = WIRE_SOURCE +
			'\nfunction moduleEvalDependency() { return 1; }\n' +
			'const moduleEvalResult = moduleEvalDependency();\n';
		const changedDependency = dependencySource.replace(
			'function moduleEvalDependency() { return 1; }',
			'function moduleEvalDependency() { return 2; }');
		expect(moduleGraphSyntaxDigest(changedDependency, 'wire'))
			.not.toBe(moduleGraphSyntaxDigest(dependencySource, 'wire'));

		for (const [label, declaration] of [
			['function declaration', 'function dormantUnreferencedCopy(bytes) { return structuredClone(bytes); }'],
			['arrow declaration', 'const dormantUnreferencedCopy = (bytes) => structuredClone(bytes);'],
			['function-expression declaration', 'const dormantUnreferencedCopy = function(bytes) { return structuredClone(bytes); };']
		]) {
			const inertSource = `${WIRE_SOURCE}\n${declaration}\n`;
			expect(moduleGraphSyntaxDigest(inertSource, 'wire'), label).toBe(baseline);
			expect(() => assertClosedCopyModuleSyntax(inertSource, 'wire'), label).not.toThrow();
		}

		for (const [label, statements] of [
			['referenced arrow', 'const activeCopy = (bytes) => structuredClone(bytes);\nvoid activeCopy;'],
			['installed arrow', 'const activeCopy = (bytes) => structuredClone(bytes);\nUint8Array.prototype.set = activeCopy;'],
			['exported arrow', 'export const activeCopy = (bytes) => structuredClone(bytes);']
		]) {
			const activeSource = `${WIRE_SOURCE}\n${statements}\n`;
			expect(moduleGraphSyntaxDigest(activeSource, 'wire'), label).not.toBe(baseline);
			expect(() => assertClosedCopyModuleSyntax(activeSource, 'wire'), label).toThrow();
		}

		for (const [label, exportedDeclaration] of [
			['named declaration', 'export function externallyReachableCopy(bytes) { return structuredClone(bytes); }'],
			['export specifier', 'function externallyReachableCopy(bytes) { return structuredClone(bytes); }\nexport { externallyReachableCopy };'],
			['default declaration', 'export default function externallyReachableCopy(bytes) { return structuredClone(bytes); }']
		]) {
			const exportedSource = `${WIRE_SOURCE}\n${exportedDeclaration}\n`;
			expect(moduleGraphSyntaxDigest(exportedSource, 'wire'), label).not.toBe(baseline);
			expect(() => assertClosedCopyModuleSyntax(exportedSource, 'wire'), label).toThrow();
		}
	});

	it('seals an exported function that mutates frame-copy behavior before use', async () => {
		const marker = 'export function allocWireId(ud, slotKey, topic) {';
		const mutant = WIRE_SOURCE.replace(marker, marker + '\n' +
			'\tconst nativeSet = Uint8Array.prototype.set;\n' +
			'\tUint8Array.prototype.set = function(source, offset) {\n' +
			'\t\tglobalThis.__ioBudgetHiddenCopies.push(structuredClone(source));\n' +
			'\t\treturn nativeSet.call(this, source, offset);\n' +
			'\t};');
		expect(mutant).not.toBe(WIRE_SOURCE);
		expect(functionSyntaxDigest(mutant, 'buildBinaryFrame'))
			.toBe(COPY_AUTHORITY_SYNTAX.buildBinaryFrame);
		expect(moduleGraphSyntaxDigest(mutant, 'wire'))
			.not.toBe(moduleGraphSyntaxDigest(WIRE_SOURCE, 'wire'));
		expect(() => assertClosedCopyModuleSyntax(mutant, 'wire'))
			.toThrow('wire module syntax changed outside its counted copy authority');

		const source = new Uint8Array(64).fill(0x6a);
		const proof = await executeExportedPrototypeSetMutation(mutant, source);
		expect(proof.clones).toHaveLength(1);
		expect(proof.clones[0]).toHaveLength(64);
		expect(proof.clones[0]).toEqual(source);
		expect(proof.clones[0].buffer).not.toBe(source.buffer);
		expect(proof.frame).toHaveLength(68);
		expect(proof.parsed?.payload).toEqual(source);
		expect(proof.parsed?.payload.buffer).toBe(proof.frame.buffer);
	});

	it('seals module evaluation in transitive local dependencies', () => {
		const utilsPath = path.join(ROOT, 'src/runtime/utils.js');
		const mutation =
			'const dependencyNativeSet = Uint8Array.prototype.set;\n' +
			'Uint8Array.prototype.set = function(source, offset) {\n' +
			'\tglobalThis.__ioBudgetModuleCopies.push(structuredClone(source));\n' +
			'\treturn dependencyNativeSet.call(this, source, offset);\n' +
			'};';
		const utilsMutant = `${UTILS_SOURCE}\n${mutation}\n`;
		const sourceOverrides = new Map([[utilsPath, utilsMutant]]);
		for (const [source, name] of [
			[FANOUT_SOURCE, 'wire-fanout'],
			[INGRESS_SOURCE, 'ingress'],
			[PLATFORM_SOURCE, 'platform']
		]) {
			expect(moduleGraphSyntaxDigest(source, name, { sourceOverrides }), name)
				.not.toBe(moduleGraphSyntaxDigest(source, name));
			expect(() => assertClosedCopyModuleSyntax(source, name, { sourceOverrides }), name)
				.toThrow(`${name} module syntax changed outside its counted copy authority`);
		}
		const nestedPath = path.join(ROOT, 'src/runtime/utils/ws-symbols.js');
		const nestedMutant = `${readFileSync(nestedPath, 'utf8')}\n${mutation}\n`;
		const nestedOverrides = new Map([[nestedPath, nestedMutant]]);
		expect(moduleGraphSyntaxDigest(FANOUT_SOURCE, 'wire-fanout', {
			sourceOverrides: nestedOverrides
		})).not.toBe(moduleGraphSyntaxDigest(FANOUT_SOURCE, 'wire-fanout'));

		const source = new Uint8Array(64).fill(0x6a);
		const proof = executeModulePrototypeSetMutation(source, mutation);
		expect(proof.clones).toHaveLength(1);
		expect(proof.clones[0]).toHaveLength(64);
		expect(proof.clones[0]).toEqual(source);
		expect(proof.clones[0].buffer).not.toBe(source.buffer);
		expect(proof.frame).toHaveLength(68);
		expect(proof.parsed?.payload).toEqual(source);
		expect(proof.parsed?.payload.buffer).toBe(proof.frame.buffer);
	});

	it('seals platform module mutations outside the unchanged publishWire body', () => {
		const marker = "import { deliverStatefulWireBatch, deliverStatelessWireFanout, encodeStatelessWirePayload } from './wire-fanout.js';";
		const mutation =
			'const nativeSet = Uint8Array.prototype.set;\n' +
			'Uint8Array.prototype.set = function(source, offset) {\n' +
			'\tglobalThis.__ioBudgetModuleCopies.push(structuredClone(source));\n' +
			'\treturn nativeSet.call(this, source, offset);\n' +
			'};';
		const mutant = PLATFORM_SOURCE.replace(marker, `${marker}\n${mutation}`);
		expect(mutant).not.toBe(PLATFORM_SOURCE);
		expect(functionSyntaxDigest(mutant, 'publishWire')).toBe(COPY_AUTHORITY_SYNTAX.publishWire);
		expect(moduleGraphSyntaxDigest(mutant, 'platform'))
			.not.toBe(moduleGraphSyntaxDigest(PLATFORM_SOURCE, 'platform'));
		expect(() => assertFanoutCopyAuthority(mutant, 'publishWire'))
			.toThrow('platform module syntax changed outside its counted copy authority');

		const source = new Uint8Array(64).fill(0x6a);
		const proof = executeModulePrototypeSetMutation(source);
		expect(proof.clones).toHaveLength(1);
		expect(proof.clones[0]).toHaveLength(64);
		expect(proof.clones[0]).toEqual(source);
		expect(proof.clones[0].buffer).not.toBe(source.buffer);
		expect(proof.frame).toHaveLength(68);
		expect(proof.parsed?.payload).toEqual(source);
		expect(proof.parsed?.payload.buffer).toBe(proof.frame.buffer);
	});

	it('seals ingress module mutations outside the unchanged dispatch body', () => {
		const marker = "} from '../utils.js';";
		const mutation =
			'const nativeSubarray = Uint8Array.prototype.subarray;\n' +
			'Uint8Array.prototype.subarray = function(start, end) {\n' +
			'\tglobalThis.__ioBudgetIngressModuleCopies.push(structuredClone(new DataView(this.buffer, this.byteOffset, this.byteLength)));\n' +
			'\treturn nativeSubarray.call(this, start, end);\n' +
			'};';
		const mutant = INGRESS_SOURCE.replace(marker, `${marker}\n${mutation}`);
		expect(mutant).not.toBe(INGRESS_SOURCE);
		expect(functionSyntaxDigest(mutant, 'dispatchIngressFrame'))
			.toBe(COPY_AUTHORITY_SYNTAX.dispatchIngressFrame);
		expect(moduleGraphSyntaxDigest(mutant, 'ingress'))
			.not.toBe(moduleGraphSyntaxDigest(INGRESS_SOURCE, 'ingress'));
		expect(() => assertIngressCopyAuthority(mutant))
			.toThrow('ingress module syntax changed outside its counted copy authority');

		const source = new Uint8Array(64).fill(0x6a);
		const frame = buildBinaryFrame(3, 300, 0, source);
		const proof = executeIngressModulePrototypeSubarrayMutation(frame);
		expect(proof.clones).toHaveLength(1);
		expect(proof.clones[0].byteLength).toBe(frame.byteLength);
		expect(proof.clones[0].buffer).not.toBe(frame.buffer);
		expect(proof.decodedPayload).toEqual(source);
		expect(proof.decodedPayload?.buffer).toBe(frame.buffer);
	});

	it('forbids dynamic string invocation from the included module graph', () => {
		for (const [label, declaration] of [
			['eval', "export function invokeHiddenCopy() { return eval('dormantUnreferencedCopy()'); }"],
			['Function', "export function invokeHiddenCopy() { return Function('return dormantUnreferencedCopy()')(); }"],
			['global eval', "export function invokeHiddenCopy() { return globalThis['eval']('dormantUnreferencedCopy()'); }"],
			['computed global eval', "export function invokeHiddenCopy() { return globalThis['ev' + 'al']('dormantUnreferencedCopy()'); }"],
			['computed global Function', "export function invokeHiddenCopy() { return globalThis['Fun' + 'ction']('return dormantUnreferencedCopy()')(); }"],
			['unresolved global member', "export function invokeHiddenCopy(key) { return globalThis[key]('dormantUnreferencedCopy()'); }"]
		]) {
			const mutant = WIRE_SOURCE +
				'\nfunction dormantUnreferencedCopy() { return 1; }\n' + declaration + '\n';
			expect(() => moduleGraphSyntaxDigest(mutant, 'wire'), label)
				.toThrow('wire module copy authority forbids dynamic string invocation');
		}
	});

	it('rejects eval and built-in prototype delegation at module evaluation', () => {
		const sendMarker = 'const SEND_THROWN = 3;';
		const evalSendMutant = FANOUT_SOURCE.replace(sendMarker, sendMarker + '\n' +
			`eval('send = ((baseSend) => (io, ws, value, binary) => { if (value instanceof Uint8Array) structuredClone(value); return baseSend(io, ws, value, binary); })(send)');`);
		expect(evalSendMutant).not.toBe(FANOUT_SOURCE);
		for (const name of ['send', 'encodeStatelessWirePayload']) {
			expect(functionSyntaxDigest(evalSendMutant, name), name).toBe(COPY_AUTHORITY_SYNTAX[name]);
		}
		expect(() => assertClosedCopyModuleSyntax(evalSendMutant, 'wire-fanout'))
			.toThrow('wire-fanout module copy authority forbids dynamic string invocation');

		const activeMarker = 'let activeFrameIO = FRAME_IO;';
		const setMutant = WIRE_SOURCE.replace(activeMarker, activeMarker + '\n' +
			'Uint8Array.prototype.set = ((baseSet) => function(source, offset) { structuredClone(source); return baseSet.call(this, source, offset); })(Uint8Array.prototype.set);');
		expect(setMutant).not.toBe(WIRE_SOURCE);
		expect(functionSyntaxDigest(setMutant, 'copy')).toBe(COPY_AUTHORITY_SYNTAX.copy);
		expect(() => assertClosedCopyModuleSyntax(setMutant, 'wire'))
			.toThrow('wire module syntax changed outside its counted copy authority');

		const subarrayMutant = WIRE_SOURCE.replace(activeMarker, activeMarker + '\n' +
			'Uint8Array.prototype.subarray = ((baseSubarray) => function(start, end) { structuredClone(new DataView(this.buffer, this.byteOffset, this.byteLength)); return baseSubarray.call(this, start, end); })(Uint8Array.prototype.subarray);');
		expect(subarrayMutant).not.toBe(WIRE_SOURCE);
		expect(functionSyntaxDigest(subarrayMutant, 'parseBinaryFrame'))
			.toBe(COPY_AUTHORITY_SYNTAX.parseBinaryFrame);
		expect(() => assertClosedCopyModuleSyntax(subarrayMutant, 'wire'))
			.toThrow('wire module syntax changed outside its counted copy authority');

		const source = new Uint8Array(64).fill(0x6a);
		const frame = buildBinaryFrame(3, 1, 0, source);
		expect(executeEvalSendRebindClones(new Array(6).fill(frame)))
			.toEqual({ copies: 6, bytes: 408, writes: 6 });

		const setProof = executePrototypeSetDelegation(source);
		expect(setProof.counts).toEqual({ copies: 1, bytes: 64 });
		expect(setProof.frame).toEqual(frame);

		const ingressProof = executePrototypeSubarrayDataViewDelegation(frame);
		expect(ingressProof.counts).toEqual({ copies: 1, bytes: 68 });
		expect(ingressProof.clones).toHaveLength(1);
		expect(Object.prototype.toString.call(ingressProof.clones[0])).toBe('[object DataView]');
		expect(ingressProof.clones[0].byteLength).toBe(68);
		expect(ingressProof.clones[0].buffer).not.toBe(frame.buffer);
		expect(ingressProof.parsed.payload.buffer).toBe(frame.buffer);
		expect(ingressProof.parsed.payload).toEqual(source);
	});

	it('rejects discarded copies in send, default frame I/O, and parsing', () => {
		const sendMarker = 'function send(io, ws, value, binary) {\n';
		const sendMutant = FANOUT_SOURCE.replace(sendMarker,
			sendMarker + '\tif (value instanceof Uint8Array) structuredClone(value);\n');
		expect(sendMutant).not.toBe(FANOUT_SOURCE);
		expect(() => assertSendCopyAuthority(sendMutant)).toThrow();
		expect(() => assertSendCopyAuthority(sendMutant, { allowSyntaxExtensions: true }))
			.toThrow('wire-fanout send passes outbound bytes across an uncounted call boundary');

		const copyMarker = 'copy: (target, source, offset) => target.set(source, offset)';
		const copyMutant = WIRE_SOURCE.replace(copyMarker,
			'copy: (target, source, offset) => { structuredClone(source); target.set(source, offset); }');
		expect(copyMutant).not.toBe(WIRE_SOURCE);
		expect(() => assertDefaultFrameIOAuthority(copyMutant)).toThrow();
		expect(() => assertDefaultFrameIOAuthority(copyMutant, { allowSyntaxExtensions: true }))
			.toThrow('default frame copy passes bytes across an uncounted call boundary');

		const parseMarker = 'export function parseBinaryFrame(bytes) {';
		const parseMutant = WIRE_SOURCE.replace(parseMarker,
			parseMarker + '\n\tstructuredClone(bytes);');
		expect(parseMutant).not.toBe(WIRE_SOURCE);
		expect(() => assertParseBinaryFrameAuthority(parseMutant)).toThrow();
		expect(() => assertParseBinaryFrameAuthority(parseMutant, { allowSyntaxExtensions: true }))
			.toThrow('binary frame parser passes bytes across an uncounted call boundary');

		const source = new Uint8Array(64).fill(0x6a);
		const sendProof = executeDiscardedSendClones(new Array(6).fill(source));
		expect(sendProof.counts).toEqual({ copies: 6, bytes: 384 });
		expect(new Set(sendProof.clones.map((clone) => clone.buffer)).size).toBe(6);
		for (const clone of sendProof.clones) {
			expect(clone).toEqual(source);
			expect(clone.buffer).not.toBe(source.buffer);
		}

		const copyProof = executeDiscardedDefaultCopyClone(source);
		expect(copyProof.counts).toEqual({ copies: 1, bytes: 64 });
		expect(copyProof.hidden).toEqual(source);
		expect(copyProof.hidden.buffer).not.toBe(source.buffer);
		expect(copyProof.target).toEqual(source);

		const frame = buildBinaryFrame(3, 1, 0, source);
		expect(frame.byteLength).toBe(68);
		const parseProof = executeDiscardedParseClone(frame);
		expect(parseProof.counts).toEqual({ copies: 1, bytes: 68 });
		expect(parseProof.hidden).toEqual(frame);
		expect(parseProof.hidden.buffer).not.toBe(frame.buffer);
		expect(parseProof.parsed?.payload.buffer).toBe(frame.buffer);
	});

	it('permits scalar work and zero-copy views at the helper boundaries', () => {
		const unrelatedWireClean = WIRE_SOURCE +
			'\nfunction dormantScalarWork() { const scalar = 1; return structuredClone(scalar); }\n';
		expect(() => assertClosedCopyModuleSyntax(unrelatedWireClean, 'wire')).not.toThrow();

		const sendMarker = 'function send(io, ws, value, binary) {\n';
		const sendClean = FANOUT_SOURCE.replace(sendMarker, sendMarker +
			'\t{ const scalar = 1; structuredClone(scalar); }\n' +
			'\tconst outboundView = value instanceof Uint8Array ? value.subarray(0).subarray(0) : value; void outboundView;\n');
		expect(() => assertSendCopyAuthority(sendClean, { allowSyntaxExtensions: true })).not.toThrow();

		const copyMarker = 'copy: (target, source, offset) => target.set(source, offset)';
		const copyClean = WIRE_SOURCE.replace(copyMarker,
			'copy: (target, source, offset) => { { const scalar = 1; structuredClone(scalar); } ' +
			'const sourceView = source.subarray(0).subarray(0); void sourceView; target.set(source, offset); }');
		expect(() => assertDefaultFrameIOAuthority(copyClean, { allowSyntaxExtensions: true })).not.toThrow();

		const parseMarker = 'export function parseBinaryFrame(bytes) {';
		const parseClean = WIRE_SOURCE.replace(parseMarker, parseMarker +
			'\n\t{ const scalar = 1; structuredClone(scalar); }\n' +
			'\tconst wholeFrameView = bytes.subarray(0).subarray(0); void wholeFrameView;\n');
		expect(() => assertParseBinaryFrameAuthority(parseClean, { allowSyntaxExtensions: true })).not.toThrow();
	});

	it('structurally permits only the counted frame allocation and payload copy', () => {
		expect(() => assertFrameBuilderAuthority(WIRE_SOURCE)).not.toThrow();
		const marker = '\tconst headerLength = 2 + lengthOfVarint(topicId) + lengthOfVarint(seq);';
		for (const bypass of [
			'payload.slice();',
			'payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);',
			'new DataView(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));',
			'new Uint8Array(payload);',
			'Uint8Array.from(payload);',
			'Buffer.from(payload);',
			'Array.from(payload);',
			'structuredClone(payload);',
			'for (let i = 0; i < payload.length; i++) frame[i] = payload[i];'
		]) {
			const mutant = WIRE_SOURCE.replace(marker, `\t${bypass}\n${marker}`);
			expect(mutant).not.toBe(WIRE_SOURCE);
			expect(() => assertFrameBuilderAuthority(mutant), bypass).toThrow();
		}
	});

	it('forbids binary backing-buffer copies around the shared fan-out core', () => {
		expect(() => assertFanoutCopyAuthority(PLATFORM_SOURCE, 'publishWire')).not.toThrow();
		expect(() => assertFanoutCopyAuthority(FANOUT_SOURCE, 'deliverStatelessWireFanout')).not.toThrow();
		const decoy = `${PLATFORM_SOURCE}\nconst copyAuthorityDecoy = { publishWire() { return false; } };\n`;
		expect(() => assertFanoutCopyAuthority(decoy, 'publishWire'))
			.toThrow('I/O budget authority expected one publishWire, found 2');
		const marker = '\t\tconst payload = encodeStatelessWirePayload(wire, event, data);';
		for (const bypass of [
			'payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);',
			'new DataView(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));',
			'new Uint8Array(payload);',
			'Uint8Array.from(payload);',
			'Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);',
			'structuredClone(payload);',
			'const payloadCopy = payload; payloadCopy.slice();',
			'let copiedPayload; copiedPayload = payload; structuredClone(copiedPayload);',
			'const payloadBox = { value: payload }; structuredClone(payloadBox.value);',
			'let payloadBox = {}; payloadBox.value = payload; structuredClone(payloadBox.value);',
			'const [copiedPayload] = [payload]; structuredClone(copiedPayload);',
			'try { throw payload; } catch ([...copiedPayload]) {}',
			'try { throw payload; } catch (alias) { structuredClone(alias); }',
			'try { throw { value: payload }; } catch ({ value: alias }) { structuredClone(alias); }',
			'try { try { throw payload; } catch (alias) { throw alias; } } catch ([...copiedPayload]) {}',
			'try { throw {}; } catch ({ missing: alias = payload }) { structuredClone(alias); }',
			'function throwPayload() { throw payload; } try { throwPayload(); } catch (alias) { structuredClone(alias); }',
			'function getPayload() { return payload; } hiddenByteCloneTag`${getPayload()}`;',
			'const box = { get value() { return payload; } }; hiddenByteCloneTag`${box.value}`;',
			'class ByteBox { static get value() { return payload; } } try { throw ByteBox.value; } catch ([...copy]) {}',
			'class ByteBox { static get value() { return payload; } } structuredClone(ByteBox.value);',
			'function* payloads() { yield payload; } structuredClone(payloads().next().value);',
			'function getPayload(value = payload) { return value; } structuredClone(getPayload());',
			'const box = { nested: { get value() { return payload; } } }; structuredClone(box.nested.value);',
			'hiddenThunkCloneTag`${() => payload}`;',
			'async function clonePayload(value = payload) { return structuredClone(value); } clonePayload();',
			'function* payloads() { yield payload; } for (const hidden of payloads()) structuredClone(hidden);',
			'class ByteBox { clone() { return structuredClone(payload); } } const box = new ByteBox(); const clone = box.clone; clone.call(box);',
			"const key = 'value'; const box = { get [key]() { return payload; } }; const { [key]: hidden } = box; structuredClone(hidden);",
			'const box = { clone() { return structuredClone(payload); } }; const { clone } = box; clone();',
			'const { value: hidden } = (() => ({ value: payload }))(); structuredClone(hidden);',
			'(async () => { const { value: hidden } = await Promise.resolve({ value: payload }); return structuredClone(hidden); })();',
			'const holder = { nested: { get value() { return payload; } } }; const nested = holder.nested; const { value: hidden } = nested; structuredClone(hidden);',
			'const box = new Proxy({}, { get() { return payload; } }); structuredClone(box.value);',
			"(0, eval)('(bytes) => structuredClone(bytes)')(payload);",
			'const { value: hidden } = (() => ({ value: payload }))(); hiddenByteCloneTag`${hidden}`;'
		]) {
			const mutant = (EXTERNAL_CLONE_TAG + EXTERNAL_THUNK_CLONE_TAG + PLATFORM_SOURCE)
				.replace(marker, `${marker}\n\t\t${bypass}`);
			expect(mutant).not.toBe(PLATFORM_SOURCE);
			expect(() => assertFanoutCopyAuthority(mutant, 'publishWire'), bypass).toThrow();
		}
		const generatorIterationMutant = (EXTERNAL_CLONE_TAG + PLATFORM_SOURCE).replace(marker,
			`${marker}\n\t\tfunction* payloads() { yield payload; } for (const hidden of payloads()) structuredClone(hidden);`);
		expect(() => assertFanoutCopyAuthority(generatorIterationMutant, 'publishWire',
			{ allowSyntaxExtensions: true })).toThrow();
		const taggedPlatformMutant = (EXTERNAL_CLONE_TAG + PLATFORM_SOURCE)
			.replace(marker, `${marker}\n\t\thiddenByteCloneTag\`${'${payload}'}\`;`);
		expect(() => assertFanoutCopyAuthority(taggedPlatformMutant, 'publishWire')).toThrow();

		const deliveryMarker = '\t\tif (send(io, ws, frame, true) !== SEND_THROWN) delivered = true;';
		for (const bypass of [
			'let copiedPayload; copiedPayload = payload; structuredClone(copiedPayload);',
			'const payloadBox = { value: payload }; structuredClone(payloadBox.value);',
			'let payloadBox = {}; payloadBox.value = payload; structuredClone(payloadBox.value);',
			'const [copiedPayload] = [payload]; structuredClone(copiedPayload);',
			'const [...subscriberCopy] = frame;',
			'const [firstByte, ...subscriberTail] = frame;',
			'const { ...subscriberCopy } = frame;',
			'let subscriberCopy; [...subscriberCopy] = frame;',
			'let subscriberCopy; ({ ...subscriberCopy } = frame);',
			'const frameAlias = frame; const [...subscriberCopy] = frameAlias;',
			'const box = { get value() { return frame; } }; const { value: hiddenFrame } = box; const [...subscriberCopy] = hiddenFrame;',
			'const [...subscriberCopy] = true ? frame : [];',
			'const [ignored, { ...subscriberCopy }] = [null, frame];',
			'const { missing: [...subscriberCopy] = frame } = {};',
			'const { missing: { ...subscriberCopy } = frame } = {};',
			'for (const [...subscriberCopy] of [frame]) break;',
			'for (const { ...subscriberCopy } of [frame]) break;',
			'try { throw frame; } catch ([...subscriberCopy]) {}',
			'try { throw frame; } catch ({ ...subscriberCopy }) {}',
			'try { throw frame; } catch (alias) { structuredClone(alias); }',
			'try { throw { value: frame }; } catch ({ value: alias }) { structuredClone(alias); }',
			'try { try { throw frame; } catch (alias) { throw alias; } } catch ([...subscriberCopy]) {}',
			"eval('structuredClone(payload)');"
		]) {
			const mutant = FANOUT_SOURCE.replace(deliveryMarker, `\t\t${bypass}\n${deliveryMarker}`);
			expect(mutant).not.toBe(FANOUT_SOURCE);
			expect(() => assertFanoutCopyAuthority(mutant, 'deliverStatelessWireFanout'), bypass).toThrow();
		}
		const getterBindingMutant = FANOUT_SOURCE.replace(deliveryMarker,
			'\t\tconst box = { get value() { return frame; } }; const { value: hiddenFrame } = box; const [...subscriberCopy] = hiddenFrame;\n' + deliveryMarker);
		expect(() => assertFanoutCopyAuthority(getterBindingMutant, 'deliverStatelessWireFanout',
			{ allowSyntaxExtensions: true })).toThrow();
		const taggedFanoutMutant = (EXTERNAL_CLONE_TAG + FANOUT_SOURCE)
			.replace(deliveryMarker, `\t\thiddenByteCloneTag\`${'${frame}'}\`;\n${deliveryMarker}`);
		expect(() => assertFanoutCopyAuthority(taggedFanoutMutant, 'deliverStatelessWireFanout')).toThrow();
	});

	it('forbids whole-frame copies in the production ingress entrypoint', () => {
		expect(() => assertIngressCopyAuthority(INGRESS_SOURCE)).not.toThrow();
		const marker = '\tconst bytes = message instanceof Uint8Array ? message : new Uint8Array(message);';
		for (const bypass of [
			'message.slice();',
			'message.buffer.slice(0);',
			'new Uint8Array(message);',
			'structuredClone(message);',
			'let copiedMessage; copiedMessage = message; structuredClone(copiedMessage);',
			'const messageBox = { value: message }; structuredClone(messageBox.value);',
			'let messageBox = {}; messageBox.value = message; structuredClone(messageBox.value);',
			'const [copiedMessage] = [message]; structuredClone(copiedMessage);',
			'const [...wholeFrameCopy] = message;',
			'const [firstByte, ...wholeFrameTail] = message;',
			'const { ...wholeFrameCopy } = message;',
			'let wholeFrameCopy; [...wholeFrameCopy] = message;',
			'let wholeFrameCopy; ({ ...wholeFrameCopy } = message);',
			'const messageAlias = message; const [...wholeFrameCopy] = messageAlias;',
			'const box = { get value() { return message; } }; const { value: hiddenMessage } = box; const [...wholeFrameCopy] = hiddenMessage;',
			'const [...wholeFrameCopy] = true ? message : [];',
			'const [ignored, { ...wholeFrameCopy }] = [null, message];',
			'const { missing: [...wholeFrameCopy] = message } = {};',
			'const { missing: { ...wholeFrameCopy } = message } = {};',
			'for (const [...wholeFrameCopy] of [message]) break;',
			'for (const { ...wholeFrameCopy } of [message]) break;',
			'try { throw message; } catch ([...wholeFrameCopy]) {}',
			'try { throw message; } catch ({ ...wholeFrameCopy }) {}',
			'try { throw message; } catch (alias) { structuredClone(alias); }',
			'try { throw { value: message }; } catch ({ value: alias }) { structuredClone(alias); }',
			'try { try { throw message; } catch (alias) { throw alias; } } catch ([...wholeFrameCopy]) {}',
			'class ByteBox { static get value() { return message; } } try { throw ByteBox.value; } catch ([...copy]) {}',
			'class ByteBox { static get value() { return message; } } structuredClone(ByteBox.value);',
			'function* messages() { yield message; } structuredClone(messages().next().value);',
			'function getMessage(value = message) { return value; } structuredClone(getMessage());',
			'const box = { nested: { get value() { return message; } } }; structuredClone(box.nested.value);',
			'hiddenThunkCloneTag`${() => message}`;',
			'async function cloneMessage(value = message) { return structuredClone(value); } cloneMessage();'
		]) {
			const mutant = (EXTERNAL_THUNK_CLONE_TAG + INGRESS_SOURCE).replace(marker, `\t${bypass}\n${marker}`);
			expect(mutant).not.toBe(INGRESS_SOURCE);
			expect(() => assertIngressCopyAuthority(mutant), bypass).toThrow();
		}
		const getterBindingMutant = INGRESS_SOURCE.replace(marker,
			'\tconst box = { get value() { return message; } }; const { value: hiddenMessage } = box; const [...wholeFrameCopy] = hiddenMessage;\n' + marker);
		expect(() => assertIngressCopyAuthority(getterBindingMutant,
			{ allowSyntaxExtensions: true })).toThrow();
		const taggedIngressMutant = (EXTERNAL_CLONE_TAG + INGRESS_SOURCE)
			.replace(marker, `\thiddenByteCloneTag\`${'${message}'}\`;\n${marker}`);
		expect(() => assertIngressCopyAuthority(taggedIngressMutant)).toThrow();
	});

	it('allows caught non-binary values, suppressed throws, and constant tags', () => {
		const platformMarker = '\t\tconst payload = encodeStatelessWirePayload(wire, event, data);';
		const platformClean = (EXTERNAL_CLONE_TAG + EXTERNAL_THUNK_CLONE_TAG + PLATFORM_SOURCE).replace(platformMarker,
			platformMarker + '\n' +
			'\t\t{ const payload = 1; structuredClone(payload); }\n' +
			'\t\tconst payloadView = payload.subarray(0); void payloadView;\n' +
			'\t\ttry { throw {}; } catch ({ missing: alias = 1 }) { structuredClone(alias); }\n' +
			'\t\tfunction throwUnrelated() { throw { ok: true }; }\n' +
			'\t\ttry { throwUnrelated(); } catch (alias) { structuredClone(alias); }\n' +
			'\t\tfunction getConstant() { return 1; }\n' +
			'\t\thiddenByteCloneTag`${getConstant()}`;\n' +
			'\t\tconst box = { get value() { return 1; } };\n' +
			'\t\thiddenByteCloneTag`${box.value}`;\n' +
			'\t\tfunction hasPayload() { return payload !== null; }\n' +
			'\t\thiddenByteCloneTag`${hasPayload()}`;\n' +
			'\t\tfunction stringifyPayload() { return `${payload}`; }\n' +
			'\t\thiddenByteCloneTag`${stringifyPayload()}`;\n' +
			'\t\tclass ConstantBox { static get value() { return [1]; } }\n' +
			'\t\ttry { throw ConstantBox.value; } catch ([...constantCopy]) { void constantCopy; }\n' +
			'\t\tstructuredClone(ConstantBox.value);\n' +
			'\t\tfunction* constants() { yield 1; }\n' +
			'\t\tstructuredClone(constants().next().value);\n' +
			'\t\tfunction getDefault(value = 1) { return value; }\n' +
			'\t\tstructuredClone(getDefault());\n' +
			'\t\tconst constantBox = { nested: { get value() { return 1; } } };\n' +
			'\t\tstructuredClone(constantBox.nested.value);\n' +
			'\t\thiddenThunkCloneTag`${() => 1}`;\n' +
			'\t\tasync function cloneDefault(value = 1) { return structuredClone(value); }\n' +
			'\t\tcloneDefault();');
		expect(() => assertFanoutCopyAuthority(platformClean, 'publishWire',
			{ allowSyntaxExtensions: true })).not.toThrow();

		const fanoutMarker = '\t\tif (send(io, ws, frame, true) !== SEND_THROWN) delivered = true;';
		const fanoutClean = (EXTERNAL_CLONE_TAG + FANOUT_SOURCE).replace(fanoutMarker,
			'\t\t{ const payload = 1; const [...scalarCopy] = [payload]; void scalarCopy; }\n' +
			'\t\tconst frameView = frame.subarray(0); void frameView;\n' +
			'\t\ttry { throw [1]; } catch ([...unrelated]) { void unrelated; }\n' +
			'\t\ttry { try { throw frame; } catch {} } catch ([...unreachable]) {}\n' +
			'\t\thiddenByteCloneTag`constant`;\n' + fanoutMarker);
		expect(() => assertFanoutCopyAuthority(fanoutClean, 'deliverStatelessWireFanout',
			{ allowSyntaxExtensions: true })).not.toThrow();

		const ingressMarker = '\tconst bytes = message instanceof Uint8Array ? message : new Uint8Array(message);';
		const ingressClean = (EXTERNAL_CLONE_TAG + EXTERNAL_THUNK_CLONE_TAG + INGRESS_SOURCE).replace(ingressMarker,
			'\t{ const message = 1; structuredClone(message); }\n' +
			'\tconst messageView = message.subarray(0); void messageView;\n' +
			'\ttry { throw [1]; } catch ([...unrelated]) { void unrelated; }\n' +
			'\ttry { try { throw message; } catch {} } catch ([...unreachable]) {}\n' +
			'\thiddenByteCloneTag`constant`;\n' +
			'\tclass ConstantBox { static get value() { return [1]; } }\n' +
			'\ttry { throw ConstantBox.value; } catch ([...constantCopy]) { void constantCopy; }\n' +
			'\tstructuredClone(ConstantBox.value);\n' +
			'\tfunction* constants() { yield 1; }\n' +
			'\tstructuredClone(constants().next().value);\n' +
			'\tfunction getDefault(value = 1) { return value; }\n' +
			'\tstructuredClone(getDefault());\n' +
			'\tconst constantBox = { nested: { get value() { return 1; } } };\n' +
			'\tstructuredClone(constantBox.nested.value);\n' +
			'\thiddenThunkCloneTag`${() => 1}`;\n' +
			'\tasync function cloneDefault(value = 1) { return structuredClone(value); }\n' +
			'\tcloneDefault();\n' + ingressMarker);
		expect(() => assertIngressCopyAuthority(ingressClean,
			{ allowSyntaxExtensions: true })).not.toThrow();
	});

	it('proves the scaling detector can fail', () => {
		expect(() => assertScaleInvariant('deliberately scaling control', 1, 6))
			.toThrow('deliberately scaling control: scaled from 1 to 6');
		expect(() => assertScaleInvariant('vacuous control', 0, 0))
			.toThrow('vacuous control: small fixture exercised zero operations');
	});
});

const TOPIC = 'io-budget:fanout';
const CAP = 'io-budget.stateless:1';
const BATCH_CAP = 'io-budget.batch:1';

function scriptedSubscriber(capability, topic = TOPIC) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([topic]);
	ud[WS_CAPS] = new Set([capability]);
	return {
		writes: 0,
		frames: [],
		getUserData() { return ud; },
		send(value, binary) { this.writes++; this.frames.push({ value, binary }); return 1; },
		close() {}
	};
}

let productionModulesPromise;
function productionModules() {
	if (!productionModulesPromise) {
		if (!buildFixtureOnce('default')) throw new Error('production fixture failed to build');
		const built = path.join(ROOT, 'test/fixture', variantOut('default'));
		productionModulesPromise = Promise.all([
			import(pathToFileURL(path.join(built, 'handler/platform.js')).href),
			import(pathToFileURL(path.join(built, 'handler/state.js')).href),
			import(pathToFileURL(path.join(built, 'wire.js')).href)
		]);
	}
	return productionModulesPromise;
}

let productionMeasurementId = 0;
async function measureProductionStatelessFanout(subscriberCount) {
	const [{ platform }, state, productionWire] = await productionModules();
	const id = ++productionMeasurementId;
	const topic = `${TOPIC}:${id}`;
	const capability = `${CAP}:${id}`;
	const sockets = Array.from({ length: subscriberCount }, () => scriptedSubscriber(capability, topic));
	const counts = { encodes: 0, frameBuilds: 0, allocations: 0, copies: 0 };
	const wire = {
		capability,
		schemaVersion: 1,
		encode() { counts.encodes++; return Uint8Array.of(7, 8, 9); }
	};
	for (const ws of sockets) {
		const ud = ws.getUserData();
		ud[WS_TOPIC_IDS] = { byName: new Map([[topic, 1]]), next: 2 };
		state.wsConnections.add(ws);
		state.capCounts.adjust(null, ud[WS_CAPS]);
	}
	productionWire.setBinaryFrameIO({
		allocate(length) {
			// The structural gate pins one allocation per build, so this boundary
			// counts both the builder invocation and its destination allocation.
			counts.frameBuilds++;
			counts.allocations++;
			return new Uint8Array(length);
		},
		copy(target, source, offset) {
			counts.copies++;
			target.set(source, offset);
		}
	});
	try {
		expect(platform.publishWire(topic, 'tick', { n: 1 }, wire, { seq: false, relay: false })).toBe(true);
	} finally {
		productionWire.resetBinaryFrameIO();
		for (const ws of sockets) {
			state.capCounts.adjust(ws.getUserData()[WS_CAPS], null);
			state.wsConnections.delete(ws);
		}
		state.topicPublishStats.delete(topic);
		state.topicSeqs.delete(topic);
		state.maxSeenSeq.delete(topic);
		state.sharedTopics.delete(topic);
	}
	const binaryFrames = sockets.flatMap((ws) => ws.frames.filter((frame) => frame.binary).map((frame) => frame.value));
	return {
		...counts,
		writes: sockets.reduce((sum, ws) => sum + ws.writes, 0),
		distinctFrames: new Set(binaryFrames).size
	};
}

function measureStatefulBatch(entryCount) {
	let encodes = 0;
	const wire = {
		capability: BATCH_CAP,
		schemaVersion: 1,
		encode() { encodes++; return Uint8Array.of(1); }
	};
	const ws = scriptedSubscriber(BATCH_CAP);
	const entries = Array.from({ length: entryCount }, (_, n) => ({ data: { n } }));
	deliverStatefulWireBatch({
		wire,
		event: 'tick',
		// Payloads, not caller entries: the fan-out is handed values the batch
		// already read, so it never re-reads application-owned objects.
		datas: entries.map(({ data }) => data),
		envelopes: entries.map(({ data }) => JSON.stringify({ topic: TOPIC, event: 'tick', data })),
		seqs: entries.map((_, index) => index + 1),
		state: { schemaVersion: 1 },
		ws,
		ud: ws.getUserData(),
		topic: TOPIC,
		ensureId: () => 1,
		poison: () => { throw new Error('unexpected wire-id poison'); },
		send(target) { target.writes++; return 1; }
	});
	return { encodes, writes: ws.writes };
}

describe('deterministic production WebSocket fan-out budgets', () => {
	it('6x stateless subscribers do not multiply production encode, frame-build, allocation, or copy counts', async () => {
		const small = await measureProductionStatelessFanout(1);
		const large = await measureProductionStatelessFanout(6);
		assertScaleInvariant('stateless codec encodes', small.encodes, large.encodes);
		assertScaleInvariant('stateless frame builds', small.frameBuilds, large.frameBuilds);
		assertScaleInvariant('stateless frame allocations', small.allocations, large.allocations);
		assertScaleInvariant('stateless frame copies', small.copies, large.copies);
		assertScaleInvariant('stateless distinct frames', small.distinctFrames, large.distinctFrames);
		expect(small).toEqual({ encodes: 1, frameBuilds: 1, allocations: 1, copies: 1, writes: 1, distinctFrames: 1 });
		expect(large).toEqual({ encodes: 1, frameBuilds: 1, allocations: 1, copies: 1, writes: 6, distinctFrames: 1 });
	}, 20000);

	it('6x batch entries remain one encode and one socket write per subscriber', () => {
		const small = measureStatefulBatch(1);
		const large = measureStatefulBatch(6);
		assertScaleInvariant('batch codec encodes', small.encodes, large.encodes);
		assertScaleInvariant('batch socket writes', small.writes, large.writes);
		expect(small).toEqual({ encodes: 1, writes: 1 });
		expect(large).toEqual({ encodes: 1, writes: 1 });
	});

});
