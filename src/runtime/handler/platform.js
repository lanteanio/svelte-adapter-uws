import { wsModule } from '../ws-handler-bridge.js';
import { metricsRegistry } from '../metrics-bridge.js';
import { parentPort } from 'node:worker_threads';
import { MAX_COALESCED_KEYS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, MAX_SUBSCRIPTIONS_PER_CONNECTION, WS_CAPS, WS_COALESCED, WS_PENDING_REQUESTS, WS_PLATFORM, WS_SUBSCRIPTIONS, assert, fatal, collapseByCoalesceKey, completeEnvelope, createScopedTopic, isValidWireTopic, nextTopicSeq, processEpoch, readAssertionCounts, wrapBatchEnvelope } from '../utils.js';
import { buildBinaryFrame } from '../wire.js';
import { now, monotonicNow, clearTimer, setTimer, randomBytes, randomFloat, randomU32, randomUuid } from '../runtime.js';
import { capCounts, counters, maxSeenSeq, pressureListeners, pressureSnapshot, publishRateListeners, sharedTopics, subscribeAuth, topicPublishStats, topicSeqs, wsConnections } from './state.js';
import { app, wsDebug, WS_COMPRESSION_ON } from './config.js';
import { envelopePrefix } from './envelope-cache.js';
import { batchRelay } from './relay.js';
import { readHlc } from './hlc.js';
import { BATCH_FRAME_WARN_BYTES, bumpOut, maybeWarnTopicRegistry, warnLargeBatchFrame } from './pressure-metrics.js';
import { flushCoalescedFor, runUserSubscribeGate } from './subscribe-hooks.js';
import { ensureWireId, ensureWireState, poisonWireState, wireStatePoisoned } from './wire-state.js';
import { registerWireCodec as _registerWireCodec, getWireCodec } from './codec-registry.js';
import { cohortTopics, joinSharedCohort, leaveSharedCohort } from './cohort.js';
import { getSharedWireId } from './shared-wire-id.js';

