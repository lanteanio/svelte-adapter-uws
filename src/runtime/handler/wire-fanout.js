import { buildBinaryFrame } from '../wire.js';
import { WS_CAPS, WS_SUBSCRIPTIONS } from '../utils.js';

const SEND_THROWN = 3;

function send(io, ws, value, binary) {
	if (io.send) return io.send(ws, value, binary);
	try { return ws.send(value, binary, io.compress); }
	catch {
		if (io.counters) io.counters.closedWsAborts++;
		return SEND_THROWN;
	}
}

/** Encode the one payload reused by a stateless subscriber walk. */
export function encodeStatelessWirePayload(wire, event, data) {
	return wire.encode(event, data);
}

/**
 * Deliver one already-encoded stateless payload to a subscriber set. Both the
 * production platform and the test platform call this implementation, so the
 * encode-once walk cannot drift between them.
 *
 * @param {{ capability: string, schemaVersion: number }} wire
 * @param {Uint8Array | null} payload
 * @param {{
 *   topic: string,
 *   envelope: string,
 *   seq: number,
 *   excludeWs?: any,
 *   connections: Iterable<any>,
 *   ensureId: (ws: any, ud: any, topic: string) => number,
 *   isPoisoned: (ud: any, capability: string) => boolean,
 *   poison: (ws: any, ud: any, capability: string) => void,
 *   send?: (ws: any, value: string | Uint8Array, binary: boolean) => unknown,
 *   compress?: boolean,
 *   counters?: { closedWsAborts: number },
 *   buildFrame?: typeof buildBinaryFrame
 * }} io
 */
export function deliverStatelessWireFanout(wire, payload, io) {
	/** @type {Map<number, Uint8Array>} */
	const frames = new Map();
	const buildFrame = io.buildFrame || buildBinaryFrame;
	let delivered = false;
	for (const ws of io.connections) {
		if (ws === io.excludeWs) continue;
		let ud;
		try { ud = ws.getUserData(); } catch { continue; }
		const subscriptions = ud[WS_SUBSCRIPTIONS];
		if (!subscriptions || !subscriptions.has(io.topic)) continue;

		const caps = ud[WS_CAPS];
		if (payload == null || !caps || !caps.has(wire.capability) || io.isPoisoned(ud, wire.capability)) {
			if (send(io, ws, io.envelope, false) !== SEND_THROWN) delivered = true;
			continue;
		}

		const id = io.ensureId(ws, ud, io.topic);
		if (id === -1) {
			io.poison(ws, ud, wire.capability);
			if (send(io, ws, io.envelope, false) !== SEND_THROWN) delivered = true;
			continue;
		}

		let frame = frames.get(id);
		if (!frame) {
			frame = buildFrame(wire.schemaVersion, id, io.seq, payload);
			frames.set(id, frame);
		}
		if (send(io, ws, frame, true) !== SEND_THROWN) delivered = true;
	}
	return delivered;
}

/**
 * Encode and deliver one stateful codec batch to one subscriber. This is the
 * production batch primitive; test helpers execute the same function.
 *
 * @param {{
 *   wire: { capability: string, schemaVersion: number, encode: Function },
 *   event: string,
 *   datas: unknown[],
 *   envelopes: string[],
 *   seqs: number[],
 *   state: any,
 *   ws: any,
 *   ud: any,
 *   topic: string,
 *   ensureId: (ws: any, ud: any, topic: string) => number,
 *   poison: (ws: any, ud: any, capability: string) => void,
 *   send?: (ws: any, value: string | Uint8Array, binary: boolean) => unknown,
 *   compress?: boolean,
 *   counters?: { closedWsAborts: number },
 *   buildFrame?: typeof buildBinaryFrame
 * }} io
 */
export function deliverStatefulWireBatch(io) {
	const buildFrame = io.buildFrame || buildBinaryFrame;
	const schemaVersion = typeof io.state.schemaVersion === 'number'
		? io.state.schemaVersion
		: io.wire.schemaVersion;
	// Payloads arrive already read out of the caller's entries. Reading them
	// here would be a SECOND read of application-owned objects, after the JSON
	// envelopes above were built from the first - so a payload's toJSON could
	// hand this codec something the JSON subscribers never saw, under one seq.
	const updates = new Array(io.datas.length);
	for (let i = 0; i < io.datas.length; i++) updates[i] = io.datas[i];
	const payload = io.wire.encode(io.event + '-batch', { updates }, io.state);

	const sendJsonFrom = (start) => {
		let result = 1;
		for (let i = start; i < io.envelopes.length; i++) {
			result = send(io, io.ws, io.envelopes[i], false);
			if (result === SEND_THROWN) break;
		}
		return result;
	};

	if (payload == null) {
		let result = 1;
		for (let i = 0; i < io.datas.length; i++) {
			const entryPayload = io.wire.encode(io.event, io.datas[i], io.state);
			if (entryPayload == null) {
				result = send(io, io.ws, io.envelopes[i], false);
				continue;
			}
			const id = io.ensureId(io.ws, io.ud, io.topic);
			if (id === -1) {
				io.poison(io.ws, io.ud, io.wire.capability);
				return sendJsonFrom(i);
			}
			result = send(io, io.ws, buildFrame(schemaVersion, id, io.seqs[i], entryPayload), true);
			if (result === SEND_THROWN) return result;
			if (result === 2) {
				io.poison(io.ws, io.ud, io.wire.capability);
				return sendJsonFrom(i + 1);
			}
		}
		return result;
	}

	const id = io.ensureId(io.ws, io.ud, io.topic);
	if (id === -1) {
		io.poison(io.ws, io.ud, io.wire.capability);
		return sendJsonFrom(0);
	}
	const result = send(io, io.ws, buildFrame(schemaVersion, id, io.seqs[io.seqs.length - 1], payload), true);
	if (result === 2) io.poison(io.ws, io.ud, io.wire.capability);
	return result;
}
