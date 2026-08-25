// Substituted by the adapter's build step; a free identifier until then.
/* global WS_OPTIONS */
import { wsModule } from '../ws-handler-bridge.js';
import { metricsRegistry } from '../metrics-bridge.js';
import { metricsSnapshot } from './metrics-snapshot.js';
import { isWarmupRequest } from './warmup-registry.js';
import { parentPort } from 'node:worker_threads';
import { exceedsSubscriptionCap, exceedsPendingSubscribeCap, deniesUngrantedObserve } from '../utils/subscribe-policy.js';
import { MAX_COALESCED_KEYS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_SUBSCRIPTIONS_PER_CONNECTION, WS_ATTRIBUTION, WS_CAPS, WS_COALESCED, WS_PENDING_REQUESTS, WS_PLATFORM, WS_PUBLISH_GRANT, WS_REVOKED_UNSUBSCRIBE, WS_SUBSCRIPTIONS, assert, fatal, beginPendingSubscribe, pendingSubscribeTotal, settlePendingSubscribe, settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership, collapseByCoalesceKey, completeEnvelope, completeGameEnvelope, createScopedTopic, createTopicHelperCache, isValidWireTopic, processEpoch, readAssertionCounts, stampSeqValue, throwInvalidSeq, tombstonePendingSubscribe, releaseDerivedSubscriptions, addLogicalSubscription, removeLogicalSubscription, wrapBatchEnvelope } from '../utils.js';
import { egressGate, resolvePublishTenant, admitPublishEgress, admitTopicEgress, admitTenantEgress, chargePublishEgress, chargeDirectEgress, excludedRecipient, binaryFrameChargeBytes, envelopeWireBytes, EGRESS_ADMITTED } from './egress-budget.js';
import { buildBinaryFrame } from '../wire.js';
import { now, monotonicNow, clearTimer, setTimer, randomBytes, randomFloat, randomU32, randomUuid } from '../runtime.js';
import { capCounts, captureResumeFrame, counters, maxSeenSeq, divergenceDiagnostics, pressureListeners, pressureSnapshot, publishRateListeners, recordSeen, recordStampedSeen, resumeBuffers, sharedTopics, subscribeAuth, topicSeqs, topicSubscriberCounts, wsConnections } from './state.js';
import { app, wsDebug, WS_COMPRESSION_ON, ALLOW_NON_ASCII_TOPICS } from './config.js';
import { envelopePrefix } from './envelope-cache.js';
import { batchRelay, relayBatched } from './relay.js';
import { readHlc } from './hlc.js';
import { BATCH_FRAME_WARN_BYTES, bumpOut, warnLargeBatchFrame } from './pressure-metrics.js';
import { flushCoalescedFor, runUserSubscribeGate, hasUserSubscribeHook } from './subscribe-hooks.js';
import { ensureWireId, ensureWireState, poisonWireState, wireStatePoisoned } from './wire-state.js';
import { GAME_FANOUT_CAP, GAME_FANOUT_SCHEMA_VERSION, encodeGameFanoutPayload, assertGameLaneClusterSafe } from './game-ingress.js';
import { assertClusterSequenceAuthority, assertClusterSequenceAuthorityValues, assertBatchSequenceAuthority, assertBatchEntrySequenceAuthority } from './cluster-sequence-policy.js';
import { registerWireCodec as _registerWireCodec, getWireCodec } from './codec-registry.js';
import { cohortTopics, joinSharedCohort, leaveSharedCohort } from './cohort.js';
import { getSharedWireId, sharedWireIdRefs } from './shared-wire-id.js';
import { deliverStatefulWireBatch, deliverStatelessWireFanout, encodeStatelessWirePayload } from './wire-fanout.js';
import { runtimeVersionInfo } from '../version-info.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorMessage } from '../error-registry.js';
import { seqBound } from './seq-bound.js';
import { privateValueMetadata } from '../utils/observability-privacy.js';
import { activeTraceContext, trace } from '../tracing.js';

// Lazily-built LRU cache of scoped topic helpers, bound to platform.publish once
// on first platform.topic() call (platform.publish exists by then). Reuses one
// helper object per topic name instead of allocating a fresh one each call.
/** @type {((name: string) => ReturnType<typeof createScopedTopic>) | null} */
let _topicHelperCache = null;

/**
 * Wire bytes for `recipients` copies of one JSON envelope. Measured exactly
 * only while a BYTES ceiling is armed: the exact measurement walks the
 * envelope, so paying it with nothing deciding on the result would tax every
 * publish on a server that configured no budget - or configured one that
 * counts messages rather than bytes. See `envelopeWireBytes`.
 *
 * @param {string} envelope
 * @param {number} recipients
 * @returns {number}
 */
function chargeableBytes(envelope, recipients) {
	return envelopeWireBytes(envelope, recipients, egressGate.bytesArmed);
}

/**
 * The whole-batch egress decision, taken before any entry is stamped or sent.
 *
 * Every topic in the batch admits its own share, and every tenant admits ONCE
 * against the pooled weight of the topics it owns here - asking per topic
 * against a window nothing has charged yet would let a batch spanning N topics
 * of one tenant pass N times against the same allowance. One refusal refuses
 * the whole batch: a batch that delivered a prefix and refused the tail would
 * be the mid-batch shedding this budget forbids.
 *
 * `sharedRecipients` is the recipient count every entry shares (the all-see-all
 * fast path dispatches on one topic); pass null to read each topic's own count.
 *
 * @param {Array<{ topic: string }>} messages
 * @param {number | null} sharedRecipients
 * @returns {boolean}
 */
function admitBatchEgress(messages, sharedRecipients) {
	/** @type {Map<string, number>} */
	const perTopic = new Map();
	for (let i = 0; i < messages.length; i++) {
		perTopic.set(messages[i].topic, (perTopic.get(messages[i].topic) || 0) + 1);
	}
	/** @type {Map<string, { m: number, d: number, topic: string }> | null} */
	const perTenant = egressGate.tenantArmed ? new Map() : null;
	for (const [t, c] of perTopic) {
		const recipients = sharedRecipients === null ? (topicSubscriberCounts.get(t) || 0) : sharedRecipients;
		const deliveries = c * recipients;
		if (!admitTopicEgress(t, c, deliveries)) return false;
		if (perTenant === null) continue;
		const ten = resolvePublishTenant(t);
		if (ten === null) continue;
		const agg = perTenant.get(ten);
		if (agg === undefined) perTenant.set(ten, { m: c, d: deliveries, topic: t });
		else { agg.m += c; agg.d += deliveries; }
	}
	if (perTenant !== null) {
		for (const [ten, agg] of perTenant) {
			if (!admitTenantEgress(ten, agg.topic, agg.m, agg.d)) return false;
		}
	}
	return true;
}