/** @type {import('../../index.js').Platform} */
export const platform = {
	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 * Auto-wraps in a { topic, event, data } envelope that the client store understands.
	 * No-op if no clients are subscribed - safe to call unconditionally.
	 */
	publish(topic, event, data, options) {
		counters.publishCountWindow++;
		const seq = (options && options.seq === false)
			? null
			: nextTopicSeq(topicSeqs, topic);
		// Record the highest seq this worker has observed for the topic. The
		// freshly stamped seq is the new max (nextTopicSeq is monotonic), so this
		// is a bare set with no compare. Skipped when stamping is off so a
		// {seq:false}-only topic never enters the convergence comparison.
		if (seq !== null) maxSeenSeq.set(topic, seq);
		// `{ jitterMs }` de-herd window: stamp it on the frame so each client rolls its
		// own delay before dispatching (spreads N receivers' follow-up actions across
		// the window). The window is carried verbatim - NOT a server-rolled offset,
		// which would defer every subscriber of this one frame identically.
		const jitterMs = (options && typeof options.jitterMs === 'number' && options.jitterMs > 0) ? options.jitterMs : null;
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq, jitterMs);
		// A zero-length frame at a send site would broadcast garbage to every
		// subscriber - unrecoverable framing corruption. One length guard, identical
		// in cost to the assert it replaces.
		fatal(envelope.length > 0, 'envelope.empty', { topic, event });
		// Per-topic counter for runaway-publisher detection. Allocates
		// one entry per topic on first publish, then mutates two int
		// fields in place forever. Sampler drains and resets at 1 Hz.
		let s = topicPublishStats.get(topic);
		if (!s) {
			s = { m: 0, b: 0 };
			topicPublishStats.set(topic, s);
			// Cold path: a brand-new topic just entered the registry. Cheap
			// place to check the topic-cardinality warn threshold without
			// touching the steady-state hot path.
			maybeWarnTopicRegistry();
		} else {
			assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape', { topic });
		}
		s.m++;
		s.b += envelope.length;
		// Compress this text frame when a compressor is configured; opt out per
		// call with `{ compress: false }` (e.g. a very high-rate text topic where
		// the per-subscriber deflate CPU would outweigh the bandwidth saving).
		const compress = WS_COMPRESSION_ON && (!options || options.compress !== false);
		const result = app.publish(topic, envelope, false, compress);
		// Relay to other workers via main thread (no-op in single-process mode).
		// Pass { relay: false } when the message originates from an external
		// pub/sub source (Redis, Postgres, etc.) that already fans out to
		// every process - relaying would cause duplicate delivery.
		const relayed = !!(parentPort && (!options || options.relay !== false));
		if (relayed) {
			// Carry the stamped seq as explicit relay-frame metadata so the
			// receiving worker advances its delivered-seq tracker without
			// re-parsing the envelope string.
			batchRelay(topic, envelope, compress, seq);
		}
		if (wsDebug) {
			console.log('[ws] publish topic=%s event=%s bytes=%d delivered=%s',
				topic, event, envelope.length, result || relayed);
		}
		// In clustered mode, subscribers may be on other workers. Return true
		// when the relay fires even if the local worker has no subscribers,
		// because callers cannot query cross-worker subscriber counts.
		return result || relayed;
	},

	/**
	 * Send a message to a single WebSocket connection.
	 * Wraps in the same { topic, event, data } envelope as publish().
	 */
	send(ws, topic, event, data, options) {
		const payload = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		assert(payload.length > 0, 'envelope.send-empty', { topic, event });
		const compress = WS_COMPRESSION_ON && (!options || options.compress !== false);
		// `ws.send` throws on a freed native handle (callers may reach
		// here after an `await` that outlasted the socket). Return 2
		// (DROPPED, the uWS sentinel) so callers can pattern-match
		// without distinguishing closed from backpressure-dropped.
		let result;
		try { result = ws.send(payload, false, compress); }
		catch { counters.closedWsAborts++; return 2; }
		bumpOut(ws, payload);
		return result;
	},

	/**
	 * Publish via a plugin-declared binary wire codec. Binary-capable
	 * subscribers (those that advertised `wire.capability`) receive a `0x03`
	 * frame; everyone else receives the identical JSON envelope `publish()`
	 * would have sent. A connection whose stateful frame or wire-id announce
	 * was dropped by backpressure is degraded to the JSON envelope for this
	 * capability until reconnect (see poisonWireState). When no connected client advertises the capability - or
	 * the codec declines this frame (`encode` returns null) - this takes the
	 * exact single `app.publish` JSON fan-out with no per-subscriber walk, so a
	 * JSON-only deployment pays nothing for the binary machinery.
	 *
	 * The framework owns the `0x03 | schemaVersion | topicId | seq | payload`
	 * envelope; the plugin's `encode` produces only the payload. seq is stamped
	 * once and carried in both the JSON and binary forms so resume keeps working.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: (event: string, data: any) => (Uint8Array | null) }} wire
	 * @param {{ seq?: boolean, relay?: boolean, compress?: boolean, excludeWs?: import('uWebSockets.js').WebSocket<any> }} [options] -
	 *   `compress: true` opts this codec's frames (binary and JSON fallback) into
	 *   permessage-deflate when a compressor is configured; binary frames are
	 *   uncompressed by default (the cursor hot path leaves it off).
	 *   `excludeWs` withholds this publish from that one local socket on every
	 *   delivery path (binary frame, JSON fallback, JSON fast path) - the echo
	 *   suppression a publisher uses when its own client already holds the
	 *   state. Exclusion is local to this instance: the cross-worker relay
	 *   still fires exactly once, because the excluded socket cannot be
	 *   connected to any other instance.
	 * @returns {boolean}
	 */
	publishWire(topic, event, data, wire, options) {
		// Relay re-encode path: a sibling worker relayed this wire publish, carrying
		// the codec's capability + raw payload, and this worker re-encodes binary
		// against its OWN local connection state (relayPublishWire below). The origin
		// worker already counted the publish, stamped the seq, and recorded it as seen
		// (relayPublish -> recordSeen), so this path skips ALL origin-side bookkeeping
		// - the publish-rate counter, the per-topic stats, and the max-seen set - and
		// stamps the carried origin seq verbatim. This matches the non-wire relay path
		// (relayPublish -> app.publish), which likewise never re-counts a relayed
		// frame; counting it on every receiving worker would inflate one logical
		// publisher into N and trip the runaway-publisher signal.
		const isRelay = !!(options && options._isRelay);
		if (!isRelay) counters.publishCountWindow++;
		const seq = isRelay
			? (typeof options._relaySeq === 'number' ? options._relaySeq : null)
			: ((options && options.seq === false) ? null : nextTopicSeq(topicSeqs, topic));
		// Track the highest observed seq for this topic (see platform.publish).
		// Skipped on the relay path: relayPublish already called recordSeen with the
		// monotone-max guard the reorder-prone cross-worker receive path needs.
		if (!isRelay && seq !== null) maxSeenSeq.set(topic, seq);
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
		// A zero-length frame at a send site would broadcast garbage to every
		// subscriber - unrecoverable framing corruption. One length guard, identical
		// in cost to the assert it replaces.
		fatal(envelope.length > 0, 'envelope.empty', { topic, event });
		if (!isRelay) {
			let s = topicPublishStats.get(topic);
			if (!s) {
				s = { m: 0, b: 0 };
				topicPublishStats.set(topic, s);
				maybeWarnTopicRegistry();
			} else {
				assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape', { topic });
			}
			s.m++;
			s.b += envelope.length;
		}

		const relayed = !!(parentPort && (!options || options.relay !== false));

		// Binary codec frames (and this call's JSON-fallback frames) compress only
		// when the codec/plugin opts in with `{ compress: true }` AND a compressor
		// is configured. One decision governs the whole call so a plugin's intent
		// (cursor: off, the 60 Hz hot path; presence: on, a low-frequency roster)
		// applies to its binary and JSON-fallback frames alike. Off by default
		// keeps the hot path uncompressed.
		const compressIntent = !!(options && options.compress === true);
		const compress = WS_COMPRESSION_ON && compressIntent;

		// Codec-aware relay carry: a codec registered in the wire-codec registry
		// (presence, cursor) relays its capability + raw payload across the worker
		// boundary so a receiving worker with binary subscribers re-encodes binary
		// locally instead of delivering JSON ((N-1)/N of binary subs on an N-worker
		// box otherwise get JSON). An unregistered codec (smooth, crdt) relays the
		// JSON envelope only - exactly today's behavior, no extra IPC payload. The
		// registry IS the opt-in. Looked up only when actually relaying (clustered),
		// and the compress intent (not the locally-gated `compress`) rides along so a
		// re-encoded frame compresses the same way on the receiver, which re-gates by
		// its own compressor. The two declined-frame paths below relay envelope-only:
		// a stateless encode that returned null returns null on every worker too.
		const relayCap = relayed && getWireCodec(wire.capability) ? wire.capability : undefined;
		const relayEvent = relayCap !== undefined ? event : undefined;
		const relayData = relayCap !== undefined ? data : undefined;

		// Sender exclusion: when set, this one local socket must never receive
		// the frame. The single C++ app.publish fan-out cannot skip a socket,
		// so an excluding publish always takes the per-subscriber walk (the
		// walk already hands caps-less connections the identical JSON envelope).
		const excludeWs = (options && options.excludeWs) || null;

		// JSON fast path: no live connection wants binary for this codec. Byte-
		// and instruction-identical to platform.publish - a JSON-only deployment
		// never enters the per-subscriber walk or touches the codec at all.
		if (excludeWs === null && !capCounts.has(wire.capability)) {
			const result = app.publish(topic, envelope, false, compress);
			if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			return result || relayed;
		}

		const seqOnWire = seq == null ? 0 : seq;

		// Stateful codec (per-connection dictionary / apply-state): the encoded
		// payload depends on the recipient's state, so encode-once-send-many no
		// longer holds for the binary recipients - each capable connection is
		// encoded against its own state. Connections whose onAttach returned null
		// (e.g. an older client that negotiated the stateless schema) share one
		// encode at `wire.schemaVersion`, memoized by topic-id, so a mixed room
		// keeps the single-encode fan-out for those clients.
		if (wire.state) {
			let sharedPayload;
			let sharedEncoded = false;
			/** @type {Map<number, Uint8Array>} */
			const sharedFrameById = new Map();
			for (const ws of wsConnections) {
				if (ws === excludeWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has(wire.capability)) {
					try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
					continue;
				}
				const state = ensureWireState(ws, ud, wire);
				if (state == null) {
					// A poisoned capability is served exactly like a caps-less
					// connection: the shared JSON envelope, never binary (see
					// poisonWireState). Checked only on this null-state branch so
					// the per-connection hot path pays nothing for it.
					if (wireStatePoisoned(ud, wire.capability)) {
						try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
						continue;
					}
					// Shared encode-once at the codec's baseline schema version.
					if (!sharedEncoded) { sharedPayload = wire.encode(event, data, null); sharedEncoded = true; }
					if (sharedPayload == null) { try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; } continue; }
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						// Dropped wire-id announce: the client can never resolve
						// this topic's numeric id, so binary for this capability is
						// permanently undecodable here. JSON for this frame + poison.
						poisonWireState(ws, ud, wire.capability);
						try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
						continue;
					}
					let frame = sharedFrameById.get(id);
					if (!frame) { frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, sharedPayload); sharedFrameById.set(id, frame); }
					// A dropped shared frame needs no poisoning: the payload was
					// encoded against no per-connection state, so the client's
					// decoder stays in sync and the next frame is independent.
					try { ws.send(frame, true, compress); } catch { counters.closedWsAborts++; }
				} else {
					// Per-connection encode against this connection's state, stamped
					// with the schema version that state negotiated.
					const payload = wire.encode(event, data, state);
					if (payload == null) { try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; } continue; }
					const sv = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
					const id = ensureWireId(ws, ud, topic);
					if (id === -1) {
						// Dropped wire-id announce (see the shared branch above).
						// The encode already advanced this connection's codec state
						// for a frame that will never be sent, which is exactly the
						// desync poisoning exists for.
						poisonWireState(ws, ud, wire.capability);
						try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
						continue;
					}
					const frame = buildBinaryFrame(sv, id, seqOnWire, payload);
					let result;
					try { result = ws.send(frame, true, compress); } catch { counters.closedWsAborts++; continue; }
					// uWS send results: 0 = enqueued behind backpressure (delivers
					// in order - NOT a drop), 1 = sent, 2 = dropped past
					// maxBackpressure. The encode above already mutated this
					// connection's dictionary for the dropped frame, so the client
					// decoder can never catch up - degrade to JSON until reconnect.
					if (result === 2) poisonWireState(ws, ud, wire.capability);
				}
			}
			if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			return true;
		}

		// Stateless codec: encode once, send many. A null payload (the codec
		// declined this frame) falls through to the single C++ app.publish
		// fan-out, instruction-identical to platform.publish. The codec payload
		// is shared across recipients; only the tiny per-connection frame header
		// (topic-id + seq) differs, memoized per distinct id so the common
		// all-same-id case builds one frame and reuses it for every binary send.
		const payload = wire.encode(event, data);
		if (payload == null) {
			if (excludeWs === null) {
				const result = app.publish(topic, envelope, false, compress);
				if (relayed) batchRelay(topic, envelope, compressIntent, seq);
				return result || relayed;
			}
			// Declined frame with sender exclusion: the same JSON envelope the
			// single fan-out would have sent, delivered per subscriber so the
			// excluded socket is skipped.
			let delivered = false;
			for (const ws of wsConnections) {
				if (ws === excludeWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				try { ws.send(envelope, false, compress); delivered = true; } catch { counters.closedWsAborts++; }
			}
			if (relayed) batchRelay(topic, envelope, compressIntent, seq);
			return delivered || relayed;
		}

		// Shared binary fan-out: a stateless codec marked `shared: true` fans out via
		// cohort topics - the byte-identical 0x03 frame to `topic\0bin`, the JSON
		// envelope to `topic\0json` - so this publish is two native app.publish calls,
		// not a per-connection walk. Eligible only with no sender exclusion (a single
		// app.publish cannot skip one socket; an excluding shared publish falls through
		// to the walk below). The frame is identical for every binary subscriber
		// because the topic-id is the server-wide shared id, announced when a
		// connection joined the binary cohort.
		if (wire.shared && excludeWs === null) {
			// Lazy migration: the FIRST shared publish to a topic cohorts its current
			// subscribers (a one-time walk, paid once per topic), then marks the topic
			// shared so a later joiner is cohorted at subscribe time instead.
			if (!sharedTopics.has(topic)) {
				for (const ws of wsConnections) {
					let ud;
					try { ud = ws.getUserData(); } catch { continue; }
					const subs = ud[WS_SUBSCRIPTIONS];
					if (!subs || !subs.has(topic)) continue;
					joinSharedCohort(ws, ud, topic, wire.capability);
				}
				sharedTopics.set(topic, wire.capability);
			}
			const { bin, json } = cohortTopics(topic);
			// The binary cohort exists only if a capable client joined it (its
			// announce succeeded); otherwise this shared topic currently has only JSON
			// subscribers and skips the binary fan-out entirely.
			const id = getSharedWireId(topic);
			if (id !== undefined) {
				app.publish(bin, buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload), true, compress);
			}
			app.publish(json, envelope, false, compress);
			// Cross-worker subscribers: each receiving worker re-derives the shared
			// codec from its registry (relayPublishWire) and runs ITS OWN cohort split
			// with its own server-wide id, so the single-instance path needs no
			// cross-worker id sharing.
			if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			return true;
		}

		/** @type {Map<number, Uint8Array>} */
		const frameById = new Map();
		for (const ws of wsConnections) {
			if (ws === excludeWs) continue;
			let ud;
			try { ud = ws.getUserData(); } catch { continue; }
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || !subs.has(topic)) continue;
			const caps = ud[WS_CAPS];
			if (caps && caps.has(wire.capability) && !wireStatePoisoned(ud, wire.capability)) {
				const id = ensureWireId(ws, ud, topic);
				if (id === -1) {
					// Dropped wire-id announce: the topic-id mapping is itself
					// per-connection state the client now permanently lacks, so
					// even a stateless codec's frames would be undecodable. JSON
					// for this frame + poison. A dropped binary FRAME below needs
					// no such handling - the shared payload carries no
					// per-connection state, so a lost frame cannot desync.
					poisonWireState(ws, ud, wire.capability);
					try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
					continue;
				}
				let frame = frameById.get(id);
				if (!frame) {
					frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload);
					frameById.set(id, frame);
				}
				try { ws.send(frame, true, compress); } catch { counters.closedWsAborts++; }
			} else {
				try { ws.send(envelope, false, compress); } catch { counters.closedWsAborts++; }
			}
		}
		// Cross-worker subscribers with a binary capability for this codec re-encode
		// it locally on their worker (relayPublishWire); those without the capability,
		// and workers with no codec registered for it, receive the JSON envelope.
		if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
		if (wsDebug) {
			console.log('[ws] publishWire topic=%s event=%s payloadBytes=%d', topic, event, payload.length);
		}
		return true;
	},

	/**
	 * Register a plugin's wire codec under its capability so the cross-worker relay
	 * can re-derive it on a receiving worker and re-encode binary locally for that
	 * worker's binary-capable subscribers (see relayPublishWire). A plugin calls this
	 * the first time it publishes through a given platform - the platform is passed to
	 * the plugin per call, not at construction, so registration is lazy rather than at
	 * setup. Idempotent; the last registration for a capability wins. A no-op for a
	 * null codec or one with no string capability.
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any } | null} wire
	 */
	registerWireCodec(wire) {
		_registerWireCodec(wire);
	},

	/**
	 * Single-target send via a plugin-declared binary wire codec. The target
	 * receives a `0x03` frame when it advertised `wire.capability` and the
	 * codec can encode this frame; otherwise it receives the JSON envelope
	 * `send()` would have sent. No seq is stamped (matches `send()`); the
	 * binary frame carries seq 0 ("no seq"). Used for snapshot/catalog frames.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ capability: string, schemaVersion: number, encode: (event: string, data: any) => (Uint8Array | null) }} wire
	 * @param {{ compress?: boolean }} [options] - `{ compress: true }` opts this
	 *   low-frequency binary frame into permessage-deflate when a compressor is
	 *   configured (binary frames are uncompressed by default).
	 * @returns {number} uWS send status (0/1/2), or 2 on a freed handle
	 */
	sendWire(ws, topic, event, data, wire, options) {
		let ud;
		try { ud = ws.getUserData(); } catch { counters.closedWsAborts++; return 2; }
		const caps = ud[WS_CAPS];
		// Binary codec frames compress only when the codec/plugin opts in with
		// `{ compress: true }` AND a compressor is configured. The high-frequency
		// hot path (cursor) leaves this off; low-frequency frames (presence) opt in.
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		let payload = null;
		let schemaVersion = wire.schemaVersion;
		// A poisoned capability is served exactly like a caps-less connection:
		// the JSON envelope, never binary (see poisonWireState).
		if (caps && caps.has(wire.capability) && !wireStatePoisoned(ud, wire.capability)) {
			if (wire.state) {
				// Share the connection's codec state with publishWire so a
				// snapshot CATALOG interns ids the following BULK (and every
				// later broadcast) references against the same dictionary.
				const state = ensureWireState(ws, ud, wire);
				payload = wire.encode(event, data, state);
				if (state != null && typeof state.schemaVersion === 'number') schemaVersion = state.schemaVersion;
			} else {
				payload = wire.encode(event, data);
			}
		}
		if (payload == null) {
			const json = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
			let result;
			try { result = ws.send(json, false, compress); } catch { counters.closedWsAborts++; return 2; }
			bumpOut(ws, json);
			return result;
		}
		const id = ensureWireId(ws, ud, topic);
		if (id === -1) {
			// Dropped wire-id announce: the client can never resolve this
			// topic's numeric id, so binary for this capability is permanently
			// undecodable here. JSON for this frame + poison.
			poisonWireState(ws, ud, wire.capability);
			const json = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
			let result;
			try { result = ws.send(json, false, compress); } catch { counters.closedWsAborts++; return 2; }
			bumpOut(ws, json);
			return result;
		}
		const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
		let result;
		try { result = ws.send(frame, true, compress); } catch { counters.closedWsAborts++; return 2; }
		bumpOut(ws, frame);
		// 2 = dropped past maxBackpressure (0 = enqueued, NOT a drop). A
		// stateful encode already mutated this connection's dictionary for the
		// dropped frame, so degrade the capability to JSON until reconnect.
		// Stateless payloads carry no per-connection state - no poisoning.
		if (result === 2 && wire.state) poisonWireState(ws, ud, wire.capability);
		return result;
	},

	/**
	 * Send a message to a single connection with coalesce-by-key semantics.
	 *
	 * Each (ws, key) pair holds at most one pending message. If a newer
	 * sendCoalesced for the same key arrives before the previous one drains
	 * out to the wire, the older message is dropped in place: latest value
	 * wins, original insertion order is preserved.
	 *
	 * Use for latest-value streams where intermediate values are noise:
	 * price ticks, cursor positions, presence state, typing indicators,
	 * scroll/scrub positions. For at-least-once delivery use send() or
	 * publish() instead.
	 *
	 * Serialization is deferred to the actual flush, so a stream that
	 * overwrites the same key 1000 times before a single drain pays only
	 * one JSON.stringify, not 1000.
	 *
	 * The flush attempts immediately and again on every uWS drain event.
	 * On BACKPRESSURE or DROPPED from ws.send, pumping stops and resumes
	 * on the next drain.
	 */
	sendCoalesced(ws, { key, topic, event, data }) {
		let userData;
		try { userData = ws.getUserData(); }
		catch { counters.closedWsAborts++; return; }
		let pending = userData[WS_COALESCED];
		if (!pending) {
			pending = new Map();
			userData[WS_COALESCED] = pending;
		}
		assert(pending instanceof Map, 'coalesce.userdata-pending-type', null);
		// At cap with a brand-new key: drop the oldest insertion-order
		// entry. sendCoalesced is latest-value-wins by contract, so an
		// evicted oldest is simply a value the caller already replaced
		// with a fresher write under the same key (or, with unbounded
		// distinct keys, the caller is leaking and the oldest-pending
		// is the most stale value to lose).
		if (pending.size >= MAX_COALESCED_KEYS_PER_CONNECTION && !pending.has(key)) {
			const oldest = pending.keys().next().value;
			if (oldest !== undefined) pending.delete(oldest);
		}
		pending.set(key, { topic, event, data });
		flushCoalescedFor(ws);
	},

	/**
	 * Send a message to connections matching a filter.
	 * The filter receives each connection's userData (from the upgrade handler)
	 * and must return synchronously. An async filter is treated as
	 * fail-closed (the message is NOT sent to that connection) and a
	 * one-time warning is logged. Filters that touch a database or session
	 * store should resolve that data eagerly into `userData` from the
	 * `upgrade` hook, not from inside the filter.
	 *
	 * Returns the number of connections the message was sent to.
	 */
	sendTo(filter, topic, event, data, options) {
		const envelope = envelopePrefix(topic, event) + JSON.stringify(data ?? null) + '}';
		// Opt-in compression (default off): sendTo frames target a filtered
		// recipient set and are often one-off, so the safe default is
		// uncompressed. Pass { compress: true } to deflate for a large fan-out.
		// No-op while websocket.compression is off (the default).
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		let count = 0;
		for (const ws of wsConnections) {
			// uWS's close event fires synchronously and removes from
			// wsConnections before any user code runs, so under normal
			// flow every entry here is open. Defensive try/catch covers
			// pathological cases (e.g. user filter triggers a close via
			// side effect, or another worker raced through cleanup).
			let userData;
			try { userData = ws.getUserData(); }
			catch { counters.closedWsAborts++; continue; }
			const decision = filter(userData);
			if (decision && typeof decision.then === 'function') {
				if (!counters.sendToAsyncWarned) {
					counters.sendToAsyncWarned = true;
					console.error(
						'[ws] platform.sendTo filter returned a Promise; treating as fail-closed.\n' +
						'  Async filters cannot be used here because sendTo iterates every active\n' +
						'  connection synchronously. Resolve the relevant fields into userData from\n' +
						'  your `upgrade` hook so the filter can read them synchronously.\n' +
						'  See: https://svti.me/sendto-async'
					);
				}
				continue;
			}
			if (decision) {
				try { ws.send(envelope, false, compress); }
				catch { counters.closedWsAborts++; continue; }
				bumpOut(ws, envelope);
				count++;
			}
		}
		return count;
	},

	/**
	 * Number of active WebSocket connections.
	 */
	get connections() {
		return wsConnections.size;
	},

	/**
	 * Per-category counter of framework invariant violations. The
	 * returned value is the live `Map<string, number>` shared across
	 * the worker process - read-only, do not mutate. Categories follow
	 * a `<area>.<thing>` convention (e.g. `'envelope.malformed'`,
	 * `'ws.platform-missing'`, `'relay.topic-type'`).
	 *
	 * Most apps will see this map empty for the lifetime of the
	 * process; non-empty entries indicate a regression in the
	 * framework or a third-party plugin and should be reported as a
	 * GitHub issue with the category string. The structured
	 * `[adapter-uws/assert]` log lines accompanying each violation
	 * carry the context payload needed to reproduce.
	 *
	 * @returns {Map<string, number>}
	 */
	get assertions() {
		return readAssertionCounts();
	},

	/**
	 * Per-worker count of best-effort uWS operations that aborted
	 * because the underlying WebSocket had already closed.
	 *
	 * Ws-targeted platform methods (`subscribe`, `unsubscribe`, `send`,
	 * `sendCoalesced`, `sendTo`, `request`) and the wire-level
	 * subscribe / subscribe-batch handlers all swallow uWS's "Invalid
	 * access of closed uWS.WebSocket" exception so callers never need
	 * a per-site try/catch. Each swallow bumps this counter.
	 *
	 * A non-zero value is normal under churn (clients close mid-async-
	 * setup all the time). A rapidly-growing value under steady load
	 * indicates either pathological client behaviour or that the
	 * server's async setup path is too long for its connect rate -
	 * worth investigating but not, by itself, a bug.
	 *
	 * Monotonic, per-worker, reset only on process restart.
	 *
	 * @returns {number}
	 */
	get closedWsAborts() {
		return counters.closedWsAborts;
	},

	/**
	 * A PII-free snapshot of this worker's transport-layer health:
	 * connection count, backpressure posture, protection level, payload cap,
	 * and the framework-invariant counters. Counts and enums only - never a
	 * topic name, never a user id, never a socket handle. Pure read (a fresh
	 * plain object each call), so it is safe to expose behind an auth-gated
	 * admin route or feed to a dashboard.
	 *
	 * The scalar pressure signals are reported but `topPublishers` is omitted:
	 * topic names can embed ids, and this snapshot is PII-free by
	 * construction. An app that wants per-topic detail reads `pressure`
	 * directly with its own authorization.
	 *
	 * svelte-realtime's `introspect()` composes this under a `transport` key
	 * when the adapter platform provides it, so an app-level admin route
	 * surfaces the dispatch snapshot and this transport snapshot from one call.
	 *
	 * @returns {{
	 *   connections: number,
	 *   closedWsAborts: number,
	 *   protection: 'normal' | 'elevated' | 'siege',
	 *   maxPayloadLength: number,
	 *   pressure: { active: boolean, reason: string, value: number, subscriberRatio: number, publishRate: number, memoryMB: number },
	 *   assertions: Record<string, number>
	 * }}
	 */
	introspect() {
		const p = pressureSnapshot;
		return {
			connections: platform.connections,
			closedWsAborts: platform.closedWsAborts,
			protection: platform.protection,
			maxPayloadLength: platform.maxPayloadLength,
			pressure: {
				active: p.active,
				reason: p.reason,
				value: p.value,
				subscriberRatio: p.subscriberRatio,
				publishRate: p.publishRate,
				memoryMB: p.memoryMB
			},
			assertions: Object.fromEntries(platform.assertions)
		};
	},

	/**
	 * Number of clients subscribed to a specific topic.
	 */
	subscribers(topic) {
		return app.numSubscribers(topic);
	},

	/**
	 * Invoke `fn(ws, userData)` once for every connection currently
	 * subscribed to `topic`, on THIS instance. Where `subscribers(topic)`
	 * returns a count, this yields the sockets themselves so a plugin can
	 * make a per-subscriber decision the shared `publish` fan-out cannot:
	 * send a culled / per-viewport slice, skip a back-pressured consumer,
	 * or vary the payload per recipient.
	 *
	 * Cost is O(connections) and is paid only by the caller, so reserve it
	 * for topics that genuinely need per-subscriber treatment (a high-fan-
	 * out cursor topic with viewport culling); the zero-config publish path
	 * never calls it. The walk is synchronous and matches the subscriber
	 * walk `publishBatched` already performs; pair it with `platform.send`
	 * (closed-WS safe) and `platform.bufferedAmount` inside `fn`.
	 *
	 * Cluster note: each instance holds only its own connections, so this
	 * walks the local subscriber set. A topic whose subscribers span
	 * instances is handled per-instance - the same locality the Redis-
	 * backed cursor / presence variants already rely on.
	 *
	 * @param {string} topic
	 * @param {(ws: import('uWebSockets.js').WebSocket<any>, userData: any) => void} fn
	 * @returns {void}
	 */
	forEachSubscriber(topic, fn) {
		for (const ws of wsConnections) {
			const ud = ws.getUserData();
			const subs = ud[WS_SUBSCRIPTIONS];
			if (subs && subs.has(topic)) fn(ws, ud);
		}
	},

	/**
	 * The configured maximum size, in bytes, of a single inbound WebSocket
	 * frame. Frames larger than this are rejected by uWS at the protocol
	 * level (the connection is closed). Read this from server-side code
	 * (RPC frameworks, upload primitives, chunked stream protocols) to
	 * size payloads against the actual cap rather than guessing or
	 * piggybacking the value on the wire.
	 *
	 * Configured via `websocket.maxPayloadLength` in svelte.config.js;
	 * defaults to 1 MB.
	 *
	 * @example
	 * ```js
	 * // svelte-realtime live.upload sizing chunks below the cap:
	 * const chunkSize = Math.floor(platform.maxPayloadLength * 0.9);
	 * ```
	 */
	get maxPayloadLength() {
		return WS_OPTIONS?.maxPayloadLength ?? (1024 * 1024);
	},

	/**
	 * Bytes currently queued on `ws` that uWS has accepted but not yet
	 * flushed to the OS socket buffer. Returns 0 for closed connections.
	 *
	 * Use this for backpressure-aware sends (skip / coalesce / pace when
	 * the queue is large) and per-connection memory-pressure telemetry.
	 * Reads cleanly through `ws.getBufferedAmount()` - one C++ call,
	 * constant-time, safe to call on every send.
	 *
	 * @example
	 * ```js
	 * // Skip publish to slow consumer above 4 MB queued:
	 * if (platform.bufferedAmount(ws) > 4 * 1024 * 1024) return;
	 * platform.send(ws, topic, event, data);
	 * ```
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @returns {number}
	 */
	bufferedAmount(ws) {
		try { return ws.getBufferedAmount(); } catch { return 0; }
	},

	/**
	 * Subscribe a connection to a topic from server-side code, running the
	 * user's `hooks.ws.subscribe` authorization hook first.
	 *
	 * Use this from any server-side path that needs to subscribe a
	 * connection on the user's behalf - RPC handlers, framework
	 * integration layers, plugins - to inherit the centralized
	 * `hooks.ws.subscribe` authorization gate. Calling `ws.subscribe(topic)`
	 * directly bypasses the gate: the wire-level subscribe hook fires only
	 * for `{type:'subscribe'}` and `{type:'subscribe-batch'}` wire frames,
	 * not for direct uWS API calls. Always route server-initiated
	 * subscriptions through this method when centralized authorization
	 * matters (data-leak risk: the loader / RPC response runs before the
	 * client's eventual wire-level subscribe is denied).
	 *
	 * Returns `null` on success, or a denial reason string on failure
	 * (`'INVALID_TOPIC'`, `'RATE_LIMITED'`, `'FORBIDDEN'`, or any custom
	 * string returned from the user's subscribe hook). On denial, no
	 * subscription is created and internal subscription state is unchanged
	 * - the caller decides how to surface the denial to the client (e.g.
	 * an error reply on the RPC frame).
	 *
	 * Idempotent: calling `subscribe(ws, topic)` twice for the same
	 * `(ws, topic)` returns `null` both times and does not double-charge
	 * the per-worker `counters.totalSubscriptions` counter or trigger the hook a
	 * second time. The cap check fires only on the first subscribe.
	 *
	 * Updates `WS_SUBSCRIPTIONS` and `counters.totalSubscriptions` so observability
	 * (`platform.subscribers(topic)`, `platform.pressure`, the close-hook
	 * `subscriptions` set) stays consistent with client-initiated subscribe
	 * frames.
	 *
	 * Does NOT send a `{type:'subscribed', topic, ref}` ack frame - there
	 * is no client `ref` for a server-initiated subscribe. If the caller
	 * needs to inform the client of the subscription, that is an
	 * application-level concern (typically via the RPC response).
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {string | null} denial reason string or `null` on success
	 */
	async subscribe(ws, topic) {
		// Server-side caller: trust the topic shape past the
		// always-illegal control / quote / backslash bytes. Apps using
		// non-ASCII topic names (`__signal:Jose`, presence rooms with
		// localized labels) must not be blocked at the platform layer.
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		// `ws.getUserData()` throws on a freed native handle. RPC and
		// plugin code paths routinely `await` something else before
		// reaching here, so the WS may already be closed by the time
		// this runs. Treat as a silent no-op.
		let subs;
		try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
		catch { counters.closedWsAborts++; return null; }
		// The subscription slot is assigned a Set once at open and never reassigned;
		// a non-Set here is unrecoverable heap/dispatch corruption. One instanceof
		// guard, identical in cost to the assert it replaces. A freed handle is
		// caught above and returns early, so this only runs on a live connection.
		fatal(subs instanceof Set, 'subs.shape', null);
		if (subs.has(topic)) return null;
		if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
		const denial = await runUserSubscribeGate(ws, topic);
		if (denial !== null) return denial;
		// Re-check after the await: a concurrent subscribe (wire frame
		// or another platform.subscribe call) may have raced through
		// while we awaited the user hook. Idempotent ack and skip the
		// counter bump in that case.
		if (subs.has(topic)) return null;
		if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
		// `ws.subscribe()` throws if the socket closed during the await
		// above. Under mass-connect / backpressure churn this is the
		// dominant abort mode (10-15% of connections close mid-setup).
		// Swallow, count, and return success-shaped null so callers can
		// fire-and-forget without per-site try/catch.
		try { ws.subscribe(topic); }
		catch { counters.closedWsAborts++; return null; }
		subs.add(topic);
		counters.totalSubscriptions++;
		// Programmatic join of an already-shared topic cohorts the socket too.
		if (sharedTopics.has(topic)) joinSharedCohort(ws, ws.getUserData(), topic, sharedTopics.get(topic));
		return null;
	},

	/**
	 * Consult the user's subscribe-hook chain for a single topic without
	 * actually subscribing the connection. Returns `null` to allow or a
	 * string denial reason to deny.
	 *
	 * Use this when the caller wants to make the subscribe decision in one
	 * step and perform the actual `ws.subscribe` later as part of a
	 * different orchestration (e.g. an RPC framework that runs a loader
	 * between authorization and the subscribe, and wants the loader to
	 * fail cleanly without leaving a half-subscribed connection or a
	 * spurious 'join' broadcast).
	 *
	 * Mirrors the wire-level `subscribe-batch` precedence: if the user has
	 * exported `subscribeBatch`, that hook is consulted first (with the
	 * single topic in a 1-element array); otherwise the per-topic
	 * `subscribe` hook is consulted. A user who exports only one of the
	 * two still gets a consistent gate across single and batch entry
	 * points.
	 *
	 * Pure - does not modify subscription state, does not call
	 * `ws.subscribe`, does not increment `counters.totalSubscriptions`. The cap
	 * (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) is NOT consulted here because
	 * no subscription is being created; cap enforcement belongs on the
	 * actual subscribe action. If the caller plans to follow a `null`
	 * return with a `ws.subscribe`, route through `platform.subscribe`
	 * for atomic gate + subscribe + cap + state update instead.
	 *
	 * Async and fail-closed. A throwing (or rejecting) user hook denies
	 * with `'INTERNAL_ERROR'` rather than crashing the caller. Returns a
	 * `Promise` so async user hooks (typically those touching a database
	 * or session store) deny correctly when they return `false`.
	 *
	 * @example
	 * ```js
	 * // Inside a stream-RPC handler that needs to gate before running
	 * // the loader, and subscribe only if the loader succeeds:
	 * const denial = await platform.checkSubscribe(ws, topic);
	 * if (denial) return reply({ id, ok: false, error: denial });
	 * const initial = await loader(args, ws);
	 * ws.subscribe(topic);
	 * onJoin(ws, topic);
	 * reply({ id, ok: true, data: initial, topic });
	 * ```
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {Promise<string | null>} denial reason string or `null` on allow
	 */
	async checkSubscribe(ws, topic) {
		// Server-side caller: same trust as platform.subscribe (see
		// note there). Wire-side gating happens earlier in the message
		// handler with the strict ASCII-only default.
		if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
		return await runUserSubscribeGate(ws, topic);
	},

	/**
	 * Turn on wire-subscribe authorization for this process. Once enabled, a
	 * CLIENT-initiated `subscribe` / `subscribe-batch` frame is honored only
	 * for a topic the server already authorized for that connection via
	 * `platform.subscribe` (recorded in the connection's subscription set),
	 * unless the app exports its own `subscribe` / `subscribeBatch` hook - in
	 * which case that hook decides, exactly as today. Server-side
	 * `platform.subscribe` / `platform.checkSubscribe` are the trusted
	 * authorization path and are never gated by this.
	 *
	 * This is the programmatic equivalent of the `websocket.authorizeWireSubscribe`
	 * config flag, for a framework that owns subscription authorization and
	 * routes every legitimate subscribe through `platform.subscribe` (e.g.
	 * svelte-realtime, which resolves and gates each subscription in its stream
	 * RPC). Enabling it closes the bypass where a client sends a raw subscribe
	 * frame for a topic it was never granted - a private room, another tenant's
	 * channel - and receives that topic's fan-out, because the server-side
	 * guard ran only on the server-initiated subscribe, not the wire frame.
	 *
	 * Idempotent and process-wide (the flag lives in shared handler state, so
	 * one call from any connection's platform reference arms every connection).
	 * Call once at startup, before connections arrive - e.g. from a framework
	 * `init({ platform })` hook.
	 *
	 * @returns {void}
	 */
	authorizeWireSubscribe() {
		subscribeAuth.enabled = true;
	},

	/**
	 * Unsubscribe a connection from a topic from server-side code.
	 * Symmetric counterpart to `platform.subscribe()`.
	 *
	 * Idempotent: returns `false` if the connection was not subscribed to
	 * the topic, otherwise removes the subscription, decrements
	 * `counters.totalSubscriptions`, fires `hooks.ws.unsubscribe` (informational, not
	 * a gate - mirrors the wire-level unsubscribe path), and returns
	 * `true`.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {boolean} `true` if a subscription was removed
	 */
	unsubscribe(ws, topic) {
		// Closed sockets get an early-out: there is no subscription
		// state to remove, no uWS bookkeeping to drop, no informational
		// hook to fire. The platform contract is "best effort; no throw
		// on closed WS" - mirrors subscribe / send.
		let subs;
		try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
		catch { counters.closedWsAborts++; return false; }
		assert(subs instanceof Set, 'subs.shape-unsubscribe', null);
		if (!subs.has(topic)) return false;
		try { ws.unsubscribe(topic); }
		catch { counters.closedWsAborts++; return false; }
		subs.delete(topic);
		counters.totalSubscriptions--;
		assert(counters.totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions: counters.totalSubscriptions });
		if (sharedTopics.has(topic)) leaveSharedCohort(ws, ws.getUserData(), topic);
		wsModule.unsubscribe?.(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
		return true;
	},

	/**
	 * Publish multiple messages, returning per-message delivery results.
	 *
	 * NOT wire-level batching: under the hood this is a `for` loop calling
	 * `publish()` once per message, so N submitted messages still produce
	 * N WebSocket frames per subscribed connection. The cross-worker
	 * relay coalesces per microtask (one postMessage no matter how many
	 * publish() calls the loop makes), but the client still pays N
	 * onmessage dispatches.
	 *
	 * For one-frame-per-subscriber wire batching, use `publishBatched()`
	 * instead. Two distinct contracts:
	 *
	 * - `batch(messages)` -> N frames per subscriber, returns boolean[].
	 * - `publishBatched(messages)` -> 1 frame per subscriber (events array),
	 *   returns void; opt-in by client capability ('batch').
	 *
	 * @param {{ topic: string, event: string, data?: unknown }[]} messages
	 * @returns {boolean[]} publish result for each message (false = no subscribers)
	 */
	batch(messages) {
		const results = [];
		for (let i = 0; i < messages.length; i++) {
			const { topic, event, data } = messages[i];
			results.push(platform.publish(topic, event, data));
		}
		return results;
	},

	/**
	 * Publish a list of `{topic, event, data}` events as a single
	 * `{type:'batch',events:[...]}` WebSocket frame per affected
	 * subscriber. Each subscriber receives only the events whose topics
	 * are in their subscription set, in submitted order. Subscribers
	 * with no overlap with the batch's topics receive nothing.
	 *
	 * Compared to a `publish()` loop, the wire savings are
	 * one-frame-per-subscriber instead of N-frames-per-subscriber. The
	 * benefit grows with N (events per call) and with the
	 * subscriber-set overlap; tiny batches with disjoint topics may pay
	 * a small JS-fanout cost over the C++ TopicTree path used by
	 * `publish()` (the receiver decode is faster regardless).
	 *
	 * Capability gating: clients advertise `'batch'` support via a
	 * `{type:'hello', caps:['batch']}` frame after open. Connections
	 * that have not advertised the capability fall back to N
	 * individual frames automatically - mixing old and new clients in
	 * the same call is safe.
	 *
	 * Per-event seq stamping: every event in the batch is independently
	 * stamped with a per-topic monotonic seq, identical to `publish()`.
	 * Pass `{seq: false}` in an event's `options` to skip stamping for
	 * that one event.
	 *
	 * Cross-worker relay: events are relayed individually through the
	 * existing per-microtask relay path, so receiving workers see N
	 * relayed publishes (not a batched delivery). The wire-level
	 * batching applies to the originating worker's local fanout only.
	 * Pass `{relay: false}` in an event's `options` to skip the relay
	 * for messages that came from an external pub/sub source already
	 * fanning out to every worker.
	 *
	 * Frame-size budget: a batched frame larger than 256 KB triggers a
	 * throttled console warning (uWS per-message-deflate kicks in over
	 * a configurable threshold and large frames may surprise CPU
	 * budgets). Chunk large batches into multiple `publishBatched`
	 * calls to stay under the cap.
	 *
	 * Order guarantee: within one batched frame, events appear in call
	 * order. Across batches, same subscriber-side ordering as today.
	 *
	 * Coalesce interaction (v1): events submitted via `publishBatched`
	 * do NOT interact with `sendCoalesced` per-key replacement. The
	 * batch is delivered as-is, in submitted order, with no coalesce
	 * filtering. Mixing batched topics with sendCoalesced topics on
	 * the same subscriber is supported but the two paths produce
	 * separate frames.
	 *
	 * @example
	 * ```js
	 * platform.publishBatched([
	 *   { topic: 'org:42:items', event: 'updated', data: a },
	 *   { topic: 'org:42:items', event: 'updated', data: b },
	 *   { topic: 'org:42:audit', event: 'created', data: c }
	 * ]);
	 * // Subscribers of org:42:items only -> one frame, two events.
	 * // Subscribers of both topics      -> one frame, three events.
	 * // Subscribers of neither          -> no frame at all.
	 * ```
	 *
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: { relay?: boolean, seq?: boolean } }>} messages
	 * @returns {void}
	 */
	publishBatched(messages, options) {
		if (!Array.isArray(messages) || messages.length === 0) return;

		// Opt-in compression for the whole batch (default off). A batched frame
		// mixes event types, so the safe default is uncompressed; pass
		// { compress: true } to deflate. Applied uniformly to the fast (shared
		// frame) AND slow (per-event) paths so the two are consistent. No-op
		// while websocket.compression is off (the default).
		const compressOptIn = !!(options && options.compress === true);

		// Coalesce-by-key dedup runs first. Events that carry a
		// `coalesceKey` collapse so only the latest value per key
		// survives; events without a key pass through unchanged. This
		// is the same latest-value-wins primitive sendCoalesced offers
		// for streaming sends, lifted into the batched path so a single
		// publishBatched call carrying 100 cursor positions for the
		// same user delivers only the latest.
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;

		// Pick the fanout strategy before allocating per-event envelopes.
		// uWS's C++ TopicTree dispatch via app.publish is genuinely faster
		// than a JS-side per-subscriber loop for mixed-subscriber-set
		// batches; the wire-batching win is real only when every relevant
		// subscriber receives the same event slice. Two such cases:
		//
		//   1. Single-topic batch: every subscriber to that topic gets
		//      every event. Build one shared batch frame.
		//   2. All-see-all: a multi-topic batch where every connection
		//      subscribed to ANY batch topic is subscribed to ALL of
		//      them. Same shared-frame outcome.
		//
		// Otherwise we fall back to per-event publish() so the caller
		// pays no penalty for choosing publishBatched on small / disjoint
		// shapes (verified by `bench/27-publish-batched-ab.mjs`).
		const firstTopic = messages[0].topic;
		let allSameTopic = true;
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
		}

		// Combined detection pass: walk the subscriber set once to
		// determine whether the batch qualifies for the fast path
		// (single-topic or all-see-all) AND whether every interested
		// connection has advertised the 'batch' capability. We need
		// both: the shared-frame fast path is only safe when every
		// recipient can decode the {type:'batch',...} envelope.
		let allSeeAll = true;
		let everyoneCapable = true;
		/** @type {Set<string> | null} */
		let batchTopics = null;
		if (!allSameTopic) {
			batchTopics = new Set();
			for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
		}
		for (const ws of wsConnections) {
			const ud = ws.getUserData();
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || subs.size === 0) continue;
			let touchesAny = false;
			if (allSameTopic) {
				touchesAny = subs.has(firstTopic);
			} else {
				let touchesAll = true;
				for (const t of /** @type {Set<string>} */ (batchTopics)) {
					if (subs.has(t)) touchesAny = true;
					else touchesAll = false;
				}
				if (touchesAny && !touchesAll) { allSeeAll = false; break; }
			}
			if (!touchesAny) continue;
			const caps = ud[WS_CAPS];
			if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
		}

		// Slow-path fallback: per-event publish() so the caller pays
		// no penalty on small / disjoint shapes. Also the safe
		// degradation when any interested subscriber is non-cap-able -
		// they would otherwise receive an unparseable batch frame.
		if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				platform.publish(m.topic, m.event, m.data, { ...m.options, compress: compressOptIn });
			}
			return;
		}

		// Fast path: build per-event envelopes (also stamps seq + bumps
		// per-topic stats), wrap into a shared batch frame, and hand
		// fanout to uWS's C++ TopicTree via app.publish. In all-see-all
		// every interested subscriber is subscribed to every batch
		// topic, so dispatching on any one of them reaches them all.
		/** @type {Array<{ topic: string, env: string, seq: number | null }>} */
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			counters.publishCountWindow++;
			const seq = (m.options && m.options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, m.topic);
			// Track the highest observed seq per topic (see platform.publish).
			if (seq !== null) maxSeenSeq.set(m.topic, seq);
			const env = completeEnvelope(envelopePrefix(m.topic, m.event), m.data, seq);
			events[i] = { topic: m.topic, env, seq };
			let s = topicPublishStats.get(m.topic);
			if (!s) {
				s = { m: 0, b: 0 };
				topicPublishStats.set(m.topic, s);
				maybeWarnTopicRegistry();
			} else {
				assert(typeof s.m === 'number' && typeof s.b === 'number', 'topic.stats-shape-batch', { topic: m.topic });
			}
			s.m++;
			s.b += env.length;
		}

		// Cross-worker relay: a single 'publish-batched' IPC carrying the
		// pre-built per-event envelopes. The receiving worker re-runs the
		// detection (allSeeAll + everyoneCapable for ITS local subscriber
		// set) and dispatches via its own fast or slow path. This keeps
		// the wire-batching benefit cluster-wide instead of degrading to
		// per-event relays on worker boundaries.
		if (parentPort) {
			const relayed = [];
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				if (!m.options || m.options.relay !== false) {
					// Carry each event's stamped seq so the receiving worker
					// advances its delivered-seq tracker without re-parsing.
					relayed.push({ topic: events[i].topic, env: events[i].env, seq: events[i].seq });
				}
			}
			if (relayed.length > 0) {
				parentPort.postMessage({ type: 'publish-batched', events: relayed, compress: compressOptIn });
			}
		}

		// Build the shared batch frame once.
		const slice = new Array(events.length);
		for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
		const sharedBatchEnv = wrapBatchEnvelope(slice);
		assert(sharedBatchEnv.length > 0, 'envelope.batch-empty', { events: events.length });
		if (sharedBatchEnv.length > BATCH_FRAME_WARN_BYTES) {
			warnLargeBatchFrame(sharedBatchEnv.length);
		}

		// Hand fanout to uWS's C++ TopicTree. Any batch topic works
		// as the dispatch channel because every interested subscriber
		// is subscribed to every batch topic in the all-see-all case
		// (single-topic is the trivial sub-case).
		const fanoutTopic = allSameTopic ? firstTopic : messages[0].topic;
		const result = app.publish(fanoutTopic, sharedBatchEnv, false, WS_COMPRESSION_ON && compressOptIn);

		if (wsDebug) {
			console.log('[ws] publishBatched events=%d single-topic=%s fanoutTopic=%s delivered=%s',
				events.length, allSameTopic, fanoutTopic, result);
		}
	},

	/**
	 * Send a request to a single connection and await its reply.
	 *
	 * The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`,
	 * and the returned Promise resolves with whatever the client's
	 * `onRequest` handler returns (or rejects with the error string the
	 * client sent back if the handler threw). Rejects with `'request timed out'`
	 * after `timeoutMs` (default 5000), and with `'connection closed'`
	 * if the WebSocket closes before a reply arrives.
	 *
	 * Pending requests live in `WS_PENDING_REQUESTS` on `ws.getUserData()`,
	 * so cleanup is automatic on close - no module-level leak risk.
	 */
	request(ws, event, data, options) {
		let userData;
		try { userData = ws.getUserData(); }
		catch {
			counters.closedWsAborts++;
			return Promise.reject(new Error('connection closed'));
		}
		let pending = userData[WS_PENDING_REQUESTS];
		if (!pending) {
			pending = new Map();
			userData[WS_PENDING_REQUESTS] = pending;
		}
		assert(pending instanceof Map, 'request.pending-type', null);
		if (pending.size >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
			return Promise.reject(new Error(
				'pending requests exceeded ' + MAX_PENDING_REQUESTS_PER_CONNECTION +
				' on this connection'
			));
		}
		const ref = counters.nextRequestRef++;
		const timeoutMs = (options && options.timeoutMs) || 5000;
		return new Promise((resolve, reject) => {
			const timer = setTimer(() => {
				if (pending.delete(ref)) reject(new Error('request timed out'));
			}, timeoutMs);
			pending.set(ref, { resolve, reject, timer });
			const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
			try { ws.send(payload, false, false); }
			catch {
				counters.closedWsAborts++;
				clearTimer(timer);
				pending.delete(ref);
				reject(new Error('connection closed'));
				return;
			}
			bumpOut(ws, payload);
		});
	},

	/**
	 * Broadcast a request to EVERY connection subscribed to `topic` on this
	 * instance and collect their replies - the request/reply analog of
	 * `publish`. Each subscriber's client `onRequest` handler runs and its
	 * return value (or error) is gathered. Partial success is the contract: a
	 * subscriber that times out, errors, or whose socket closed lands in the
	 * result array as `{ ok: false, error }` and never fails the whole call.
	 *
	 * Returns one entry per subscribed socket, in iteration order -
	 * `{ ok: true, reply }` or `{ ok: false, error }`. `timeoutMs` (default
	 * 5000) bounds each request; since they run concurrently it is effectively
	 * the whole-fan-out budget.
	 *
	 * Single-instance: walks THIS worker's subscriber set. A topic whose
	 * subscribers span a cluster is handled per-instance (the cross-instance
	 * broadcast is the extensions layer's job) - the same locality
	 * `forEachSubscriber` and the Redis-backed primitives already rely on.
	 *
	 * @param {string} topic
	 * @param {string} event
	 * @param {any} data
	 * @param {{ timeoutMs?: number }} [options]
	 * @returns {Promise<Array<{ ok: true, reply: any } | { ok: false, error: string }>>}
	 */
	requestTopic(topic, event, data, options) {
		const timeoutMs = (options && options.timeoutMs) || 5000;
		const targets = [];
		for (const ws of wsConnections) {
			let ud;
			try { ud = ws.getUserData(); } catch { continue; }
			const subs = ud[WS_SUBSCRIPTIONS];
			if (subs && subs.has(topic)) targets.push(ws);
		}
		return Promise.all(targets.map((ws) =>
			platform.request(ws, event, data, { timeoutMs })
				.then((reply) => ({ ok: true, reply }))
				.catch((err) => ({ ok: false, error: (err && err.message) ? err.message : String(err) }))
		));
	},

	/**
	 * Live snapshot of worker-local backpressure signals.
	 *
	 * `reason` is one of `'NONE'`, `'PUBLISH_RATE'`, `'SUBSCRIBERS'`,
	 * `'MEMORY'`, `'CAPACITY'`. Precedence is fixed
	 * (MEMORY > CAPACITY > PUBLISH_RATE > SUBSCRIBERS), so a worker under
	 * multiple stresses reports the most urgent one. `'CAPACITY'` appears only
	 * when the protection posture is engaged (`elevated`/`siege`).
	 *
	 * Sampled by a coarse 1 Hz timer. Reading the snapshot is a property
	 * access; no I/O or computation per read. Use `onPressure` for
	 * push-style reaction on transitions.
	 */
	get pressure() {
		return pressureSnapshot;
	},

	/**
	 * Live protection posture: `'normal'`, `'elevated'`, or `'siege'`. Resolves
	 * the operator's `protection` setting against the current pressure; a pinned
	 * value reads back as itself, and an absent setting reads `'normal'`.
	 * Reading is a property access. Governs only NEW-upgrade admission; existing
	 * connections are never affected at any level.
	 */
	get protection() {
		return counters.activePosture !== null ? counters.activePosture.level : 'normal';
	},

	/**
	 * The metrics registry configured via `websocket.metrics` (a module path
	 * whose default export is the registry), or `null` when unset. The adapter
	 * populates it with admission/posture instruments; expose its
	 * Prometheus-text output from a scrape route, e.g.
	 * `new Response(platform.metrics.serialize())`. Reading this is how an app
	 * route reaches the SAME registry instance the runtime writes to - importing
	 * the metrics module again from app code would create a second, empty copy.
	 */
	get metrics() {
		return metricsRegistry;
	},

	/**
	 * Register a callback fired on each pressure-state transition (when
	 * `reason` changes between samples). Fired at most once per sample
	 * tick. Returns an unsubscribe function.
	 *
	 * Callbacks are invoked synchronously inside the sampler. A throwing
	 * listener does not break the sampler or other listeners; the error
	 * is logged and the next listener still runs.
	 */
	onPressure(cb) {
		pressureListeners.add(cb);
		return () => pressureListeners.delete(cb);
	},

	/**
	 * Register a callback fired once per sample window with the list of
	 * topics whose publish rate has crossed `topicPublishRatePerSec` or
	 * `topicPublishBytesPerSec` for that window. Each entry is
	 * `{ topic, messagesPerSec, bytesPerSec }`. Use this to log,
	 * page on-call, or apply a per-topic backpressure response.
	 *
	 * Registering at least one callback suppresses the default
	 * throttled `console.warn` output - the user owns the surface.
	 * Returns an unsubscribe function.
	 *
	 * @param {(events: TopicPublishRate[]) => void} cb
	 */
	onPublishRate(cb) {
		publishRateListeners.add(cb);
		return () => publishRateListeners.delete(cb);
	},

	/**
	 * Get a scoped helper for a topic - less repetition when publishing
	 * multiple events to the same topic.
	 */
	topic(name) {
		return createScopedTopic(platform.publish, name);
	},

	/**
	 * Current generation of a topic's seq space. The value a reconnecting
	 * client presents on resume is compared against this to decide whether
	 * its old per-topic offset is still valid (gap-fill) or points into a
	 * seq space that has since reset (cold-rehydrate).
	 *
	 * In a single worker the seq counters live in process memory and all
	 * reset together on a restart, so every topic shares the one
	 * per-process generation. A backend with its own per-topic seq
	 * authority (a shared store) overrides this with a per-topic value of
	 * the same shape.
	 *
	 * @param {string} topic
	 * @returns {number}
	 */
	topicEpoch(topic) {
		void topic;
		return processEpoch();
	},

	// Clock and RNG exposed through the same injectable runtime module the
	// adapter itself reads, so plugins and app code share one swappable source
	// a controlled harness can seed. Plain references to the imported helpers;
	// per-connection/request platform clones inherit them via the prototype.
	now: now,
	monotonic: monotonicNow,
	random: {
		float: randomFloat,
		u32: randomU32,
		uuid: randomUuid,
		bytes: randomBytes
	},
	// Causal stamp for events that must order consistently across workers
	// (or across a coarse / briefly-backward wall clock). Reads the injectable
	// runtime clock for its wall component and keeps it non-decreasing with a
	// logical tiebreaker. Only called when an event needs a stamp, so the
	// per-publish hot path stays untouched.
	hlc: readHlc
};

