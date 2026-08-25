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
// Re-pinned for the publish-lane one-read capture: publishWire now reads each
// option field (seq, relay, compress, excludeWs, _isRelay, _relaySeq) exactly
// once into locals ahead of the authority check, judges the locals through the
// values-form assert, and stamps through stampSeqValue - so a stateful
// accessor cannot answer the cluster refusal with one value and hand the
// stamp another. Property reads into locals and renamed callees only; no byte
// is read, allocated or copied, and no copy primitive entered the body.
// Measured against a faithful inline replay of the pre-change shape: the
// absent-option hot shape sits within run noise and the authoritative-seq
// shape pays about one nanosecond more on the isolated resolution
// (bench/micro-publish-capture-ab.mjs) - the price of a refusal that cannot
// be answered and then bypassed.
//
// Re-pinned for the bounded seq registries: publishWire's counter stamp now
// passes the shared bound (one added call argument), so an insert of a NEW
// topic consults the eviction floor and enforces the cap on that cold arm
// only. The known-topic stamp shape is unchanged and measured within run
// noise against an inline replay of the pre-change body; no byte is read,
// allocated or copied, and no copy primitive entered the body.
//
// Re-pinned again after the counter arm's max-seen write moved from a bare
// `maxSeenSeq.set` to `recordStampedSeen`: the write itself is unchanged, and
// what the recorder adds is a report to the registry bound when the write
// admitted a topic the map did not hold - the membership the bound was blind
// to, which left the observed registry growing past its configured ceiling.
// The map write itself is unchanged and now sits inside the recorder's frame;
// what the publish additionally pays is two reads of the map's own size and a
// compare, with no second hash lookup. Measured on the fastest round of each
// arm rather than the median, because the median's run-to-run spread on this
// shape is an order of magnitude larger than the effect: 0.13 ns/op on the
// shipped two-armed shape (bench/micro-seq-seen-record-ab.mjs). No byte is
// read, allocated or copied, and no copy primitive entered the body.
//
// Re-pinned for the publish-egress charge. publishWire's origin side now
// reads the topic's native subscriber count once, deducts a subscribed
// excluded socket, consults the egress gate (one holder-property read on the
// zero-config path; an early `return false` before the stamp when a ceiling
// refuses), and each delivery branch makes its one charge call with the
// envelope's measured length - or the stateless payload's priced frame
// length - times recipients. Scalar reads, integer arithmetic, and calls
// into the charge helper that mutate counter fields in place. Measuring an
// encoded length reads the characters of the envelope STRING already built
// for the wire, which is what the copy authority governs: no byte of any
// frame is read, allocated or copied, and no copy primitive entered the
// body. Measured end-to-end on the gate benches
// (bench/31-gateless-publish-ab.mjs, bench/27-publish-batched-ab.mjs):
// medians within the baselines' run noise, recorded in the same change.
const COPY_AUTHORITY_SYNTAX = Object.freeze({
	publishWire: 'bc9aa422f1481e3bbc5c9ece6dcdb51e68c5c803f91ef8c1282fc856d6e02828',
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
	//
	// Re-pinned for the publish-lane one-read capture, which reaches this graph
	// through utils.js -> utils/epoch.js and handler/cluster-sequence-policy.js:
	// stampSeqValue (the value form of the same three-way resolution, which
	// stampSeq now delegates to) and clusterSequenceValuesAccepted /
	// assertClusterSequenceAuthorityValues (the value form of the same refusal,
	// which the object forms delegate to). Comparisons, one delegation frame on
	// the cold object-form callers, and no change to any frame path in this
	// graph's own modules - no byte is read, allocated or copied, and no copy
	// primitive entered.
	//
	// Re-pinned for the bounded seq registries, reached through utils.js ->
	// utils/epoch.js: stampSeqValue's counter arm splits into a known-topic
	// shape (byte-identical semantics, previous value plus one) and a cold
	// new-topic arm that consults an optional bound's floor and cap. This
	// graph's callers pass no bound, so their behavior is unchanged; the
	// drift is the split itself and the optional parameter. No byte is read,
	// allocated or copied, and no copy primitive entered.
	//
	// Re-pinned for the console failure index, reached through
	// utils/hook-boundary.js: the message hook's failure line is now printed
	// through the error registry (`adapterConsoleLine`) instead of a literal,
	// which adds that import to the graph and moves the literal's characters
	// into a registry entry. A once-per-failure log line on the hook's catch
	// path; the frame the hook was handling is untouched, no byte is read,
	// allocated or copied, and no copy primitive entered.
	//
	// Re-pinned for the diagnostic pipeline's own collapse lines. Two entries
	// (id constants plus frozen entry objects) entered error-registry.js, and
	// diagnostic.js's two last-resort `console.error` calls now build their text
	// with `adapterConsoleLine` and a `String(record?.event)` coercion instead of
	// passing a literal and the raw value as separate console arguments. Registry
	// STRUCTURE is sealed by design, which is why data-only entries move this
	// digest; their sentences are masked like the rest. Both call sites sit in
	// the catch of a catch - reached only when rendering a diagnostic has already
	// failed twice, or when a configured sink AND its console fallback both
	// failed - so nothing on a frame path changed, no byte is read, allocated or
	// copied, and no copy primitive entered the graph. The coercion allocates a
	// string only on that collapse path and only from a value already held.
	//
	// Re-pinned for the diagnostic-collapse repair. Two things drifted here and
	// both are named, because this seal is the only thing that would catch the
	// second one. error-registry.js: one id constant removed and two added, one
	// frozen entry object added and one replaced - structure, which is sealed by
	// design, while the entries' sentences stay masked. And diagnostic.js's own
	// bodies, which ARE inside this graph - confirmed by reverting
	// error-registry.js alone and watching this digest still move, rather than
	// inferred. defaultOperationalEventSink now binds `formatDiagnostic(record)`
	// to a local and hands THAT to `console[method]` instead of nesting the two
	// in one expression, and sinkFailureFallback prints the original event
	// before building its notice instead of wrapping both in one try. Same
	// format call, same console call, same order, same operands: the local holds
	// the exact string the nested call already consumed, so no value is copied
	// and no allocation is added on any path. Neither function is on a frame
	// path - this is the diagnostics pipeline and it never touches a frame
	// buffer - so no byte is read, allocated or copied, and no copy primitive
	// entered the graph.
	//
	// Re-pinned for the sink trust boundary. The whole drift in this graph is one
	// statement: `Object.freeze(record)` in emitOperationalEvent, between the
	// record's construction and the first thing outside this module that can hold
	// it. It freezes an object the runtime just built - it reads no frame, copies
	// nothing, and emitOperationalEvent is not on a frame path in the first place;
	// diagnostics are emitted per notable occurrence, not per message or per
	// frame. No copy primitive entered.
	//
	// Re-pinned for the close-settled subscription registry, whose drift in this
	// graph is entirely in utils/ws-symbols.js, reached through utils.js: one
	// module-level `new WeakSet()` declaration, three membership comparisons
	// guarding the existing accounting deltas, one `instanceof Set` shape guard,
	// and one `add` of a Set object into that WeakSet. The operands are the
	// subscription registry OBJECT and a topic string that is already in it - the
	// WeakSet stores a reference, not a copy, and holds no bytes. None of it is on
	// a frame path: these run on subscribe, unsubscribe and close. No byte is
	// read, allocated or copied, and no copy primitive entered the graph.
	//
	// Re-pinned again for the same registry, moved to a shared slot: the settle
	// mark was a module-local WeakSet, which a duplicated bundle gives one copy
	// per instance while every copy mutates the same connection Set. It is now a
	// `Symbol.for` constant plus a lazy accessor that reads or creates the set on
	// globalThis - one property read, one comparison, one assignment of a WeakSet
	// reference. The operands are unchanged and none of it is on a frame path.
	// Re-pinned for the request-rejection transmission detail. The drift in
	// THIS graph is error-registry.js structure only, reached through
	// utils.js: the shared REQUEST_CLOSED_DETAIL frozen constant and the two
	// request entries' sources arrays gaining an element - an array node is
	// structure even with its string masked. Neither the close sweep nor the
	// request sites are in this closure. Data literals off every frame path;
	// no byte is read, allocated or copied, and no copy primitive entered
	// the graph.
	//
	// Re-pinned for the composed emitter record-construction guard,
	// reached through utils/operational-diagnostic.js:
	// emitOperationalDiagnostic wraps createOperationalDiagnostic in the
	// same try/catch its direct sibling has, printing the record-shape line
	// through adapterConsoleLine (one added import) instead of letting a
	// construction throw - a broken injected clock included - escape the
	// telemetry layer; and error-registry.js record-shape entry names the
	// new emission site in its sources array (an array node is structure
	// even with its string masked). A catch on a cold failure path plus
	// data literals; nothing on any frame path, no byte is read, allocated
	// or copied, and no copy primitive entered the graph.
	//
	// Re-pinned for the config-intake null folds, reached through
	// utils/upgrade-admission.js and handler/pressure-metrics.js:
	// createUpgradeAdmission folds a null options section to undefined (one
	// comparison and one assignment at gate construction, where null
	// previously failed the safe-integer ceiling checks and crashed the
	// boot), and resolvePressureThresholds merges thresholds through an
	// explicit Object.keys walk that skips null and undefined, so a
	// JSON-round-tripped null keeps the numeric default instead of becoming
	// a threshold that coerces to 0 and fires on every sample. Both run at
	// configuration time - gate construction and sampler start - and touch
	// only scalar option values; nothing on any frame path, no byte is
	// read, allocated or copied, and no copy primitive entered the graph.
	//
	// Re-pinned for the attribution slot install, reached through utils.js:
	// one `Symbol.for` slot declaration in utils/ws-symbols.js
	// (WS_ATTRIBUTION - the slot the open callback stamps once per
	// connection, off every frame path), and error-registry.js structure -
	// one id constant plus one frozen entry for the attribution refusal -
	// whose sentences stay masked while the object/array nodes count as
	// structure by design. The admission byte counters live in
	// utils/message-admission.js, which this graph does not reach. Data
	// declarations only; no byte is read, allocated or copied, and no copy
	// primitive entered the graph.
	// Re-pinned for the publish-egress charge, whose drift reaches this graph
	// only through the shared utils modules: utils/pressure.js's per-topic
	// entries gain the additive deliveriesPerSec field, utils/attribution.js
	// exports the shared id-rule predicate the egress tenant resolver reuses,
	// the manifest gains one signal declaration with its scope label domain
	// (frozen data literals), and error-registry.js gains two id constants
	// plus two frozen entries (structure; sentences masked). Nothing in this
	// graph's own modules changed, nothing executes differently on any frame
	// path, no byte is read, allocated or copied, and no copy primitive
	// entered the graph.
	//
	// Re-pinned for the two egress error-registry entries naming every
	// module that emits them: each `sources` array gains the dev plugin and the
	// harness beside the production wiring, so an operator reading the reference
	// is not pointed away from the surfaces that emit the same line. Frozen
	// string arrays in the same entries this graph already carried - read by the
	// reference generator and by nothing on any frame path. No byte is read,
	// allocated or copied, and no copy primitive entered the graph.
	//
	// Re-pinned for the eviction score and its counter. This graph's own drift
	// is the manifest's added counter declaration with its scope label domain,
	// error-registry.js's added sentence about what the dev surface reports, and
	// one null hook slot in state.js - frozen data and one property. The ledger
	// itself sits outside this graph; what it does now is rank a sampled window
	// by the fraction of its ceiling spent across the current window and the one
	// before (a `pu` fraction carried at rotation), drop the lowest, and call an
	// injected hook when the dropped window was still live, because the symptom
	// of an evicted window is FEWER refusals. Nothing on any frame path in this
	// graph executes differently, no byte is read, allocated or copied, and no
	// copy primitive entered.
	//
	// Re-pinned for the manifest label-domain addition. The drift in BOTH
	// graphs is observability-manifest.js, reached through utils.js ->
	// utils/metrics.js: one string added to an existing frozen enum
	// (upgrade_rejected_total.reason gains deferred_overflow, which the
	// pacing queue already emitted and the manifest alone did not declare).
	// Data only - a literal inside an existing Object.freeze, no statement
	// added and none executing differently on any frame path. No byte is
	// read, allocated or copied, and no copy primitive entered either graph.
	//
	// Re-pinned for the egress eviction entry. The drift in all three graphs is
	// error-registry.js alone, reached through utils.js: one id
	// constant added and one frozen entry object added, plus one string
	// appended to an existing frozen `sources` array. Structure, which is
	// sealed by design, while the entries' sentences stay masked - confirmed
	// by the prose-shape case below, which rewords a registry entry and does
	// not move this digest.
	//
	// The same change also edited utils/rate-limiter.js, and that module is
	// NOT in any of these graphs - checked rather than assumed: it is imported
	// only by handler.js and plugins/_shared/sensitive.js, and none of the
	// three roots reaches either. A first draft of this note claimed the octet
	// check drifted the ingress seal, which would have recorded a reason for a
	// digest it had nothing to do with.
	// No statement executes on any frame path, no byte is read, allocated or
	// copied, and no copy primitive entered either graph.
	// Re-pinned for the refusal Retry-After backoff. The drift is
	// utils/upgrade-admission.js reached through utils.js: a standalone
	// jitterRetryAfter with a two-value band floor plus its exported default
	// base, and the room's jitteredRetryAfter delegating to it. The header
	// writes themselves live in handler.js and testing.js, outside every
	// sealed graph. Integer arithmetic only - no statement touches a frame,
	// no byte is read, allocated or copied, and no copy primitive entered
	// the graph.
	// Re-pinned for the opaque-epoch domain change. The drift is in
	// utils/epoch.js, reached through this graph via utils.js: processEpoch now
	// latches `randomU32()` instead of `wallEpoch()` (one changed call and its
	// import), and its doc comment changed. No frame path, no bytes, no copy
	// primitive - the epoch is a subscribe/ack field, off every byte-owning
	// path. Carries the prior boot-warmup error-registry entry drift.
	// Re-pinned for the replenish backlog report. The drift in this graph is
	// runtime/wire.js (reached via parseBinaryFrame): requestNFrame gains an
	// optional parameter with a second string-concatenation arm serializing
	// the additive `queued` field (a client-to-server control-frame builder,
	// called on no server frame path), and leaseReportedSaturation, a new
	// pure helper of integer-only comparisons and one division normalizing
	// the reported backlog for the pressure fold. No byte is read, allocated
	// or copied, and no copy primitive entered the graph.
	// Re-pinned for the memory-wall basis: the drift in this graph is the
	// observability manifest's heap_used_ratio help string (reached through
	// utils.js -> utils/metrics.js), rewritten for the new measured quantity.
	// A data literal off every frame path; no byte is read, allocated or
	// copied, and no copy primitive entered the graph.
	ingress: '41f5fcbe15e5b9a6bc12c5b84cd704a51433a82f2f4b2869e0c22a2cc789ad97',
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
	// rewritten wherever they described the wrong code path. The
	// digest covers literal CONTENT, so documentation wording moves it even
	// though no statement, call or allocation changed. Nothing here executes on
	// a frame path.
	//
	// Re-pinned for the publish-lane one-read capture. The drift in this
	// graph's own module: publish() and publishWire() read each option field
	// once into locals ahead of the values-form authority check and stamp
	// through stampSeqValue; batch() snapshots each message's four option
	// fields into one plain object per message, judges the snapshot, and hands
	// publish() the SAME snapshot; publishBatched() captures per-message
	// seq/relay/jitterMs into three arrays in its atomic pre-pass and its
	// stamp, monotone-max branch, relay filter, and slow-path publish all
	// consume the captured values. Locals, plain snapshot objects and arrays
	// of scalars/references - no byte is read, allocated or copied, and no
	// copy primitive entered. Measured against a faithful inline replay of
	// the pre-change shape: the absent-option hot shape sits within run
	// noise and the authoritative-seq shape pays about one nanosecond more
	// on the isolated resolution (bench/micro-publish-capture-ab.mjs).
	//
	// Re-pinned for the relay-gap staged drain, reached through
	// handler/state.js: the per-stream tracker gains a `saturated` boolean and
	// a `forgottenFloor` number (one added field pair at stream creation, a
	// hidden-class change there and nowhere hot), retainAboveRange returns
	// the lowest delivered ordinal it forgot instead of swallowing the fact,
	// and the confirmed-hole drain either reports the aged blocking hole from
	// the complete arrival record - allocating, on that cold drain path only,
	// one array of at most 64 exact ordinals for the sort plus the per-gap
	// report objects the consumer already expects - or falls back to the
	// first-hole report clamped below the forgotten floor. The per-frame
	// record path's delta is a numeric truthiness test of the return value at
	// two sites with a compare-and-store only when something was forgotten.
	// No frame byte is read, allocated or copied, and no copy primitive
	// entered the graph.
	//
	// Re-pinned for the prose-shape rule: error-registry.js - the one graph
	// module whose string content is operator documentation, independently
	// gated by the error-reference generator - is now digested as syntactic
	// SHAPE with string content masked, so rewording a cause or next-action
	// sentence no longer moves this seal while any new statement, call,
	// property, or key there still does. This digest movement IS the masking
	// taking effect; no source module changed. Three probes hold the rule
	// falsifiable in both directions below.
	//
	// Re-pinned for the quiet-state divergence entry: error-registry.js gained
	// one frozen entry object (id, event, prose fields) and its id constant -
	// STRUCTURE, which the prose-shape rule deliberately keeps sealed; the
	// entry's sentences are masked like the rest. Data literals only, nothing
	// on any frame path, no byte read, allocated or copied, no copy primitive.
	//
	// Re-pinned for the console-emitted failure index: error-registry.js gained
	// fifteen console-emission entries with their id constants plus the
	// adapterConsoleLine helper (string concatenation of registry fields, no
	// buffer); platform.js's sendTo async-filter warning, lifecycle.js's
	// degraded-expiry alert, and tls-reload.js's certExpiryAlert composer now
	// print through that helper, moving each literal line head into the
	// registry - all cold, once-per-condition warning paths, their guards
	// untouched. No frame path changed, no byte read, allocated or copied, no
	// copy primitive entered.
	//
	// Re-pinned for the bounded seq registries. Everything that moved in this
	// graph, named rather than summarised, because the seal is the only thing
	// watching some of it:
	// - platform.js passes the shared bound at the counter-stamp and
	//   seen-record sites (one added argument each; the known-topic shapes are
	//   unchanged and measured within run noise against inline replays);
	// - state.js's recordSeen splits its first-sighting case out of the
	//   monotone-max compare so a new topic can be counted, same compare, one
	//   added branch;
	// - pressure-metrics.js's cardinality warning takes the threshold and the
	//   observed size as defaulted parameters, so the lane that overflowed
	//   reports its own number;
	// - the graph gains utils/seq-bound.js and handler/seq-bound.js: map
	//   bookkeeping over topic strings and numbers, entered only on the cold
	//   new-topic arm. Its eviction sweep re-inserts the entries it passes
	//   over, which rewrites Map ORDER in the two registries and nothing
	//   else - no value is recomputed, and the state hash folds entries
	//   commutatively, so no observable moves.
	// topicEpoch is deliberately UNCHANGED - the floor carry is what keeps a
	// resuming client correct, so no epoch moves. No frame byte is read,
	// allocated or copied, and no copy primitive entered the graph.
	//
	// Re-pinned for the observed registry's missing membership report, the half
	// of the bound above that the seal did NOT catch: five publish lanes wrote
	// maxSeenSeq with a bare set, so the ceiling bounded the counter registry
	// alone and an application mixing an external seq authority with ordinary
	// counters retained close to two ceilings. state.js gains recordStampedSeen
	// (the same bare write, plus a size-delta check that reports a newly
	// admitted topic to the bound) and platform.js's five counter-arm writes
	// call it. The map write is unchanged and now sits inside the recorder's
	// frame; what the publish additionally pays is that frame, a non-number
	// guard, a bound-present guard, and two reads of the map's own size with a
	// compare - and no second hash lookup. The frame is the part worth naming:
	// utils/epoch.js records that `nextTopicSeq` was inlined into stampSeqValue
	// because a wrapper call measured a few percent on this same lane, so the
	// shape is one this file has been bitten by. Measured against it directly,
	// on the fastest round of each arm in the shipped two-armed shape:
	// 0.13 ns/op (bench/micro-seq-seen-record-ab.mjs). No frame byte is read,
	// allocated or copied, and no copy primitive entered the graph.
	//
	// Re-pinned for the console failure index. Two changes reach this graph:
	// state.js's new recorder gained the non-number guard its sibling already
	// had, and error-registry.js gained fifteen console entries plus their id
	// constants - data literals on no frame path. Later re-pins in this same
	// change carry only corrected entry prose and one renamed id constant. The registry's prose is
	// masked by the prose-shape allowlist; its STRUCTURE is not, which is what
	// moves the digest. No frame byte is read, allocated or copied, and no copy
	// primitive entered the graph.
	//
	// Re-pinned for the diagnostic pipeline's own collapse lines, which reach
	// this graph the same way the console failure index did. error-registry.js
	// gained two id constants and two frozen entry objects so the pipeline's
	// last-resort lines carry a searchable ID and a documented route instead of
	// printing as bare strings; diagnostic.js builds those two lines through
	// `adapterConsoleLine` now. Data literals plus two rewritten calls on the
	// catch-of-a-catch path, which is reached only once rendering has already
	// failed twice or a sink and its fallback have both failed. Registry prose is
	// masked; its structure is not, and that is what moves this digest. No frame
	// byte is read, allocated or copied, and no copy primitive entered.
	//
	// Re-pinned for the latched monotone guard on the observed maximum.
	// state.js gains a module-level boolean, two accessors over it, and a branch
	// in recordStampedSeen that takes a monotone-max compare once a foreign seq
	// has been recorded on this worker - a `get`, a comparison, and a `set` that
	// is SKIPPED when the value does not increase. recordSeen sets the boolean.
	// All of it is per-topic number bookkeeping in a Map of numbers: no frame
	// byte is read, allocated or copied, and no copy primitive entered the graph.
	// The counter-only path still takes the same bare write it did, which
	// bench/micro-seq-monotone-stamp-ab.mjs prices at parity (about a percent,
	// with the arms crossing over between process runs).
	// Re-pinned with the ingress seal above for the diagnostic-collapse repair,
	// same drift and same reason: error-registry.js structure (one id constant
	// removed, two added, one frozen entry object added and one replaced), plus
	// diagnostic.js's render/write split and its notice split, both of which are
	// in this graph too. Nothing on a frame path changed, no byte is read,
	// allocated or copied, and no copy primitive entered.
	// Re-pinned with the ingress seal above for the sink trust boundary, same
	// single statement and same reason: `Object.freeze(record)` on an object the
	// runtime just built, off any frame path. No copy primitive entered.
	// Re-pinned with the ingress seal above for the close-settled subscription
	// registry, same drift and same reason: utils/ws-symbols.js gains a
	// module-level `new WeakSet()`, three membership comparisons guarding the
	// existing accounting deltas, one `instanceof Set` shape guard, and one `add`
	// that stores a REFERENCE to the subscription registry rather than copying it.
	// These run on subscribe, unsubscribe and close, never on a frame path. No
	// byte is read, allocated or copied, and no copy primitive entered.
	// Re-pinned again with the ingress seal above for the same registry moved to
	// a shared slot: a `Symbol.for` constant and a lazy accessor over globalThis
	// replace the module-local WeakSet, so a duplicated bundle shares one set
	// instead of one per copy. A property read, a comparison and a reference
	// assignment; no byte is read, allocated or copied.
	// Re-pinned for the streaming teardown's failure honesty, reached through
	// handler/ssr.js and handler/state-pool.js: the teardown now ends the
	// response only when the source reported done and abruptly closes on every
	// other exit; the close is marked server-initiated on the shared request
	// state so the failure event survives the abort callback close() itself
	// fires; and the error-response writes (500 and 413) are guarded off once
	// any byte reached the wire. Flag assignments, comparisons, and a close()
	// on an already-failing exchange - the chunk write path is untouched, no
	// byte is read, allocated or copied, and no copy primitive entered the
	// graph. The registry consequence rewording is masked by the prose-shape
	// rule and contributes nothing here.
	// Re-pinned with the ingress seal above for the request-rejection
	// transmission detail: platform.request's rejections pass the registry's
	// shared detail constants to adapterErrorMessage, the pending entry
	// gains a recorded send-outcome field the close sweep reads through a
	// two-way conditional, and the registry gains the shared frozen constant
	// plus an element in each request entry's sources array (an array node
	// is structure even with its string masked). Cold failure paths and one
	// boolean store beside the existing send; no byte is read, allocated or
	// copied, and no copy primitive entered the graph.
	// Re-pinned with the ingress seal above for the composed emitter
	// record-construction guard, same drift and same reason: the guard and
	// its adapterConsoleLine import in utils/operational-diagnostic.js, and
	// the record-shape entry sources array gaining that emission site.
	// Cold failure path and data literals; no byte is read, allocated or
	// copied, and no copy primitive entered the graph.
	// Re-pinned with the ingress seal above for the config-intake null
	// folds, same drift and same reason: the null-section fold at the top
	// of createUpgradeAdmission and the explicit null-skipping threshold
	// merge in resolvePressureThresholds. Configuration-time scalar reads;
	// no byte is read, allocated or copied, and no copy primitive entered
	// the graph.
	// Re-pinned with the ingress seal above for the attribution slot install,
	// same drift and same reason: the WS_ATTRIBUTION `Symbol.for` declaration
	// in utils/ws-symbols.js and the attribution refusal's id constant plus
	// frozen entry in error-registry.js (structure by design, sentences
	// masked). The admission byte counters live in utils/message-admission.js,
	// outside this graph. Data declarations off every frame path; no byte is
	// read, allocated or copied, and no copy primitive entered the graph.
	// Re-pinned for the publish-egress charge. The drift in this graph's own
	// modules is the one shared charge point: platform.js consults the egress
	// gate before every publish-family fan-out (holder-property read,
	// comparisons, an early refusal return ahead of the seq stamp) and calls
	// handler/egress-budget.js exactly once per logical publish, which joins
	// the graph with utils/egress-account.js and utils/attribution.js - the
	// five duplicated per-site stats blocks collapse into that helper, whose
	// additions are Map lookups and integer field mutations on preallocated
	// window objects plus one Buffer.byteLength read of the envelope STRING
	// per logical publish. sendTo and adviseReconnect split into a filter
	// pass and a send pass so the decision precedes the first frame. The
	// graph also picks up the shared data drift: one manifest signal with its
	// label domain, two error-registry entries (structure; prose masked), the
	// pressure entries' additive deliveries field, and the state counters'
	// egress window fields. No byte of any frame is read, allocated or
	// copied, and no copy primitive entered the graph. Cost was measured as
	// the accounting delta itself, interleaved in one process so machine
	// load hits every arm equally: 2.80 ns per publish for the stats block
	// this replaces, 3.36 ns with no ceiling configured, and 50.58 ns once a
	// BYTES ceiling arms the encoded-length measurement - so the walk is
	// paid only where a budget decides on it. Those arms price the charge
	// alone; the recipient-count and gate reads this change also adds to
	// every publish carry the zero-config delta to single-digit nanoseconds,
	// against a fan-out primitive measured in microseconds. The gate benches
	// (bench/31-gateless-publish-ab.mjs, bench/27-publish-batched-ab.mjs)
	// cannot resolve a delta that small at their run-to-run spread and are
	// not cited for it.
	//
	// Re-pinned for the egress ledger's cap eviction, whose drift reaches this
	// graph through handler/egress-budget.js -> utils/egress-account.js. Each
	// usage map becomes a small factory holding the map, an eviction cursor that
	// survives between calls, and its scope ceilings. At the cap the eviction
	// samples up to `egress.evictionSample` entries (default 8) from the
	// rotating cursor, takes
	// an expired window outright, and otherwise drops the one that has spent the
	// least of its allowance across the current window and the one before it
	// (a `pu` fraction carried at rotation). Spent allowance rather than a
	// publish count, because a `deliveries` or `bytes` ceiling enforces a
	// quantity one publish can exhaust. A live eviction also calls an injected
	// hook, wired to the `egress_window_evicted_total{scope}` counter and its
	// manifest declaration, because the symptom of an evicted window is FEWER
	// refusals. The two error-registry entries in this graph additionally name
	// every module that emits them, as frozen string arrays.
	//
	// A new key past the sweep floor (the cap less its derived slack) also
	// sweeps up to EGRESS_SWEEP_STEPS entries
	// from the same cursor and drops the expired windows it passes, so the cap
	// bounds keys live at once rather than keys ever seen. Without it expired
	// entries accumulated until every new key forced a choice among eight
	// CONSECUTIVE live windows, which cost at-ceiling topics their enforcement
	// far below the cap.
	//
	// All of it runs on inserts or on rotation, never on the steady-state read;
	// the lookup and the charge are untouched. Divisions and comparisons over
	// window counters, a bounded run of iterator steps, one added number field,
	// and Map deletes on keys whose windows had already lapsed - no byte of any
	// frame is read, allocated or copied, and no copy primitive entered the
	// graph. Measured interleaved with the arm order rotated per round and
	// repeated, against head eviction off a fresh iterator: -58% (780 -> 318 ns
	// per publish) where every resident window is live and the tombstone re-walk
	// dominates, and inside run-to-run noise at +/-2% on the three shapes that
	// either never evict or find their victim immediately.
		//
	// Re-pinned for the reclamation that precedes it. A key arriving at a full
	// ledger now walks the same cursor for lapsed windows and drops them, and a
	// ceiling is surrendered only once a full pass has come back empty; until
	// then the map takes bounded slack instead. One bounded walk, integer
	// comparisons over window timestamps, and Map deletes on keys whose windows
	// had already lapsed - all on the insert path at the cap, never on the
	// steady-state read. No byte of any frame is read, allocated or copied, and
	// no copy primitive entered the graph.
	//
	// Re-pinned for the reclamation's own repair, which moved WHERE the decision
	// to surrender a ceiling is taken rather than adding work. Eviction is now
	// gated on the ledger being full, not on a sweep having reported the ledger
	// clean; the sweep's finding became a time horizon, recorded from the
	// smallest window expiry a completed pass saw, and read as a comparison
	// against the clock. The insert that arrives at the bound may walk a full
	// pass for a lapsed window rather than take a live one - the same cursor,
	// the same integer comparison, a higher step ceiling on that one insert. Two
	// state variables were removed. All of it is still on the insert path at the
	// bound, never on the steady-state read: comparisons over window
	// timestamps, a bounded run of iterator steps, and Map deletes on keys whose
	// windows had already lapsed. No byte of any frame is read, allocated or
	// copied, and no copy primitive entered the graph. Measured interleaved with
	// the arm order rotated per round and repeated, against the previous policy
	// at an equal bound: every one of five shapes inside run-to-run noise.
	//
	// Re-pinned again to REMOVE work from the insert path. The reclamation walk
	// no longer lifts its step budget when the ledger is full: it keeps the same
	// fixed budget everywhere and lets the cursor, which survives between calls,
	// amortise a pass across the inserts that approach the bound. The lifted
	// budget was bounded only by the ledger's own size, and on a clock that
	// advances per publish - which is the real one - it ran on nearly every
	// insert rather than once, at +213% per publish with single-call latency
	// reaching 87 us. Two statements were deleted and one became a constant. No
	// byte of any frame is read, allocated or copied, and no copy primitive
	// entered the graph. Measured interleaved with the arm order rotated per
	// round, repeated, against a byte-identical control arm and with the clock
	// advancing on every publish: +3.8%, +6.5% and +2.7% on the three shapes
	// that reach the bound, against the previous pin's +213%, +152% and +4%.
	//
	// Re-pinned for the manifest label-domain addition. The drift in BOTH
	// graphs is observability-manifest.js, reached through utils.js ->
	// utils/metrics.js: one string added to an existing frozen enum
	// (upgrade_rejected_total.reason gains deferred_overflow, which the
	// pacing queue already emitted and the manifest alone did not declare).
	// Data only - a literal inside an existing Object.freeze, no statement
	// added and none executing differently on any frame path. No byte is
	// read, allocated or copied, and no copy primitive entered either graph.
	//
	// Re-pinned for the egress eviction entry. The drift in all three graphs is
	// error-registry.js alone, reached through utils.js: one id
	// constant added and one frozen entry object added, plus one string
	// appended to an existing frozen `sources` array. Structure, which is
	// sealed by design, while the entries' sentences stay masked - confirmed
	// by the prose-shape case below, which rewords a registry entry and does
	// not move this digest.
	//
	// The same change also edited utils/rate-limiter.js, and that module is
	// NOT in any of these graphs - checked rather than assumed: it is imported
	// only by handler.js and plugins/_shared/sensitive.js, and none of the
	// three roots reaches either. A first draft of this note claimed the octet
	// check drifted the ingress seal, which would have recorded a reason for a
	// digest it had nothing to do with.
	// No statement executes on any frame path, no byte is read, allocated or
	// copied, and no copy primitive entered either graph.
	// Re-pinned for the sizeable egress ledger. The drift in this graph is
	// utils/egress-account.js alone, reached through handler/egress-budget.js:
	// the ledger factory takes its bound and sample width as parameters,
	// normalizeEgressOptions derives them from `egress.maxKeys` and
	// `egress.evictionSample` (safe-integer checks, a power-of-two doubling
	// loop, two new frozen config fields), the sweep floor becomes a derived
	// closure constant, and the tenant memo's clear threshold reads the config
	// bound. Integer arithmetic, Map size reads and the same in-place counter
	// mutations as before: no statement touches a frame, no byte is read,
	// allocated or copied, and no copy primitive entered the graph. The A/B
	// bench's per-shape control arm resolves no delta and its enforcement
	// oracle stays 0 / 0. The bound's ceiling literal then moved from 2^30 to
	// 2^24 in the same module - V8's Map refuses its 2^24 + 1st entry, so any
	// larger bound was a publish-path crash, not a bigger ledger - one data
	// literal in the same frozen constant pair, nothing else.
	// Re-pinned for the refusal Retry-After backoff, the same
	// utils/upgrade-admission.js drift the ingress seal records above:
	// jitterRetryAfter with its band floor, the exported default base, and
	// the delegating room method; the header writes themselves live in
	// handler.js and testing.js, outside every sealed graph. No frame path,
	// no bytes, no copy primitive.
	// Re-pinned for the opaque-epoch domain change: utils/epoch.js, reached
	// through this graph, latches `randomU32()` instead of `wallEpoch()` (one
	// changed call, its import, and the doc comment). The epoch is a
	// subscribe/ack field off every byte-owning path - no frame path, no bytes,
	// no copy primitive. Carries the prior boot-warmup drift (the isWarmupRequest
	// delegate plus the leaf warmup-registry.js import and the error-registry
	// entry) and the cluster-metrics-merge bounds before it.
	// Re-pinned for the replenish backlog report: runtime/wire.js (reached via
	// buildBinaryFrame) gains requestNFrame's optional `queued` serialization
	// arm (a client-to-server control-frame builder, called on no server frame
	// path) and the pure leaseReportedSaturation helper - integer-only
	// comparisons and one division. No byte is read, allocated or copied, and
	// no copy primitive entered the graph.
	// Re-pinned for the memory-wall basis, whose drift in this graph is
	// threefold, because platform.js imports pressure-metrics.js: the
	// observability manifest's heap_used_ratio help string (a data literal);
	// the sampler's memory fold in pressure-metrics.js (the arena-fullness
	// division replaced by the wall reader's worst-of, plus the module-eval
	// reader construction); and utils/memory-wall.js entering the graph as a
	// new module - it carries a readFileSync, the graph's one new byte-reading
	// primitive, which reads only the cgroup limit files and /proc/self/cgroup
	// inside the 1 Hz sampler and is reachable from no frame path. No frame
	// byte is read, allocated or copied, and no copy primitive entered the
	// graph.
	platform: '0a0b278033615251d38742e53442f244d5b3ab4f8f4ed32d906be563e3ce7514',
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
	// Re-pinned with the ingress seal for the publish-lane one-read capture:
	// the only drift in this graph is utils/epoch.js's stampSeqValue and the
	// stampSeq delegation, reached through utils.js. Nothing in this graph's
	// own modules changed, and no copy primitive entered.
	// Re-pinned with the ingress seal for the bounded seq registries: the
	// only drift in this graph is utils/epoch.js's cold new-topic arm and
	// optional bound parameter, reached through utils.js; callers here pass
	// no bound. Nothing in this graph's own modules changed, and no copy
	// primitive entered.
	// Re-pinned for the console failure index. The drift reaches this graph
	// only through utils.js's re-exports: utils/pressure.js,
	// utils/upgrade-admission.js, utils/metrics.js and utils/fd-limit.js each
	// print an existing failure through the error registry instead of a
	// literal (which also pulls error-registry.js and its new entries into the
	// graph), and the fd advisory's subject moved ahead of its numbers. All
	// cold, once-per-condition log paths. Nothing in this graph's own modules
	// changed, and no copy primitive entered.
	// Re-pinned for the diagnostic pipeline's own collapse lines. This graph
	// reaches error-registry.js the same way it did for the console failure
	// index, so its two new id constants and two new frozen entry objects move
	// this digest as data literals; the registry's prose is masked, its
	// structure is not. diagnostic.js is not in this graph. Nothing in this
	// graph's own modules changed, and no copy primitive entered.
	// Re-pinned with the other two seals for the diagnostic-collapse repair. The
	// certain drift is error-registry.js structure, exactly as for the collapse
	// lines above: one id constant removed, two added, one frozen entry object
	// added and one replaced, with the prose masked. Whether diagnostic.js's own
	// restructure also reaches THIS graph was not isolated - the ingress and
	// platform assertions run first and abort before this one, so the
	// revert-one-file check that settled it for them cannot be run here - and the
	// note above claiming diagnostic.js is absent from this graph is exactly the
	// kind of inherited assertion that check disproved for the other two. It does
	// not change the verdict either way: the drift in both files is a local
	// binding, a statement order and cold last-resort console paths, so on either
	// reading no byte is read, allocated or copied and no copy primitive entered.
	// Re-pinned for the sink trust boundary, and this one settles what the note
	// above could only leave open. The single production file that changed this
	// time is diagnostic.js, so this digest moving is the isolation that could
	// not be run before: diagnostic.js IS in this graph too, and the older claim
	// that it is absent from it was wrong for every graph here, not just for
	// ingress and platform. The drift is the same one statement,
	// `Object.freeze(record)` in emitOperationalEvent, on an object the runtime
	// just built and off any frame path. No copy primitive entered.
	// Re-pinned with the ingress and platform seals above for the close-settled
	// subscription registry, same drift and same reason: utils/ws-symbols.js is in
	// this graph too, and gains a module-level `new WeakSet()`, three membership
	// comparisons guarding the existing accounting deltas, one `instanceof Set`
	// shape guard, and one `add` storing a reference to the subscription registry.
	// The fan-out path itself is untouched; these run on subscribe, unsubscribe
	// and close. No byte is read, allocated or copied, and no copy primitive
	// entered.
	// Re-pinned again with the two seals above for the same registry moved to a
	// shared slot - same one-file drift, same operands, still nothing on the
	// fan-out path and no copy primitive.
	// Re-pinned with the ingress and platform seals above for the
	// request-rejection transmission detail: the drift in THIS graph is
	// error-registry.js structure only - the shared detail constant and the two request entries' sources
	// arrays gain an element, an array node being structure even with its
	// string masked. Data literals off every fan-out path; no byte is read,
	// allocated or copied, and no copy primitive entered.
	// Re-pinned with the ingress and platform seals above for the composed
	// emitter record-construction guard, same drift and same reason: the
	// guard and its adapterConsoleLine import in
	// utils/operational-diagnostic.js, and the record-shape entry sources
	// array gaining that emission site. Cold failure path and data literals;
	// no byte is read, allocated or copied, and no copy primitive entered
	// the graph.
	// Re-pinned with the ingress and platform seals above for the
	// config-intake null folds, same drift and same reason: the
	// null-section fold at the top of createUpgradeAdmission and the
	// explicit null-skipping threshold merge in resolvePressureThresholds.
	// Configuration-time scalar reads; no byte is read, allocated or
	// copied, and no copy primitive entered the graph.
	// Re-pinned with the ingress and platform seals above for the
	// attribution slot install, same drift and same reason: the
	// WS_ATTRIBUTION `Symbol.for` declaration in utils/ws-symbols.js and
	// the attribution refusal's id constant plus frozen entry in
	// error-registry.js (structure by design, sentences masked). The
	// admission byte counters live in utils/message-admission.js, outside
	// this graph. Data declarations off every frame path; no byte is read,
	// allocated or copied, and no copy primitive entered the graph.
	// Re-pinned for the publish-egress charge, whose drift reaches this graph
	// only through utils.js exactly as it reaches the ingress graph: the
	// pressure entries' additive deliveriesPerSec field, the exported
	// attribution id-rule predicate, one manifest signal with its label
	// domain, and two error-registry entries (structure; prose masked).
	// Nothing in this graph's own modules changed, and no copy primitive
	// entered.
	//
	// Re-pinned for the same two error-registry entries naming every
	// module that emits them: each `sources` array gains the dev plugin and the
	// harness beside the production wiring. Frozen string arrays in entries this
	// graph already carried, read by the reference generator and by nothing on
	// any frame path. Nothing in this graph's own modules changed, no byte is
	// read, allocated or copied, and no copy primitive entered.
	//
	// Re-pinned for the same eviction work, which reaches this graph only
	// through the shared modules: the manifest gains one counter declaration
	// with its scope label domain, error-registry.js gains a sentence about what
	// the dev surface reports, and state.js gains one null hook slot. Frozen data
	// and one property; nothing in this graph's own modules changed, nothing on any
	// frame path executes differently, and no copy primitive entered.
	//
	// Re-pinned for the same manifest label-domain addition as the graphs
	// above, reached the same way - observability-manifest.js through utils.js
	// -> utils/metrics.js. One string inside an existing frozen enum; data
	// only, no statement added, nothing executing differently on any frame
	// path, no byte read, allocated or copied, no copy primitive entered.
	//
	// Re-pinned for the egress eviction entry. The drift in all three graphs is
	// error-registry.js alone, reached through utils.js: one id
	// constant added and one frozen entry object added, plus one string
	// appended to an existing frozen `sources` array. Structure, which is
	// sealed by design, while the entries' sentences stay masked.
	//
	// This is the THIRD of the three seals one registry edit moves. Re-pinning
	// the first two and reading a green targeted run is how the previous two
	// were missed; only a full run reports all three.
	// No statement executes on any frame path, no byte is read, allocated or
	// copied, and no copy primitive entered any graph.
	// Re-pinned for the refusal Retry-After backoff, the same
	// utils/upgrade-admission.js drift the ingress and platform seals record:
	// jitterRetryAfter with its band floor, the exported default base, and
	// the delegating room method; the header writes themselves live in
	// handler.js and testing.js, outside every sealed graph. No frame path,
	// no bytes, no copy primitive.
	// Re-pinned for the opaque-epoch domain change: utils/epoch.js is reached
	// through this graph too, and now latches `randomU32()` instead of
	// `wallEpoch()`. The epoch is a subscribe/ack field off every byte-owning
	// path - no frame path, no bytes, no copy primitive. Carries the prior
	// boot-warmup error-registry entry drift.
	// Re-pinned for the replenish backlog report: runtime/wire.js (this
	// graph's fan-out root imports buildBinaryFrame from it) gains
	// requestNFrame's optional `queued` serialization arm (a client-to-server
	// control-frame builder, called on no server frame path) and the pure
	// leaseReportedSaturation helper - integer-only comparisons and one
	// division. No byte is read, allocated or copied, and no copy primitive
	// entered the graph.
	// Re-pinned for the memory-wall basis: the drift in this graph is the
	// observability manifest's heap_used_ratio help string (reached through
	// utils.js -> utils/metrics.js), rewritten for the new measured quantity.
	// A data literal off every frame path; no byte is read, allocated or
	// copied, and no copy primitive entered the graph.
	'wire-fanout': '178daeca5d031d9acac9b378f20fba194f3dce7bbbd23cbefc702a528fea1df0',
	// Re-pinned for the replenish backlog report, whose drift is this graph's
	// own root module: requestNFrame's optional `queued` serialization arm (a
	// client-to-server control-frame builder, called on no server frame path)
	// and the pure leaseReportedSaturation helper - integer-only comparisons
	// and one division. No byte is read, allocated or copied, and no copy
	// primitive entered the graph.
	wire: '589bd4e8c28710157db7d5910670e362df1cbdbb33e47b5edc09e6cc9582797d'
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

// Modules whose STRING CONTENT is documentation rather than wire bytes. The
// module seal exists so no copy primitive or executable change enters the
// byte-owning graph unsealed - its object is STRUCTURE. error-registry.js is a
// data module of operator guidance whose literal content is independently
// gated: generate-error-reference renders and validates every entry field the
// runtime displays - including the operator shortlink URL, added to that gate
// after it turned out to be watched by this seal alone - and
// fails the build when the registry and docs/errors.md disagree. Yet its
// sentences moved this seal three times in one session, twice for wording
// alone - and a gate that fires on wording teaches people that a seal
// failure is routine paperwork. For the modules
// listed here the digest covers the syntactic SHAPE with string content
// masked: rewording a sentence no longer moves it, while any new statement,
// call, property, or key still does. The allowlist is deliberately one entry:
// observability-manifest.js is also literal-heavy but its literals are
// wire-visible signal names and label domains, which deserve the full watch.
const PROSE_SHAPE_MODULES = new Set(['src/runtime/error-registry.js']);
const PROSE_PLACEHOLDER = '<prose>';

function maskProseStrings(node, keyPosition = false) {
	if (Array.isArray(node)) return node.map((child) => maskProseStrings(child));
	if (!node || typeof node !== 'object') return node;
	if (node.type === 'Literal' && typeof node.value === 'string' && !keyPosition) {
		return { ...node, value: PROSE_PLACEHOLDER };
	}
	if (node.type === 'TemplateElement') {
		return { ...node, value: { raw: PROSE_PLACEHOLDER, cooked: PROSE_PLACEHOLDER } };
	}
	const masked = {};
	for (const [key, value] of Object.entries(node)) {
		if (node.type === 'Property' && key === 'key' && !node.computed) {
			// A literal property KEY is structure (which entry exists), not prose.
			// A COMPUTED key's literal falls through and is masked; none exists
			// in the allowlisted module today, and introducing one is a new node
			// that moves the digest into review on its way in.
			masked[key] = maskProseStrings(value, true);
		} else if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration' || node.type === 'ImportExpression') && key === 'source') {
			// Module specifiers are reachability structure, never prose.
			masked[key] = value;
		} else if (value && typeof value === 'object') {
			masked[key] = maskProseStrings(value);
		} else {
			masked[key] = value;
		}
	}
	return masked;
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
		const program = { type: 'Program', sourceType: ast.sourceType, body };
		modules.push({
			path: relativePath,
			program: PROSE_SHAPE_MODULES.has(relativePath) ? maskProseStrings(program) : program
		});

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
		throw new Error(
			`${moduleName} module syntax changed outside its counted copy authority: ${actual}. ` +
			'The common benign cause is edited literal content somewhere in the sealed graph ' +
			'(the digest covers string characters outside the prose-shape allowlist). If review ' +
			'confirms no byte-owning change entered, re-pin COPY_AUTHORITY_MODULE_SYNTAX to the ' +
			'digest above WITH a recorded reason in the comment over it - that is the protocol, ' +
			'not a workaround.'
		);
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

	// The prose-shape rule, held falsifiable in both directions: wording in the
	// allowlisted documentation module must NOT move the seal (that noise
	// taught people a seal failure is routine paperwork), while structure there
	// and wording anywhere else still must. All three probes run through the
	// real graph digest with source overrides, against the pinned value.
	it('lets documentation wording move in the prose-shape module without moving the seal', () => {
		const registryPath = path.resolve(ROOT, 'src/runtime/error-registry.js');
		const registrySource = readFileSync(registryPath, 'utf8');
		const sentence = 'The configured address or port could not be bound, or the process lacks permission.';
		expect(registrySource).toContain(sentence);
		const reworded = registrySource.replace(sentence,
			'Binding the configured listener address or port failed, or the process lacks permission to.');
		expect(reworded).not.toBe(registrySource);
		expect(moduleGraphSyntaxDigest(PLATFORM_SOURCE, 'platform', {
			sourceOverrides: new Map([[registryPath, reworded]])
		})).toBe(COPY_AUTHORITY_MODULE_SYNTAX.platform);
	});

	it('still trips the seal for structure in the prose-shape module', () => {
		const registryPath = path.resolve(ROOT, 'src/runtime/error-registry.js');
		const registrySource = readFileSync(registryPath, 'utf8');
		expect(moduleGraphSyntaxDigest(PLATFORM_SOURCE, 'platform', {
			sourceOverrides: new Map([[registryPath, registrySource + '\nexport const proseShapeProbe = 1;\n']])
		})).not.toBe(COPY_AUTHORITY_MODULE_SYNTAX.platform);
	});

	it('still trips the seal for string content outside the prose-shape allowlist', () => {
		// A known CODE literal in the sealed entry module itself (an assert
		// label on the publish path): outside the allowlist, its characters
		// stay sealed - only the shape of the one documentation module is free.
		expect(PLATFORM_SOURCE).toContain("'envelope.empty'");
		const mutated = PLATFORM_SOURCE.replace("'envelope.empty'", "'prose-probe-text'");
		expect(mutated).not.toBe(PLATFORM_SOURCE);
		expect(moduleGraphSyntaxDigest(mutated, 'platform'))
			.not.toBe(COPY_AUTHORITY_MODULE_SYNTAX.platform);
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