/** @type {import('../../index.js').Platform} */
export const platform = {
	/**
	 * The active operation context, or the connection context outside an active
	 * child operation. AsyncLocalStorage keeps concurrent RPCs on one socket
	 * isolated; the per-connection fallback is inherited by Platform clones.
	 */
	get traceContext() {
		return activeTraceContext() ?? this.connectionTraceContext ?? null;
	},

	// One frozen vendor-neutral tracing surface shared by every Platform clone.
	// Providers are configured at build time; without one its run() path is a
	// direct callback and current() remains null.
	trace,

	// The observer lane's deny-unwind (authorizeDerivedSubscribe) runs the
	// app's unsubscribe hook through this slot - the shared primitive has no
	// module reference to wsModule. Symbol-keyed: invisible to Object.keys /
	// JSON / spread, unreachable from wire input. See WS_REVOKED_UNSUBSCRIBE.
	[WS_REVOKED_UNSUBSCRIBE](ws, topic, ud) {
		wsModule.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
	},
	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 * Auto-wraps in a { topic, event, data } envelope that the client store understands.
	 * No-op if no clients are subscribed - safe to call unconditionally.
	 */
	publish(topic, event, data, options) {
		// One read per option field, before anything judges them. The value the
		// authority check refuses and the value the stamp uses must be the SAME
		// read: an options object with a stateful `seq` accessor could otherwise
		// answer the check with `false` and hand the stamp a number - accepted,
		// stamped, and relayed, the exact combination the check exists to refuse.
		// The batch lane already follows this one-read rule; locals keep this
		// hottest lane allocation-free.
		const seqOption = options != null ? options.seq : undefined;
		const relayOption = options != null ? options.relay : undefined;
		const compressOption = options != null ? options.compress : undefined;
		const jitterOption = options != null ? options.jitterMs : undefined;
		assertClusterSequenceAuthorityValues(seqOption, relayOption);
		// Egress recipients are the topic's local native subscribers, read once
		// per logical publish; the ceiling decision runs BEFORE the sequence is
		// stamped, so a refused publish leaves no client-visible seq gap and
		// nothing reaches the native layer or the relay.
		const recipients = topicSubscriberCounts.get(topic) || 0;
		let egressTenant = null;
		if (egressGate.armed) {
			egressTenant = resolvePublishTenant(topic);
			// EGRESS_ADMITTED marks an event whose batch already decided for
			// the whole call (publishBatched's slow path). It still charges
			// below - every event is its own logical publish in the ledger -
			// but re-deciding here would deliver a prefix of an atomic batch.
			if (!(options != null && options[EGRESS_ADMITTED]) &&
				!admitPublishEgress(topic, egressTenant, 1, recipients)) return false;
		}
		counters.publishCountWindow++;
		const seq = stampSeqValue(seqOption, topicSeqs, topic, seqBound);
		// Record the highest seq this worker has observed for the topic. An
		// in-memory counter seq is freshly stamped and monotonic, so it skips the
		// compare; an explicit numeric seq is cluster-authoritative, interleaves
		// across workers on arrival, and so goes through the monotone-max guard (a
		// bare set could regress the local max and fabricate a divergence). Both
		// arms report a new topic to the registry bound, which is what keeps the
		// observed registry under the same ceiling as the counter registry.
		// Skipped when stamping is off so a {seq:false}-only topic never enters
		// the convergence comparison.
		if (seq !== null) {
			if (typeof seqOption === 'number') recordSeen(maxSeenSeq, topic, seq, seqBound);
			else recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
		}
		// `{ jitterMs }` de-herd window: stamp it on the frame so each client rolls its
		// own delay before dispatching (spreads N receivers' follow-up actions across
		// the window). The window is carried verbatim - NOT a server-rolled offset,
		// which would defer every subscriber of this one frame identically.
		const jitterMs = (typeof jitterOption === 'number' && jitterOption > 0) ? jitterOption : null;
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq, jitterMs);
		// A zero-length frame at a send site would broadcast garbage to every
		// subscriber - unrecoverable framing corruption. One length guard, identical
		// in cost to the assert it replaces.
		fatal(envelope.length > 0, 'envelope.empty', null);
		// The one egress charge for this logical publish: per-topic runaway
		// stats, worker window counters, and the ceiling account. Wire bytes
		// are the envelope's UTF-8 encoding times the local recipients.
		chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
		// Compress this text frame when a compressor is configured; opt out per
		// call with `{ compress: false }` (e.g. a very high-rate text topic where
		// the per-subscriber deflate CPU would outweigh the bandwidth saving).
		const compress = WS_COMPRESSION_ON && compressOption !== false;
		// A connection still gap-filling this topic (a resume cutover in flight) is
		// not yet subscribed to live, so hold this frame in its buffer to flush once
		// it subscribes - otherwise a publish landing inside the async resume window
		// is lost. Empty in the common case: one size check guards the hot path.
		if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope, compress);
		const result = app.publish(topic, envelope, false, compress);
		counters.publishOutcomeHook?.(result);
		// Relay to other workers via main thread (no-op in single-process mode).
		// Pass { relay: false } when the message originates from an external
		// pub/sub source (Redis, Postgres, etc.) that already fans out to
		// every process - relaying would cause duplicate delivery.
		const relayed = !!(parentPort && relayOption !== false);
		if (relayed) {
			// Carry the stamped seq as explicit relay-frame metadata so the
			// receiving worker advances its delivered-seq tracker without
			// re-parsing the envelope string.
			batchRelay(topic, envelope, compress, seq);
		}
		if (wsDebug) {
			console.log('[ws] publish topicRef=%s eventRef=%s bytes=%d delivered=%s',
				privateValueMetadata(topic, 'topic').ref,
				privateValueMetadata(event, 'event').ref,
				envelope.length, result || relayed);
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
		assert(payload.length > 0, 'envelope.send-empty', null);
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
		// One read per option field (see platform.publish): the field set here
		// additionally carries the internal relay-receive markers, which must
		// keep working for the cross-worker path. Locals, no capture object.
		const seqOption = options != null ? options.seq : undefined;
		const relayOption = options != null ? options.relay : undefined;
		const compressOption = options != null ? options.compress : undefined;
		const excludeOption = options != null ? options.excludeWs : undefined;
		const isRelay = !!(options && options._isRelay);
		const relaySeqOption = isRelay ? options._relaySeq : undefined;
		// The authority check keeps its own statement, in the canonical one-line
		// form the policy pin greps for: it is the security-relevant guard, and
		// what follows it here is accounting.
		if (!isRelay) assertClusterSequenceAuthorityValues(seqOption, relayOption);
		// Egress recipients and admission, origin-side only: a relayed frame was
		// charged once on the worker that published it, and refusing it here
		// would fork the cluster's delivery. The decision runs before the stamp,
		// exactly as in publish(); an excluded socket that holds the topic is
		// not a recipient.
		let recipients = 0;
		let egressTenant = null;
		if (!isRelay) {
			recipients = topicSubscriberCounts.get(topic) || 0;
			if (excludeOption !== undefined && excludeOption !== null && excludedRecipient(excludeOption, topic)) recipients--;
			if (egressGate.armed) {
				egressTenant = resolvePublishTenant(topic);
				// EGRESS_ADMITTED marks an entry whose batch already took the
				// decision for the whole call (publishWireBatch's stateless
				// lane). It still charges below - every entry is its own
				// logical publish in the ledger - but re-deciding here would
				// let a batch deliver a prefix and refuse the rest.
				if (!(options && options[EGRESS_ADMITTED]) &&
					!admitPublishEgress(topic, egressTenant, 1, recipients)) return false;
			}
			counters.publishCountWindow++;
		}
		const seq = isRelay
			? (typeof relaySeqOption === 'number' ? relaySeqOption : null)
			: stampSeqValue(seqOption, topicSeqs, topic, seqBound);
		// Track the highest observed seq for this topic (see platform.publish). An
		// explicit numeric seq takes the monotone-max guard; the in-memory counter
		// skips the compare and keeps the membership report. Skipped on the relay
		// path: relayPublish already called recordSeen with the guard the
		// reorder-prone cross-worker receive path needs.
		if (!isRelay && seq !== null) {
			if (typeof seqOption === 'number') recordSeen(maxSeenSeq, topic, seq, seqBound);
			else recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
		}
		const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
		// A zero-length frame at a send site would broadcast garbage to every
		// subscriber - unrecoverable framing corruption. One length guard, identical
		// in cost to the assert it replaces.
		fatal(envelope.length > 0, 'envelope.empty', null);
		const relayed = !!(parentPort && relayOption !== false);

		// Binary codec frames (and this call's JSON-fallback frames) compress only
		// when the codec/plugin opts in with `{ compress: true }` AND a compressor
		// is configured. One decision governs the whole call so a plugin's intent
		// (cursor: off, the 60 Hz hot path; presence: on, a low-frequency roster)
		// applies to its binary and JSON-fallback frames alike. Off by default
		// keeps the hot path uncompressed.
		const compressIntent = compressOption === true;
		const compress = WS_COMPRESSION_ON && compressIntent;

		// A connection still gap-filling this topic (resume cutover in flight) is not
		// yet subscribed to live, so hold the JSON envelope it would receive as a
		// caps-less subscriber; it flushes on subscribe. One guarded size check.
		if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope, compress);

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
		const excludeWs = excludeOption || null;

		// JSON fast path: no live connection wants binary for this codec. Byte-
		// and instruction-identical to platform.publish - a JSON-only deployment
		// never enters the per-subscriber walk or touches the codec at all.
		if (excludeWs === null && !capCounts.has(wire.capability)) {
			// The one egress charge for this logical publish (origin side only):
			// every recipient gets the JSON envelope here.
			if (!isRelay) chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
			const result = app.publish(topic, envelope, false, compress);
			counters.publishOutcomeHook?.(result);
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
			// The one egress charge for this logical publish. A stateful codec's
			// frames are recipient-specific (each connection's dictionary shapes
			// its own bytes), so the JSON envelope is the charged per-recipient
			// size for this lane - the stable serialized form every degraded
			// recipient actually receives.
			if (!isRelay) chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
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
		const payload = encodeStatelessWirePayload(wire, event, data);
		if (payload == null) {
			// The codec declined this frame: every recipient gets the JSON
			// envelope, on the single fan-out or the excluding walk alike.
			if (!isRelay) chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
			if (excludeWs === null) {
				const result = app.publish(topic, envelope, false, compress);
				counters.publishOutcomeHook?.(result);
				if (relayed) batchRelay(topic, envelope, compressIntent, seq);
				return result || relayed;
			}
			// Declined frame with sender exclusion: the same JSON envelope the
			// single fan-out would have sent, delivered per subscriber so the
			// excluded socket is skipped.
			const delivered = deliverStatelessWireFanout(wire, payload, {
				topic, envelope, seq: seqOnWire, excludeWs, connections: wsConnections,
				ensureId: ensureWireId, isPoisoned: wireStatePoisoned,
				poison: poisonWireState, compress, counters
			});
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
			// The one egress charge for this logical publish, split by cohort:
			// the binary cohort is charged its 0x03 frame, everyone else the
			// envelope. The binary-cohort size is the shared wire-id refcount
			// (one reference per cohorted socket), so the split is exact
			// without a walk or a native read.
			if (!isRelay) {
				const binCount = Math.min(sharedWireIdRefs(topic), recipients);
				chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length,
					binaryFrameChargeBytes(payload.length, seqOnWire) * binCount + chargeableBytes(envelope, recipients - binCount));
			}
			// The binary cohort exists only if a capable client joined it (its
			// announce succeeded); otherwise this shared topic currently has only JSON
			// subscribers and skips the binary fan-out entirely.
			const id = getSharedWireId(topic);
			if (id !== undefined) {
				const binaryResult = app.publish(bin, buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload), true, compress);
				counters.publishOutcomeHook?.(binaryResult);
			}
			const jsonResult = app.publish(json, envelope, false, compress);
			counters.publishOutcomeHook?.(jsonResult);
			// Cross-worker subscribers: each receiving worker re-derives the shared
			// codec from its registry (relayPublishWire) and runs ITS OWN cohort split
			// with its own server-wide id, so the single-instance path needs no
			// cross-worker id sharing.
			if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
			return true;
		}

		// The one egress charge for this logical publish. Once a live connection
		// advertises this codec's capability, the walk's encoded form is the
		// binary frame and the charge reflects it for every recipient (a mixed
		// room's JSON-degraded members ride at the same charged size - the
		// documented approximation that keeps the charge O(1)); with no capable
		// connection the walk exists only for the exclusion and every recipient
		// gets the envelope.
		if (!isRelay) {
			const wireBytes = capCounts.has(wire.capability)
				? binaryFrameChargeBytes(payload.length, seqOnWire) * recipients
				: chargeableBytes(envelope, recipients);
			chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, wireBytes);
		}
		deliverStatelessWireFanout(wire, payload, {
			topic, envelope, seq: seqOnWire, excludeWs, connections: wsConnections,
			ensureId: ensureWireId, isPoisoned: wireStatePoisoned,
			poison: poisonWireState, compress, counters
		});
		// Cross-worker subscribers with a binary capability for this codec re-encode
		// it locally on their worker (relayPublishWire); those without the capability,
		// and workers with no codec registered for it, receive the JSON envelope.
		if (relayed) batchRelay(topic, envelope, compressIntent, seq, relayCap, relayEvent, relayData);
		if (wsDebug) {
			console.log('[ws] publishWire topicRef=%s eventRef=%s payloadBytes=%d',
				privateValueMetadata(topic, 'topic').ref,
				privateValueMetadata(event, 'event').ref,
				payload.length);
		}
		return true;
	},

	/**
	 * Multi-entry fan-out via a stateful plugin codec: one tick's same-event
	 * updates delivered as ONE binary frame per capable connection (the
	 * codec's `<event>-batch` form) and as the per-entry JSON envelopes -
	 * byte-identical to N publishWire calls - for everyone else. Each entry
	 * may carry its own `excludeWs` (per-entry author suppression); an entry
	 * is withheld from its excluded socket on every delivery path.
	 *
	 * Sequencing, accounting, and the cross-worker relay match N publishWire
	 * calls exactly: one seq per entry, one relay envelope per entry,
	 * per-entry publish stats. The binary batch frame's header seq slot
	 * carries the subset's LAST entry seq (batch consumers order by the
	 * codec's own stamp, not the header seq).
	 *
	 * An entry may carry its own explicit `seq` - the cluster-authoritative
	 * number a replay backend already allocated for that frame - exactly as
	 * the same value would ride `publishWire({ seq: N })`, and it takes the
	 * same rules: a NUMBER must be a positive integer or the batch refuses,
	 * and on a multi-worker runtime it additionally requires `relay: false`
	 * (with the batch options saying `{ seq: false }` - options renounce the
	 * counter, entries carry the authority). A non-number entry `seq` falls
	 * through to the shared options, exactly as it would on publishWire's own
	 * options object; entries without one draw from the shared options as
	 * before: the counter, or nothing under `{ seq: false }`. All numeric
	 * per-entry seqs are validated in the snapshot pass BEFORE anything is
	 * stamped, serialised, or fanned out - whole batch or nothing, so a
	 * mid-batch refusal cannot leave earlier entries already delivered. A
	 * batch-level numeric `options.seq` stays refused outright: one number
	 * cannot be one-seq-per-entry.
	 *
	 * Degradation mirrors publishWire per connection: a codec that cannot
	 * represent the batch (null) falls back to per-entry encodes; a per-entry
	 * null falls back to that entry's JSON envelope; a dropped frame or
	 * wire-id announce poisons the capability to JSON until reconnect. Not a
	 * relay input: the cross-worker receive path re-encodes per entry through
	 * publishWire, so batching stays a local egress optimization.
	 *
	 * @param {string} topic
	 * @param {string} event - the PER-ENTRY event name; the codec's batch
	 *   form is looked up as `<event>-batch` with `{ updates }` data.
	 * @param {Array<{ data: any, excludeWs?: import('uWebSockets.js').WebSocket<any>, seq?: number }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ seq?: boolean, relay?: boolean, compress?: boolean }} [options]
	 * @returns {boolean}
	 */
	publishWireBatch(topic, event, entries, wire, options) {
		// The contract is checked before the data is: an invalid seq is invalid
		// whether or not this particular call happens to carry entries, so an
		// empty batch cannot silently accept options a full one refuses.
		// Field reads rather than a spread: a spread copies own enumerable
		// properties only, so a numeric seq carried on a prototype or by an
		// inherited accessor would vanish from the copy and slip past a
		// refusal every other read of the same object would have thrown on.
		// Each field is read once, here; the value refused and the value used
		// are the same read.
		const opts = options == null
			? options
			: { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs };
		assertBatchSequenceAuthority(opts);
		if (!Array.isArray(entries) || entries.length === 0) return false;
		// What this call pins, before any application code inside it can run:
		// the entry COUNT, the OPTIONS object, and every entry's `data` and
		// `excludeWs`. Not `wire` - the codec object is caller-supplied and its
		// `capability` and `encode` are read again during the walk, so a payload
		// that reassigns those changes which codec encodes. That is out of scope
		// here for the same reason a payload's own fields are: it is the
		// caller's object, and copying it per message is not a trade this path
		// makes. completeEnvelope calls JSON.stringify, so a payload's toJSON
		// executes while this call is still half-built; anything re-read after
		// that point could be a value the earlier reads never saw - a payload
		// swapped between the JSON envelope and the binary encode under one seq,
		// an exclusion cleared between counting it and honouring it, or an entry
		// count that changed mid-walk. The count and the options are pinned here;
		// the per-entry fields are pinned in a pass of their own, before any
		// envelope is built.
		//
		// Not defended, because it cannot be without deep-copying every payload
		// on a per-message path: mutating a payload object's own fields rather
		// than replacing the reference. Every path holds the same object.
		const count = entries.length;
		// A stateless codec gains nothing from a batched walk (encode-once
		// already amortizes it) - route through the per-entry path unchanged.
		if (!wire || !wire.state) {
			// Read every entry before publishing any of them: the first publish
			// runs application toJSON, and the reads for entry i+1 come after it.
			// Per-entry seqs are validated here too - a refusal must land before
			// the first publish fans out, or a mid-loop throw leaves earlier
			// entries already delivered for a batch that never went out whole.
			const datas = new Array(count);
			const excludes = new Array(count);
			let entrySeqs = null;
			for (let i = 0; i < count; i++) {
				const entry = entries[i];
				datas[i] = entry.data;
				excludes[i] = entry.excludeWs;
				// The entry lane keys on typeof, exactly as the options lane
				// does: a number must be a valid wire seq or the batch refuses,
				// and anything else falls through to the shared options.
				const seq = entry.seq;
				if (typeof seq === 'number') {
					if (!Number.isInteger(seq) || seq < 1) throwInvalidSeq(seq);
					if (entrySeqs === null) {
						assertBatchEntrySequenceAuthority(opts);
						entrySeqs = new Array(count);
					}
					entrySeqs[i] = seq;
				}
			}
			// One admission for the whole batch, before the first entry goes
			// out. Delegating per entry would let each admit on its own and
			// deliver a prefix of the batch under a ceiling, which is both the
			// mid-batch shedding this budget forbids and a partial delivery
			// reported to the caller as success. Recipients are read once here
			// for the decision; each delegated entry still CHARGES itself, so
			// the ledger sees one logical publish per entry either way.
			let admitOpts = opts;
			if (egressGate.armed) {
				let batchRecipients = topicSubscriberCounts.get(topic) || 0;
				if (batchRecipients > 0) {
					// A per-entry exclusion only discounts that entry, so the
					// batch's admission uses the undiscounted count: over-
					// estimating a refusal boundary is safe, under-estimating
					// would admit past the ceiling.
					const shared = opts && opts.excludeWs;
					if (shared !== undefined && shared !== null && excludedRecipient(shared, topic)) batchRecipients--;
				}
				if (!admitPublishEgress(topic, resolvePublishTenant(topic), count, count * batchRecipients)) return false;
				// The entries inherit the decision rather than re-taking it.
				admitOpts = { ...(opts || {}), [EGRESS_ADMITTED]: true };
			}
			let ok = false;
			for (let i = 0; i < count; i++) {
				const entrySeq = entrySeqs === null ? undefined : entrySeqs[i];
				let per = admitOpts;
				if (excludes[i] !== undefined || entrySeq !== undefined) {
					per = { ...(admitOpts || {}) };
					if (excludes[i] !== undefined) per.excludeWs = excludes[i];
					if (entrySeq !== undefined) per.seq = entrySeq;
				}
				ok = this.publishWire(topic, event, datas[i], wire, per) || ok;
			}
			return ok;
		}
		const compressIntent = !!(opts && opts.compress === true);
		const compress = WS_COMPRESSION_ON && compressIntent;
		const relayed = !!(parentPort && (!opts || opts.relay !== false));
		const relayCap = relayed && getWireCodec(wire.capability) ? wire.capability : undefined;
		// Whether anything DOWNSTREAM will read the payload array: the binary
		// walk and the relay, and nothing else. It no longer decides whether the
		// array exists - the snapshot pass below has to hold every payload
		// reference before the first envelope is built either way, so the JSON
		// fast path now allocates one array of length N where it previously
		// allocated none. This only decides whether the per-socket walk carries
		// payloads and whether the relay is handed them.
		const needsData = relayed || capCounts.has(wire.capability);

		// Per-entry seq, envelope, and stats - the exact bookkeeping N
		// publishWire calls would have produced.
		const envs = new Array(count);
		const seqs = new Array(count);
		// SNAPSHOT PASS. Every entry's fields are read before any envelope is
		// built, because completeEnvelope runs the payload's toJSON: with the
		// reads interleaved, entry 0's application code ran before entries
		// 1..N-1 had been read and could replace a later payload or a later
		// exclusion, so the batch delivered values the caller never committed.
		// Reading them all first is what the stateless branch above already
		// does, and it is why `datas` exists even when nothing downstream will
		// read it - N references have to be held before the first serialise.
		// Measured at 1, 8 and 64 entries against the interleaved shape:
		// within run noise (bench/micro-wire-batch-alias-ab.mjs, variant F).
		const datas = new Array(count);
		// Allocated on the first entry that actually carries an exclusion, so the
		// common unexcluded batch pays nothing for it. An entry with no exclusion
		// leaves a hole, which reads as undefined and matches no socket.
		let excludes = null;
		let anyExclude = false;
		// Per-entry explicit seqs, same lazy shape: allocated on the first entry
		// that carries one, validated HERE - before anything is stamped or
		// serialised - so an invalid seq refuses the whole batch with nothing
		// half-delivered, and a toJSON that rewrites a later entry's seq is
		// rewriting a field this call has already read.
		let entrySeqs = null;
		for (let i = 0; i < count; i++) {
			const entry = entries[i];
			datas[i] = entry.data;
			const exclude = entry.excludeWs;
			if (exclude !== undefined && exclude !== null) {
				if (excludes === null) excludes = new Array(count);
				excludes[i] = exclude;
				anyExclude = true;
			}
			// The entry lane keys on typeof, exactly as the options lane does
			// (stampSeq): a number must be a valid wire seq or the batch
			// refuses, and anything else falls through to the shared options.
			const entrySeq = entry.seq;
			if (typeof entrySeq === 'number') {
				if (!Number.isInteger(entrySeq) || entrySeq < 1) throwInvalidSeq(entrySeq);
				if (entrySeqs === null) {
					assertBatchEntrySequenceAuthority(opts);
					entrySeqs = new Array(count);
				}
				entrySeqs[i] = entrySeq;
			}
		}
		// Egress admission for the WHOLE batch, decided after the snapshot pass
		// (a contract violation still refuses by throwing there) and before the
		// stamping loop, so a refused batch moves no watermark and builds no
		// envelope. Deliveries deduct each entry whose excluded socket actually
		// holds the topic; the deduction array is reused by the byte charge in
		// the stamping loop below.
		const recipients = topicSubscriberCounts.get(topic) || 0;
		/** @type {Uint8Array | number[] | null} */
		let exDeduct = null;
		let deliveries = recipients * count;
		if (anyExclude) {
			exDeduct = new Array(count).fill(0);
			for (let i = 0; i < count; i++) {
				if (excludes !== null && excludes[i] !== undefined && excludedRecipient(excludes[i], topic)) {
					exDeduct[i] = 1;
					deliveries--;
				}
			}
		}
		let egressTenant = null;
		if (egressGate.armed) {
			egressTenant = resolvePublishTenant(topic);
			if (!admitPublishEgress(topic, egressTenant, count, deliveries)) return false;
		}
		// Nothing AUTHORITATIVE moves until every entry has both stamped and
		// serialised. completeEnvelope runs JSON.stringify, so a payload whose
		// toJSON throws aborts this loop part-way; advancing the topic watermark
		// or the counters per entry would leave them raised for a batch that put
		// nothing on any wire. Republishing those same seqs after fixing the
		// payload would then be discarded as already-seen - a silent gap.
		let highestSeq = null;
		let batchMessages = 0;
		let batchBytes = 0;
		let batchWireBytes = 0;
		// Hoisted so the common no-entry-seq batch tests one boolean per entry.
		const hasEntrySeqs = entrySeqs !== null;
		for (let i = 0; i < count; i++) {
			// Reads the snapshot, never the caller: application code has already
			// run by the second iteration.
			const data = datas[i];
			// An explicit entry seq is stamped verbatim (already validated in the
			// snapshot pass) and does NOT advance the counter - the numeric
			// authority and the local counter are two tracks, exactly as they are
			// through publishWire.
			const seq = hasEntrySeqs && entrySeqs[i] !== undefined
				? entrySeqs[i]
				: stampSeqValue(opts != null ? opts.seq : undefined, topicSeqs, topic, seqBound);
			seqs[i] = seq == null ? 0 : seq;
			const envelope = completeEnvelope(envelopePrefix(topic, event), data, seq);
			fatal(envelope.length > 0, 'envelope.empty', null);
			if (seq !== null && (highestSeq === null || seq > highestSeq)) highestSeq = seq;
			batchMessages++;
			batchBytes += envelope.length;
			// Per-entry wire bytes: the envelope's UTF-8 encoding times the
			// recipients this entry actually reaches (its exclusion deducted).
			// The stateful batch lane is charged at the envelope size for the
			// same reason publishWire's stateful walk is: the binary batch
			// frame is recipient-specific.
			batchWireBytes += chargeableBytes(envelope, recipients - (exDeduct === null ? 0 : exDeduct[i]));
			envs[i] = envelope;
		}
		// The max-seen record matches what N publishWire calls would have left
		// behind. Counter seqs are freshly stamped and monotonic, so the batch
		// max IS the last write a per-call loop would have made - one write.
		// Explicit entry seqs are cluster-authoritative and interleave across
		// workers, so each goes through the monotone-max guard; a mixed batch
		// applies them in entry order, as N calls would have.
		if (hasEntrySeqs) {
			for (let i = 0; i < count; i++) {
				if (seqs[i] === 0) continue;
				if (entrySeqs[i] !== undefined) recordSeen(maxSeenSeq, topic, seqs[i], seqBound);
				else recordStampedSeen(maxSeenSeq, topic, seqs[i], seqBound);
			}
		} else if (highestSeq !== null) {
			recordStampedSeen(maxSeenSeq, topic, highestSeq, seqBound);
		}
		// Charged only now, after every entry has stamped and serialised: a
		// batch refused in the pre-pass, or aborted by a throwing toJSON, must
		// not create the topic's stats entry - publish() likewise charges only
		// after its envelope is built, and the runaway-publisher window should
		// not learn a topic no frame ever reached. One charge for the whole
		// batch: N logical publishes under one admission decision.
		chargePublishEgress(topic, egressTenant, batchMessages, deliveries, batchBytes, batchWireBytes);
		counters.publishCountWindow += count;

		// Resume cutover in flight: hold the per-entry JSON envelopes a caps-less
		// resuming subscriber would receive from this stateful batch.
		if (resumeBuffers.size > 0) {
			for (let i = 0; i < count; i++) captureResumeFrame(topic, seqs[i] === 0 ? null : seqs[i], envs[i], compress);
		}
		const sendJson = (ws, list) => {
			for (let i = 0; i < list.length; i++) {
				try { ws.send(list[i], false, compress); } catch { counters.closedWsAborts++; return; }
			}
		};

		// JSON fast path: no live connection wants binary for this codec and no
		// entry excludes a socket - N native fan-outs, byte-identical to N
		// publishWire calls.
		if (!anyExclude && !capCounts.has(wire.capability)) {
			for (let i = 0; i < count; i++) {
				const result = app.publish(topic, envs[i], false, compress);
				counters.publishOutcomeHook?.(result);
			}
		} else {
			for (const ws of wsConnections) {
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				// The subset this socket receives: entries not excluded for it.
				// The no-exclusion common case reuses the shared arrays.
				let dataList = datas;
				let envList = envs;
				let seqList = seqs;
				if (anyExclude) {
					dataList = [];
					envList = [];
					seqList = [];
					for (let i = 0; i < count; i++) {
						if (excludes[i] === ws) continue;
						if (needsData) dataList.push(datas[i]);
						envList.push(envs[i]);
						seqList.push(seqs[i]);
					}
					if (envList.length === 0) continue;
				}
				const caps = ud[WS_CAPS];
				// `needsData` is decided before this walk from the fan-out capability
				// COUNTER, while the test beside it reads THIS socket's advertised
				// caps. The two normally agree, and when they do not there are no
				// payloads to encode from - a connection releases its count before it
				// leaves the live set, and application code running in between (a
				// codec's onDetach publishing a batch) lands in that window. Serving
				// JSON is the honest answer there; encoding from an empty payload list
				// would put an EMPTY batch frame on a socket that is still capable and
				// still listed, with the sequence already advanced.
				if (!caps || !caps.has(wire.capability) || !needsData) {
					sendJson(ws, envList);
					continue;
				}
				// A poisoned capability reads a null state and is served JSON,
				// exactly like publishWire's null-state branch.
				const state = ensureWireState(ws, ud, wire);
				if (state == null) {
					sendJson(ws, envList);
					continue;
				}
				deliverStatefulWireBatch({
					wire, event, datas: dataList, envelopes: envList, seqs: seqList,
					state, ws, ud, topic, ensureId: ensureWireId,
					poison: poisonWireState, compress, counters
				});
			}
		}
		if (relayed) {
			for (let i = 0; i < count; i++) {
				batchRelay(topic, envs[i], compressIntent, seqs[i] === 0 ? null : seqs[i], relayCap,
					relayCap !== undefined ? event : undefined,
					relayCap !== undefined ? datas[i] : undefined);
			}
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
	 * Multi-entry single-target send via a stateful plugin codec: one tick's
	 * same-event updates for ONE subscriber as a single binary frame (the
	 * codec's `<event>-batch` form), or the per-entry JSON envelopes when the
	 * connection has no capability / is poisoned. The per-subscriber twin of
	 * publishWireBatch, for the culled (per-viewer) delivery walks. No seq is
	 * stamped (matches `send()` / `sendWire()`); the binary frame carries seq 0.
	 *
	 * Degradation mirrors sendWire per entry: a declined batch falls back to
	 * per-entry encodes, a per-entry null to that entry's JSON envelope, and a
	 * dropped stateful frame poisons the capability to JSON until reconnect.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @param {string} event - the PER-ENTRY event name
	 * @param {Array<{ data: any }>} entries
	 * @param {{ capability: string, schemaVersion: number, encode: Function, state?: any }} wire
	 * @param {{ compress?: boolean }} [options]
	 * @returns {number} uWS send status of the LAST frame sent (0/1/2), or 2 on a freed handle
	 */
	sendWireBatch(ws, topic, event, entries, wire, options) {
		if (!Array.isArray(entries) || entries.length === 0) return 1;
		let ud;
		try { ud = ws.getUserData(); } catch { counters.closedWsAborts++; return 2; }
		const caps = ud[WS_CAPS];
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		const count = entries.length;
		// `source` is the pinned payload array once one exists, and null while it
		// does not - this walk then reads the caller's entry as it reaches it.
		// That is the documented contract, not a gap: pinning protects what has
		// already been BUILT, and a JSON-only send builds nothing that a later
		// entry's toJSON could go back and rewrite. It is also one socket, so no
		// two subscribers can be handed different bytes for the same entry.
		// Deciding it here is what keeps the JSON-only send allocating nothing,
		// which is what it allocated before the one-read rule landed.
		const sendJsonFrom = (i, source) => {
			let result = 1;
			for (; i < count; i++) {
				const d = source === null ? entries[i].data : source[i];
				const json = envelopePrefix(topic, event) + JSON.stringify(d ?? null) + '}';
				try { result = ws.send(json, false, compress); } catch { counters.closedWsAborts++; return 2; }
				bumpOut(ws, json);
			}
			return result;
		};
		if (!caps || !caps.has(wire.capability) || wireStatePoisoned(ud, wire.capability) || !wire.state) {
			return sendJsonFrom(0, null);
		}
		const state = ensureWireState(ws, ud, wire);
		if (state == null) return sendJsonFrom(0, null);
		// The batch encode is application code and is handed the whole array, so
		// from here the payloads must be pinned: a decline falls back to per-entry
		// encodes that have to see what the batch attempt saw. This is the ONE
		// array the binary path allocated before the one-read rule as well - it is
		// handed to the codec directly rather than copied into a second one.
		const datas = new Array(count);
		for (let i = 0; i < count; i++) datas[i] = entries[i].data;
		const schemaVersion = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
		const payload = wire.encode(event + '-batch', { updates: datas }, state);
		if (payload == null) {
			// The codec declined the batch (older codec, unrepresentable entry):
			// the N sendWire bodies this call replaces.
			let result = 1;
			for (let i = 0; i < count; i++) {
				const p = wire.encode(event, datas[i], state);
				if (p == null) {
					const json = envelopePrefix(topic, event) + JSON.stringify(datas[i] ?? null) + '}';
					try { result = ws.send(json, false, compress); } catch { counters.closedWsAborts++; return 2; }
					bumpOut(ws, json);
					continue;
				}
				const id = ensureWireId(ws, ud, topic);
				if (id === -1) {
					poisonWireState(ws, ud, wire.capability);
					return sendJsonFrom(i, datas);
				}
				const frame = buildBinaryFrame(schemaVersion, id, 0, p);
				try { result = ws.send(frame, true, compress); } catch { counters.closedWsAborts++; return 2; }
				bumpOut(ws, frame);
				if (result === 2) {
					poisonWireState(ws, ud, wire.capability);
					return sendJsonFrom(i + 1, datas);
				}
			}
			return result;
		}
		const id = ensureWireId(ws, ud, topic);
		if (id === -1) {
			// Dropped wire-id announce; the batch encode already advanced this
			// connection's dictionaries - the desync poisoning exists for.
			poisonWireState(ws, ud, wire.capability);
			return sendJsonFrom(0, datas);
		}
		const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
		let result;
		try { result = ws.send(frame, true, compress); } catch { counters.closedWsAborts++; return 2; }
		bumpOut(ws, frame);
		if (result === 2) poisonWireState(ws, ud, wire.capability);
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
		// Filter pass first, sends after: the egress decision is pre-hoc over
		// the WHOLE recipient set (there is no mid-walk shedding), and only the
		// filter can name that set. Filters are documented synchronous and
		// side-effect-free reads of userData, so running them ahead of the
		// sends changes nothing a conforming filter can observe.
		const targets = [];
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
					console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SENDTO_ASYNC_FILTER,
						'\n  Async filters cannot be used here because sendTo iterates every active\n' +
						'  connection synchronously. Resolve the relevant fields into userData from\n' +
						'  your `upgrade` hook so the filter can read them synchronously.'));
				}
				continue;
			}
			if (decision) targets.push(ws);
		}
		if (targets.length === 0) return 0;
		let egressTenant = null;
		if (egressGate.armed) {
			egressTenant = resolvePublishTenant(topic);
			// Refused: nothing is sent and the count says so.
			if (!admitPublishEgress(topic, egressTenant, 1, targets.length)) return 0;
		}
		let count = 0;
		for (const ws of targets) {
			try { ws.send(envelope, false, compress); }
			catch { counters.closedWsAborts++; continue; }
			bumpOut(ws, envelope);
			count++;
		}
		// One egress charge for the delivered set. This lane never feeds the
		// per-topic runaway stats - those keep meaning publish-family calls -
		// but its frames are egress like any other.
		if (count > 0) chargeDirectEgress(topic, egressTenant, count, chargeableBytes(envelope, count));
		return count;
	},

	/**
	 * Advise connected clients to reconnect on a jittered schedule, then (by
	 * default) drain them. A draining or restarting node sends the additive
	 * `{"type":"reconnect","windowMs":N,"afterMs"?:M}` control frame so each client
	 * rolls its own delay in [afterMs, afterMs + windowMs) instead of a whole fleet
	 * hammering the replacement in one backoff window. The frame is unknown-type-
	 * safe (an old client ignores it and falls back to normal backoff), so it is
	 * not capability-gated. Modeled on `sendTo`.
	 *
	 * @param {{ windowMs?: number, afterMs?: number, close?: boolean, filter?: (userData: any) => boolean, compress?: boolean }} [options]
	 * @returns {number} the number of connections advised
	 */
	adviseReconnect(options) {
		const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
			? Math.floor(options.windowMs) : 0;
		// A non-positive window means suppressed (legacy behavior): nothing to advise.
		if (windowMs <= 0) return 0;
		const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
			? Math.floor(options.afterMs) : 0;
		const doClose = !options || options.close !== false;
		const filter = options && typeof options.filter === 'function' ? options.filter : null;
		const frame = afterMs > 0
			? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
			: '{"type":"reconnect","windowMs":' + windowMs + '}';
		const compress = WS_COMPRESSION_ON && !!(options && options.compress === true);
		// Snapshot: with close:true, ws.end() fires the close handler synchronously
		// and removes the entry from wsConnections mid-iteration (unlike sendTo, which
		// never closes). Mirrors shutdown()'s snapshot. The filter pass runs over
		// the snapshot first so the advised set is settled before the first frame.
		const targets = [];
		for (const ws of [...wsConnections]) {
			let userData;
			try { userData = ws.getUserData(); }
			catch { counters.closedWsAborts++; continue; }
			if (filter) {
				const decision = filter(userData);
				// An async filter cannot be evaluated synchronously; fail-closed (do not
				// advise), matching sendTo.
				if (decision && typeof decision.then === 'function') continue;
				if (!decision) continue;
			}
			targets.push(ws);
		}
		let count = 0;
		for (const ws of targets) {
			try {
				// end() flushes buffered outbound before the 1001 close frame, so the
				// advisory always lands before the close.
				ws.send(frame, false, compress);
				bumpOut(ws, frame);
				if (doClose) ws.end(1001, 'Server draining');
			} catch { counters.closedWsAborts++; continue; }
			count++;
		}
		// The advisory is operator-lane egress: it carries no topic and no
		// tenant, so it lands in the worker egress window but sits outside
		// every ceiling - a drain command must not be refusable by a budget.
		if (count > 0) chargeDirectEgress(null, null, count, chargeableBytes(frame, count));
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
	 * `[lantean/diagnostic source=svelte-adapter-uws component=runtime.assertion event=invariant.violated severity=warn]` log lines accompanying each violation
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
	 * topic name, never a user id, never a socket handle. Counts, enums, and
	 * package versions only. Pure read (a fresh plain object each call), so it
	 * is safe to expose behind an auth-gated admin route or feed to a dashboard.
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
	 *   versions: { adapter: string | null, protocolRevision: number | null, realtime: string | null, extensions: string | null },
	 *   pressure: { sampledAt: number | null, active: boolean, reason: string, value: number, subscriberRatio: number, publishRate: number, memoryMB: number, maxBufferedBytes: number, backpressuredConnections: number, droppedFrames: number, droppedBytes: number, egress: { deliveries: number, bytes: number, refusedTopic: number, refusedTenant: number } },
	 *   assertions: Record<string, number>,
	 *   diagnostics: { retained: number, recent: Array<{ diagnosticId: string, kind: string, observedAt: number, complete: boolean, affectedStreamCount: number, evidenceTruncated: boolean }> }
	 * }}
	 */
	introspect() {
		const p = pressureSnapshot;
		return {
			connections: platform.connections,
			closedWsAborts: platform.closedWsAborts,
			protection: platform.protection,
			maxPayloadLength: platform.maxPayloadLength,
			versions: { ...runtimeVersionInfo },
			pressure: {
				// First, because it qualifies everything after it: null means the
				// sampler has not folded yet and the numbers below are placeholders.
				sampledAt: p.sampledAt,
				active: p.active,
				reason: p.reason,
				value: p.value,
				subscriberRatio: p.subscriberRatio,
				publishRate: p.publishRate,
				memoryMB: p.memoryMB,
				maxBufferedBytes: p.maxBufferedBytes,
				backpressuredConnections: p.backpressuredConnections,
				droppedFrames: p.droppedFrames,
				droppedBytes: p.droppedBytes,
				// Counts only, like everything else here: local deliveries,
				// serialized wire bytes, and ceiling refusals for the last
				// sample window. A fresh copy, so a caller cannot mutate the
				// sampler's live object through the snapshot.
				egress: {
					deliveries: p.egress.deliveries,
					bytes: p.egress.bytes,
					refusedTopic: p.egress.refusedTopic,
					refusedTenant: p.egress.refusedTenant
				}
			},
			assertions: Object.fromEntries(platform.assertions),
			// Metadata only. Keyed stream ids and sequence evidence require an
			// exact opaque id through `platform.diagnostic()`, which
			// svelte-realtime exposes only after its mandatory admin auth gate.
			diagnostics: {
				retained: divergenceDiagnostics.size,
				recent: divergenceDiagnostics.list()
			}
		};
	},

	/**
	 * Resolve one bounded state-divergence record by opaque id. Topic names are
	 * never present; affected streams are per-primary-lifetime HMAC ids. Do not
	 * expose this method on a public route. svelte-realtime's authenticated
	 * admin handler provides the supported HTTP surface.
	 *
	 * @param {string} diagnosticId
	 * @returns {any | null}
	 */
	diagnostic(diagnosticId) {
		return divergenceDiagnostics.get(diagnosticId);
	},

	/**
	 * Number of clients subscribed to a specific topic.
	 */
	subscribers(topic) {
		return app.numSubscribers(topic);
	},

	/**
	 * Whether `request` is a synthetic boot-warmup render rather than a real
	 * client request. Warmup renders the configured paths once during boot to
	 * warm the SSR path before readiness; those renders run the app's server
	 * hooks like any request, so a `hooks.server.js` handle that writes
	 * analytics, counts a visit, or touches a per-request resource can call
	 * this to skip that work for the warmup. The tag is by object identity
	 * (a WeakSet), never a header, so a real client cannot forge it.
	 *
	 * @param {Request} request
	 * @returns {boolean}
	 */
	isWarmupRequest(request) {
		return isWarmupRequest(request);
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
		let ud;
		try { ud = ws.getUserData(); }
		catch { counters.closedWsAborts++; return null; }
		const subs = ud[WS_SUBSCRIPTIONS];
		// The subscription slot is assigned a Set once at open and never reassigned;
		// a non-Set here is unrecoverable heap/dispatch corruption. One instanceof
		// guard, identical in cost to the assert it replaces. A freed handle is
		// caught above and returns early, so this only runs on a live connection.
		fatal(subs instanceof Set, 'subs.shape', null);
		const held = subs.has(topic);
		if (held) return null;
		if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
		// In-flight authorization is bounded before the hook await, exactly as
		// the wire lanes bound it: a server-side subscribe loop against a slow
		// hook stacks the same concurrent work a hostile client would, and the
		// landed cap above cannot see attempts that never land.
		if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(ud), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) return 'RATE_LIMITED';
		// Track the in-flight subscribe so a revocation landing during the
		// hook await can cancel it: platform.unsubscribe tombstones the topic
		// in the pending set and the landing below discards the grant instead
		// of subscribing (revocation TOCTOU).
		const pendingToken = beginPendingSubscribe(ud, topic, held);
		const denial = await runUserSubscribeGate(ws, topic);
		if (denial !== null) {
			// The hook denied, but it may have installed tracked membership
			// (a plugin join) before deciding, and a revocation may have tombstoned
			// this attempt mid-await. Settling blindly here left that membership
			// standing: the held branch below defers to a sibling attempt still in
			// flight, so when that sibling's hook denies too, every attempt leaves
			// through this exit and nothing remains to judge the membership.
			if (settleDeniedSubscribe(ud, topic, pendingToken, subs.has(topic)) === 'deny-unwind') {
				unwindRevokedMembership(ws, topic);
				wsModule.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
			}
			return denial;
		}
		// Re-check after the await: a concurrent subscribe (wire frame
		// or another platform.subscribe call) may have raced through
		// while we awaited the user hook. Idempotent ack and skip the
		// counter bump in that case.
		const heldAfter = subs.has(topic);
		if (heldAfter) {
			// A revocation may have tombstoned this attempt mid-await while its
			// OWN hook installed the membership (a plugin join). Read the
			// provenance rather than acking blindly: ack a surviving attempt or
			// a fresh post-revoke grant, deny a revoked one - unwinding the
			// hook-installed membership when no live authority backs it.
			const heldVerdict = settleHeldSubscribe(ud, topic, pendingToken);
			if (heldVerdict === 'ack') return null;
			if (heldVerdict === 'deny-unwind') {
				unwindRevokedMembership(ws, topic);
				wsModule.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
			}
			return 'FORBIDDEN';
		}
		if (exceedsSubscriptionCap({ held: heldAfter, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) { settlePendingSubscribe(ud, topic, pendingToken); return 'RATE_LIMITED'; }
		// Revocation tombstone: platform.unsubscribe ran while the hook
		// awaited, so the grant was revoked before it materialized - discard
		// it. No further await follows before ws.subscribe, so this single
		// check covers the whole window.
		if (!settlePendingSubscribe(ud, topic, pendingToken, true)) return 'FORBIDDEN';
		// `ws.subscribe()` throws if the socket closed during the await
		// above. Under mass-connect / backpressure churn this is the
		// dominant abort mode (10-15% of connections close mid-setup).
		// Swallow, count, and return success-shaped null so callers can
		// fire-and-forget without per-site try/catch.
		try { ws.subscribe(topic); }
		catch { counters.closedWsAborts++; return null; }
		addLogicalSubscription(subs, topic);
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
	 * Pass `{ requireGrant: true }` for an OBSERVER lane - a caller that shows
	 * a connection state for a topic it is supposed to already hold, rather
	 * than one deciding whether to grant it. With wire-subscribe authorization
	 * armed and no app subscribe hook, that mode additionally requires the
	 * topic to be in the connection's grant set (a prior `platform.subscribe`),
	 * which is what keeps `presence.sync` and `cursor.snapshot` - gated only by
	 * this check - from leaking a cross-tenant roster. Grant membership is read
	 * again after an async side-effect hook, so a revocation inside that await
	 * cannot return an obsolete allow. It is deliberately NOT
	 * the default: the ordinary use below gates BEFORE establishing the grant,
	 * so requiring one would deny every such call.
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
	async checkSubscribe(ws, topic, options) {
		// Server-side caller: same trust as platform.subscribe (see
		// note there). Wire-side gating happens earlier in the message
		// handler with the configured alphabet. `requireGrant` is different:
		// presence/cursor use it for CLIENT-NAMED snapshot frames, so that mode
		// must accept exactly the same topic alphabet as the wire boundary.
		if (!isValidWireTopic(topic, options && options.requireGrant ? ALLOW_NON_ASCII_TOPICS : true)) {
			return 'INVALID_TOPIC';
		}
		// `requireGrant` is the OBSERVER-LANE mode, opted into by the caller.
		// It must not be the default: the ordinary use of this method is to
		// gate BEFORE establishing a grant (the stream-RPC example above
		// gates, runs a loader, then subscribes), and requiring the grant to
		// exist already would make every such call deny under a pure-grant
		// deployment. The snapshot lanes are the opposite shape - they answer
		// "may this connection see what it already holds?" - so they pass it.
		const requireGrant = Boolean(options && options.requireGrant);
		let observerHasUserHook = false;
		if (requireGrant) {
			// Snapshot hook presence for the async decision, but read the latched
			// strict policy fresh at each grant check. Strict may be armed while the
			// hook is parked and must tighten that in-flight decision.
			observerHasUserHook = hasUserSubscribeHook();
			let granted;
			try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
			catch { counters.closedWsAborts++; return 'FORBIDDEN'; }
			if (deniesUngrantedObserve(subscribeAuth.enabled, observerHasUserHook && !subscribeAuth.strict, granted, topic)) {
				return 'FORBIDDEN';
			}
		}
		const denial = await runUserSubscribeGate(ws, topic);
		if (denial !== null) return denial;
		if (requireGrant) {
			// The hook can be async. A grant that existed before that await is not
			// authority to reveal state after platform.unsubscribe revoked it while
			// the hook was parked. Re-read the CURRENT Set at landing; a legitimate
			// revoke-then-regrant is visible because the topic is present again.
			let granted;
			try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
			catch { counters.closedWsAborts++; return 'FORBIDDEN'; }
			if (deniesUngrantedObserve(subscribeAuth.enabled, observerHasUserHook && !subscribeAuth.strict, granted, topic)) {
				return 'FORBIDDEN';
			}
		}
		return null;
	},

	/**
	 * Turn on wire-subscribe authorization for this worker. Once enabled, a
	 * CLIENT-initiated `subscribe` / `subscribe-batch` frame is honored only
	 * for a topic the server already authorized for that connection via
	 * `platform.subscribe` (recorded in the connection's subscription set),
	 * unless the app exports its own `subscribe` / `subscribeBatch` hook - in
	 * which case that hook decides in the legacy mode. Pass `'strict'` to
	 * require the topic to be server-granted AND allowed by the app hook.
	 * Server-side
	 * `platform.subscribe` is the trusted grant-establishing path and is
	 * never gated by this; `platform.checkSubscribe` (the observer-lane
	 * gate) additionally requires the topic to be in the connection's
	 * grant set once armed, so the presence / cursor snapshot lanes hold
	 * the same grant model as the wire path.
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
	 * Idempotent and worker-wide (the flag lives in this worker's shared handler
	 * state, so one call arms every connection owned by this worker). Call from
	 * per-worker startup - e.g. a framework `init({ platform })` hook - before
	 * connections arrive. A call in one worker does not mutate another worker's
	 * JavaScript realm.
	 *
	 * @param {'legacy' | 'strict'} [mode]
	 * @returns {'legacy' | 'strict'} the active (latched) policy
	 */
	authorizeWireSubscribe(mode = 'legacy') {
		if (mode !== 'legacy' && mode !== 'strict') {
			throw new TypeError("authorizeWireSubscribe mode must be 'legacy' or 'strict'");
		}
		subscribeAuth.enabled = true;
		if (mode === 'strict') subscribeAuth.strict = true;
		return subscribeAuth.strict ? 'strict' : 'legacy';
	},

	/**
	 * Grant a connection the right to publish to `topic` via the client-driven
	 * relay (`game`) lane - the trusted server-side dual of `platform.subscribe`.
	 * A client `game` frame carries NO topic; the server derives it from this
	 * binding, so a client can only publish to a room it was granted (typically
	 * at join, from the framework's authorization gate). This is the general
	 * publish-authorization primitive; a game session is its first consumer.
	 *
	 * Single-valued per connection (one room per socket, mirroring the native
	 * daemon's per-socket grant): a second call re-binds to the new topic. Pass a
	 * different topic to move the binding; call `revokePublish` to clear it.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {boolean} `true` on success, `false` if the socket had already closed
	 * @throws {Error} when sockets span more than one I/O worker and no single
	 *   authoritative game-lane home exists
	 */
	grantPublish(ws, topic) {
		// The per-room seq and sender-excluding walk are worker-local. Refuse the
		// first grant in a multi-I/O-worker topology instead of authorizing a lane
		// that would silently omit remote participants and fork its sequence.
		assertGameLaneClusterSafe();
		let ud;
		try { ud = ws.getUserData(); } catch { counters.closedWsAborts++; return false; }
		ud[WS_PUBLISH_GRANT] = topic;
		return true;
	},

	/**
	 * Clear a connection's client-publish binding - the dual of `unsubscribe`.
	 * After this the connection's `game` frames are denied (`game-denied`
	 * `FORBIDDEN`) until re-granted. Idempotent.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @returns {boolean} `true` if a binding was cleared, `false` if there was none
	 */
	revokePublish(ws) {
		let ud;
		try { ud = ws.getUserData(); } catch { return false; }
		if (ud[WS_PUBLISH_GRANT] === undefined) return false;
		ud[WS_PUBLISH_GRANT] = undefined;
		return true;
	},

	/**
	 * The topic a connection is currently bound to publish to via the `game`
	 * lane, or `null` when it holds no grant. Read-only introspection.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @returns {string | null}
	 */
	publishGrant(ws) {
		let ud;
		try { ud = ws.getUserData(); } catch { return null; }
		return ud[WS_PUBLISH_GRANT] ?? null;
	},

	/**
	 * Relay a client-originated `game` frame to a topic's local subscribers,
	 * EXCLUDING the sender (echo suppression - the sender already holds its own
	 * input and predicts locally) and echoing the sender's client `id` for
	 * input ordering / prediction-reconcile on the other receivers. The server
	 * stamps a monotonic per-room seq (the session-home sequencer), so a globally
	 * ordered relay sequence is this home worker's counter.
	 *
	 * Trusted server path (explicit topic): the wire-level `game` handler resolves
	 * the topic from the sender's `WS_PUBLISH_GRANT` and gates on it before calling
	 * this. Fan-out takes the per-subscriber walk (uWS `app.publish` cannot skip a
	 * socket); this is the conformance ORACLE behavior, not the perf path - the
	 * native daemon does the same fan-out with `publish_wire`/`exclude_ws`. Local
	 * only: cross-worker / cross-edge home relay is a separate mechanism. Game
	 * frames are sent uncompressed (the 60 Hz input path, like the cursor lane).
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} senderWs  the publishing socket, excluded from the fan-out
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} data
	 * @param {number | string} [id]  the sender's client input id, echoed to the other receivers
	 * @returns {{ seq: number | null, delivered: number }}
	 * @throws {Error} when sockets span more than one I/O worker
	 */
	publishGame(senderWs, topic, event, data, id) {
		// Server-authored frames can bypass grantPublish, so guard this primitive
		// independently as well. One I/O worker plus any number of compute workers
		// is safe; more than one socket-owning worker needs an external authority.
		assertGameLaneClusterSafe();
		// Egress: the sender is subscribed to its own room in the ordinary case
		// and is excluded from the walk, so it is not a recipient. The game lane
		// is the one publish with a socket in hand - its tenant is the SENDER's
		// frozen attribution, never the topic resolver: the client relaying
		// through this lane is the party whose budget the fan-out spends.
		let recipients = topicSubscriberCounts.get(topic) || 0;
		if (excludedRecipient(senderWs, topic)) recipients--;
		let egressTenant = null;
		if (egressGate.armed) {
			if (egressGate.account !== null && egressGate.account.tenantEnabled) {
				let att = null;
				try { att = senderWs.getUserData()[WS_ATTRIBUTION] ?? null; } catch { att = null; }
				egressTenant = att !== null && typeof att.tenantId === 'string' ? att.tenantId : null;
			}
			// A refusal delivers nothing and stamps nothing; { seq: null,
			// delivered: 0 } is this lane's refusal shape.
			if (!admitPublishEgress(topic, egressTenant, 1, recipients)) return { seq: null, delivered: 0 };
		}
		counters.publishCountWindow++;
		const seq = stampSeqValue(undefined, topicSeqs, topic, seqBound);
		if (seq !== null) recordStampedSeen(maxSeenSeq, topic, seq, seqBound);
		const envelope = completeGameEnvelope(envelopePrefix(topic, event), data, seq, id);
		fatal(envelope.length > 0, 'envelope.empty', null);
		// The one egress charge for this logical publish. Compact-binary
		// recipients are charged the envelope size too: the 0x03 form is
		// per-capability and encoded lazily inside the walk, and forcing the
		// encode on every publish just to price it would tax the 60 Hz lane.
		chargePublishEgress(topic, egressTenant, 1, recipients, envelope.length, chargeableBytes(envelope, recipients));
		// Fan out to the topic's LOCAL subscribers, skipping the sender. The single
		// C++ app.publish fan-out cannot skip a socket, so the exclusion forces the
		// per-subscriber walk (the same shape publishWire uses for excludeWs).
		//
		// Compact fan-out (PROTOCOL.md 6.7): a subscriber that negotiated
		// `game.fanout:1` receives the value-codec `0x03` frame; everyone else
		// gets the JSON envelope, byte-identical to before. The compact payload is
		// stateless (sender-independent), so it is encoded ONCE and framed per
		// connection by its wire-id - exactly the stateless publishWire path. The
		// walk is mandatory here regardless of that, because the sender must be
		// excluded. capCounts short-circuits the whole binary path to zero cost
		// when no connected client advertised the capability.
		// Resume cutover in flight: hold the JSON game envelope a caps-less resuming
		// subscriber would receive (compact-binary subscribers recover via their own
		// wire-id announce on join, not this buffer). One guarded size check.
		if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope, false);
		const wantBinary = capCounts.has(GAME_FANOUT_CAP);
		const seqOnWire = seq == null ? 0 : seq;
		/** @type {Uint8Array | null} */
		let sharedPayload = null;
		let sharedEncoded = false;
		/** @type {Map<number, Uint8Array> | null} */
		let sharedFrameById = null;
		let delivered = 0;
		for (const ws of wsConnections) {
			if (ws === senderWs) continue;
			let ud;
			try { ud = ws.getUserData(); } catch { continue; }
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!subs || !subs.has(topic)) continue;
			const caps = wantBinary ? ud[WS_CAPS] : null;
			if (caps && caps.has(GAME_FANOUT_CAP) && !wireStatePoisoned(ud, GAME_FANOUT_CAP)) {
				if (!sharedEncoded) {
					sharedPayload = encodeGameFanoutPayload(event, data, id);
					sharedEncoded = true;
					sharedFrameById = new Map();
				}
				const wid = ensureWireId(ws, ud, topic);
				if (wid === -1) {
					// Dropped wire-id announce: the client can never resolve this
					// topic's numeric id, so binary is undecodable here from now on.
					// JSON for this frame + poison to JSON until reconnect.
					poisonWireState(ws, ud, GAME_FANOUT_CAP);
					try { ws.send(envelope, false, false); bumpOut(ws, envelope); delivered++; }
					catch { counters.closedWsAborts++; }
					continue;
				}
				let frame = sharedFrameById.get(wid);
				if (!frame) {
					frame = buildBinaryFrame(GAME_FANOUT_SCHEMA_VERSION, wid, seqOnWire, /** @type {Uint8Array} */ (sharedPayload));
					sharedFrameById.set(wid, frame);
				}
				// A dropped shared frame needs no poisoning: the payload carries no
				// per-connection state, so the client decoder stays in sync.
				try { ws.send(frame, true, false); bumpOut(ws, frame); delivered++; }
				catch { counters.closedWsAborts++; }
				continue;
			}
			try { ws.send(envelope, false, false); bumpOut(ws, envelope); delivered++; }
			catch { counters.closedWsAborts++; }
		}
		return { seq, delivered };
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
	 * The decrement describes LIVE connections. Once this socket's close has
	 * been accounted, the memberships it held were released as a whole and the
	 * registry is settled, so a call landing after that still removes and still
	 * returns `true` but charges nothing - charging it again would put the
	 * counter below the truth. See `accountClosedLogicalSubscriptions`.
	 *
	 * A topic with a subscribe still IN FLIGHT (a wire subscribe parked in
	 * its authorization-hook await, or a `platform.subscribe` in the same
	 * window) is tombstoned in the connection's pending-subscribe set: the
	 * post-await landing checks the tombstone and discards the grant
	 * instead of subscribing, so a revocation can no longer be silently
	 * defeated by a subscribe that completes after it. Cancelling an
	 * in-flight subscribe counts as a removal (`true`) - the revoke was
	 * honored.
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} topic
	 * @returns {boolean} `true` if a subscription was removed or an in-flight subscribe cancelled
	 */
	unsubscribe(ws, topic) {
		// Closed sockets get an early-out: there is no subscription
		// state to remove, no uWS bookkeeping to drop, no informational
		// hook to fire. The platform contract is "best effort; no throw
		// on closed WS" - mirrors subscribe / send.
		let ud;
		try { ud = ws.getUserData(); }
		catch { counters.closedWsAborts++; return false; }
		const subs = ud[WS_SUBSCRIPTIONS];
		assert(subs instanceof Set, 'subs.shape-unsubscribe', null);
		// Tombstone any in-flight subscribe for this topic FIRST, so a
		// racing post-await landing discards its grant even when an
		// established subscription is being removed below (a duplicate
		// in-flight subscribe must not re-materialize it).
		const cancelledPending = tombstonePendingSubscribe(ud, topic);
		// Release any observer tap derived from this topic (presence's roster
		// channel, cursor's position channel). Both plugins keep their tap alive
		// across a participant leave on purpose and drop it only on socket close,
		// so without this a kicked or banned client kept receiving the roster and
		// every peer's position - and kept publishing, since the cursor lane
		// authorizes a publish by asking whether the socket holds the tap. Done
		// BEFORE the early return below: revoking a topic must release its taps
		// whether or not the primary membership is still present.
		releaseDerivedSubscriptions(ws, topic);
		// Revoking a topic withdraws WRITE access to it as well as read access.
		// The client-driven `game` lane carries no topic - it publishes to
		// whatever `grantPublish` bound - so a kick that took the subscription
		// away left the sender still bound to the room and still able to publish
		// into it, silently, to everyone who remained. Read and write were
		// granted together and must be revoked together. Scoped to this topic:
		// a connection bound to some OTHER room keeps that binding.
		if (ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
		if (!subs.has(topic)) return cancelledPending;
		try { ws.unsubscribe(topic); }
		catch { counters.closedWsAborts++; return false; }
		removeLogicalSubscription(subs, topic);
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
	 * onmessage dispatches. For one-frame-per-subscriber wire batching,
	 * use `publishBatched()` - its declaration-owned block in
	 * `src/index.d.ts` is the canonical contract comparison.
	 *
	 * @param {{ topic: string, event: string, data?: unknown, options?: { relay?: boolean, seq?: boolean | number, compress?: boolean, jitterMs?: number } }[]} messages
	 * @returns {boolean[]} publish result for each message (false = no subscribers)
	 */
	batch(messages) {
		// All-or-nothing authority validation: do not publish a safe prefix and
		// then discover an implicit sequence later in the same cluster batch.
		// Field reads into plain snapshots, once per message: the value this
		// pre-pass judged must be the value publish() stamps, or a stateful
		// accessor could pass the atomic check and then hand the per-message
		// publish a different one - which would throw mid-batch and leave a
		// published prefix, the exact outcome the pre-pass exists to prevent.
		const snapshots = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const o = messages[i].options;
			const snap = o == null
				? o
				: { seq: o.seq, relay: o.relay, compress: o.compress, jitterMs: o.jitterMs };
			assertClusterSequenceAuthority(snap);
			snapshots[i] = snap;
		}
		const results = [];
		for (let i = 0; i < messages.length; i++) {
			const { topic, event, data } = messages[i];
			results.push(platform.publish(topic, event, data, snapshots[i]));
		}
		return results;
	},

	/**
	 * Wire-batching implementation. The editable public contract lives on
	 * `Platform.publishBatched` in `src/index.d.ts`; its bounded JSDoc region
	 * generates the README via `scripts/generate-api-docs.js`. Keep only
	 * implementation mechanics here so this file cannot become a third manual
	 * API reference.
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
		// Validate the WHOLE batch before one event can mutate counters or reach a
		// subscriber. A mixed safe/unsafe batch must fail atomically rather than
		// partially publishing its prefix. One read per field, snapshotted: the
		// value judged here is the value the stamp and the relay decision use
		// below, so a stateful accessor cannot pass this atomic pre-pass and
		// then hand the fast path an authoritative number it would relay.
		const msgSeqs = new Array(messages.length);
		const msgRelays = new Array(messages.length);
		const msgJitters = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const o = messages[i].options;
			const seqOption = o != null ? o.seq : undefined;
			const relayOption = o != null ? o.relay : undefined;
			msgJitters[i] = o != null ? o.jitterMs : undefined;
			assertClusterSequenceAuthorityValues(seqOption, relayOption);
			msgSeqs[i] = seqOption;
			msgRelays[i] = relayOption;
		}

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
			// The batch is atomic on this path too: admitting per event would
			// deliver a prefix and refuse the tail, which is the mid-batch
			// shedding the budget forbids. Each topic carries its own
			// recipient count here (the paths differ only in dispatch), and a
			// tenant decides once on everything it owns in the batch.
			if (egressGate.armed && !admitBatchEgress(messages, null)) return;
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				// The snapshot, not a spread of the live object: publish() consumes
				// exactly these fields, and the values it stamps must be the ones
				// the atomic pre-pass above already judged.
				platform.publish(m.topic, m.event, m.data, {
					seq: msgSeqs[i],
					relay: msgRelays[i],
					jitterMs: msgJitters[i],
					compress: compressOptIn,
					[EGRESS_ADMITTED]: true
				});
			}
			return;
		}

		// Egress admission for the whole fast-path batch, before anything is
		// stamped. In all-see-all every interested subscriber holds every batch
		// topic, so the dispatch topic's tracked count IS the recipient set for
		// every topic in the batch; a mixed-topic batch admits each distinct
		// topic's own share and pools each tenant's, and one refusal refuses
		// the whole batch (its atomicity contract). The slow path above takes
		// the same decision through the same helper, reading each topic's own
		// count, and marks its events so they charge without re-deciding.
		const recipients = topicSubscriberCounts.get(messages[0].topic) || 0;
		const gateArmed = egressGate.armed;
		let egressTenant = null;
		if (gateArmed) {
			if (allSameTopic) {
				egressTenant = resolvePublishTenant(firstTopic);
				if (!admitPublishEgress(firstTopic, egressTenant, messages.length, messages.length * recipients)) return;
			} else if (!admitBatchEgress(messages, recipients)) return;
		}
		// Fast path: build per-event envelopes (also stamps seq + charges the
		// per-event egress), wrap into a shared batch frame, and hand
		// fanout to uWS's C++ TopicTree via app.publish. In all-see-all
		// every interested subscriber is subscribed to every batch
		// topic, so dispatching on any one of them reaches them all.
		/** @type {Array<{ topic: string, env: string, seq: number | null }>} */
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			counters.publishCountWindow++;
			const seq = stampSeqValue(msgSeqs[i], topicSeqs, m.topic, seqBound);
			// Track the highest observed seq per topic (see platform.publish): the
			// compare-free record for the monotonic in-memory counter, the
			// monotone-max guard for an explicit numeric seq.
			if (seq !== null) {
				if (typeof msgSeqs[i] === 'number') recordSeen(maxSeenSeq, m.topic, seq, seqBound);
				else recordStampedSeen(maxSeenSeq, m.topic, seq, seqBound);
			}
			const env = completeEnvelope(envelopePrefix(m.topic, m.event), m.data, seq);
			events[i] = { topic: m.topic, env, seq };
			// One egress charge per logical publish: each batched event is one,
			// priced at its own envelope's UTF-8 bytes times the shared
			// recipient set. The batch frame's wrapper bytes are uncharged
			// overhead, so a tenant pays the same for N events whether the
			// runtime batches them or not.
			chargePublishEgress(m.topic,
				gateArmed ? (allSameTopic ? egressTenant : resolvePublishTenant(m.topic)) : null,
				1, recipients, env.length, chargeableBytes(env, recipients));
		}

		// Cross-worker relay: a single 'publish-batched' IPC carrying the
		// pre-built per-event envelopes. The receiving worker re-runs the
		// detection (allSeeAll + everyoneCapable for ITS local subscriber
		// set) and dispatches via its own fast or slow path. This keeps
		// the wire-batching benefit cluster-wide instead of degrading to
		// per-event relays on worker boundaries.
		if (parentPort) {
			/** @type {Array<import('./relay.js').RelayBatchedEntry>} */
			const relayed = [];
			for (let i = 0; i < messages.length; i++) {
				if (msgRelays[i] !== false) {
					// Carry each event's stamped seq so the receiving worker
					// advances its delivered-seq tracker without re-parsing.
					relayed.push({ topic: events[i].topic, env: events[i].env, seq: events[i].seq });
				}
			}
			if (relayed.length > 0) {
				relayBatched(relayed, compressOptIn);
			}
		}

		// Resume cutover in flight: a caps-less resuming connection receives these
		// events as per-event JSON (the slow path this fast path stands in for), so
		// hold each per-event envelope for any open buffer - NOT the wrapped batch
		// frame, which a caps-less connection never decodes and which can span topics.
		if (resumeBuffers.size > 0) {
			for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].seq, events[i].env, compressOptIn);
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
		counters.publishOutcomeHook?.(result);

		if (wsDebug) {
			console.log('[ws] publishBatched events=%d single-topic=%s fanoutTopicRef=%s delivered=%s',
				events.length, allSameTopic,
				fanoutTopic === null ? 'mixed' : privateValueMetadata(fanoutTopic, 'topic').ref,
				result);
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
	 * if the WebSocket closes before a reply arrives - the closed rejection
	 * appends which side of transmission the close landed on (never sent,
	 * send failed, or handed to the transport and unanswered), and only the
	 * last of those needs an idempotent retry.
	 *
	 * Pending requests live in `WS_PENDING_REQUESTS` on `ws.getUserData()`,
	 * so cleanup is automatic on close - no module-level leak risk.
	 */
	request(ws, event, data, options) {
		let userData;
		try { userData = ws.getUserData(); }
		catch {
			counters.closedWsAborts++;
			return Promise.reject(new Error(adapterErrorMessage(
				ADAPTER_ERROR_IDS.REQUEST_CLOSED,
				REQUEST_CLOSED_DETAIL.NEVER_SENT
			)));
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
				if (pending.delete(ref)) reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT)));
			}, timeoutMs);
			const entry = { resolve, reject, timer, sent: false };
			pending.set(ref, entry);
			const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
			// The send outcome is recorded so the close sweep can say which
			// side of transmission the close landed on: 2 (DROPPED) means the
			// frame never reached the transport even though the call returned.
			try { entry.sent = ws.send(payload, false, false) !== 2; }
			catch {
				counters.closedWsAborts++;
				clearTimer(timer);
				pending.delete(ref);
				reject(new Error(adapterErrorMessage(
					ADAPTER_ERROR_IDS.REQUEST_CLOSED,
					REQUEST_CLOSED_DETAIL.SEND_FAILED
				)));
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
	 * `new Response(platform.metrics.serialize())`. On a plugin-built bundle a
	 * direct import of the metrics module reads this same instance; on the
	 * standalone fallback bundle (built without the Vite plugin, which warns)
	 * this property is the only read point that reaches the populated copy.
	 */
	get metrics() {
		return metricsRegistry;
	},

	/**
	 * Cluster-wide metrics, merged. `platform.metrics.serialize()` renders only
	 * the worker that happened to serve the scrape - and since every worker
	 * shares one port, that is a different worker each time. This collects all
	 * of them through the primary and combines each metric by its declared law
	 * (counters and per-worker quantities add; process-wide readings and
	 * saturation take the worst; freshness takes the stalest).
	 *
	 * Resolves to `null` when no `metrics` registry is configured. It does NOT
	 * need `serialize()`: the snapshot is built from the values the adapter
	 * wrote, not from rendered text. One collection runs at a time across the
	 * cluster; a caller arriving while one is open joins it.
	 *
	 * @param {{ timeoutMs?: number }} [options]
	 * @returns {Promise<string | null>}
	 */
	metricsSnapshot(options) {
		return metricsSnapshot(options);
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
		if (!_topicHelperCache) _topicHelperCache = createTopicHelperCache(platform.publish);
		return _topicHelperCache(name);
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