/**
 * Codec-aware relay re-encode. A sibling worker relayed a wire publish, carrying
 * the codec's `capability` and `{ event, data }` alongside the JSON envelope. When
 * this worker has the codec registered AND a local connection advertises the
 * capability, re-encode binary locally by re-entering publishWire with the origin's
 * seq (no re-stamp), `relay: false` (no re-relay loop), and the origin's compress
 * intent (re-gated by this worker's own compressor). publishWire then fans binary
 * out to this worker's capable subscribers (per-connection for a stateful codec,
 * once for a stateless one) and the JSON envelope to the rest.
 *
 * Returns false - the caller (relayPublish) then takes the single `app.publish`
 * JSON fan-out - when no codec is registered for the capability or no local
 * connection advertises it. The no-local-subscriber worker thus stays on the
 * cheaper envelope path (today's behavior) instead of entering the per-subscriber
 * walk just to hand everyone JSON.
 *
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {string} capability
 * @param {number | null} seq - The origin worker's stamped per-topic seq, carried verbatim.
 * @param {boolean} [compress] - The origin's compress intent (re-gated locally).
 * @returns {boolean}
 */
export function relayPublishWire(topic, event, data, capability, seq, compress) {
	const codec = getWireCodec(capability);
	if (!codec) return false;
	if (!capCounts.has(capability)) return false;
	platform.publishWire(topic, event, data, codec, { relay: false, _isRelay: true, _relaySeq: seq, compress });
	return true;
}
