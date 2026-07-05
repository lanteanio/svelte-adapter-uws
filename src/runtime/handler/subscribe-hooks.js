import { wsModule } from '../ws-handler-bridge.js';
import { WS_COALESCED, WS_PLATFORM, assert, drainCoalesced, processEpoch } from '../utils.js';
import { counters } from './state.js';
import { bumpOut } from './pressure-metrics.js';
import { envelopePrefix } from './envelope-cache.js';

/**
 * True when `ref` is a usable handle for subscribe acks. Numeric refs
 * are the canonical client-side shape; strings are accepted so external
 * clients that ID their requests with UUIDs interop without translation.
 *
 * @param {unknown} ref
 * @returns {ref is number | string}
 */
export function hasRef(ref) {
	return typeof ref === 'number' || typeof ref === 'string';
}

/**
 * Run the user's subscribe hook (if any) and translate its return value
 * into either `null` (allow) or a string denial reason. The hook may
 * return `false` (deny with the default `'FORBIDDEN'`), a string (use
 * that string verbatim as the reason - the framework recognises
 * `'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_TOPIC' | 'RATE_LIMITED'`
 * but does not enforce the enum), or anything else (allow). Async hooks
 * are supported: the return value is awaited before its truthiness is
 * inspected, so `async () => false` denies just like `() => false`.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @returns {Promise<string | null>}
 */
export async function runSubscribeHook(ws, topic) {
	if (!wsModule.subscribe) return null;
	try {
		const result = await wsModule.subscribe(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
		if (result === false) return 'FORBIDDEN';
		if (typeof result === 'string') return result;
		return null;
	} catch (err) {
		// Fail closed: a hook that throws (or rejects) denies access
		// rather than falling through to allow. Surfaces as a canonical
		// 'INTERNAL_ERROR' reason on the wire so the client can distinguish
		// it from 'FORBIDDEN' / 'UNAUTHENTICATED' / etc. Logging the actual
		// error keeps the cause visible without blowing up the message handler.
		console.error('[ws] subscribe hook threw:', err);
		return 'INTERNAL_ERROR';
	}
}

/**
 * Run the user's `subscribeBatch` hook (if any) once for an entire
 * batch of pre-validated topics. Returns a normalized denial map -
 * each entry is either a string denial reason or absent (= allow).
 * Returns `null` when no batch hook is exported, signalling the caller
 * to fall back to the per-topic `subscribe` hook (or open access).
 *
 * The user hook returns a `Record<string, boolean | string>` where
 * `false` means FORBIDDEN, a string is the verbatim reason, and any
 * other value (or absent key) means allow. Returning `undefined` or
 * an empty object both mean "allow everything". Async hooks are
 * supported: the returned map is awaited before its entries are read.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string[]} topics
 * @returns {Promise<Record<string, string> | null>}
 */
export async function runSubscribeBatchHook(ws, topics) {
	if (!wsModule.subscribeBatch) return null;
	let result;
	try {
		result = await wsModule.subscribeBatch(ws, topics, { platform: ws.getUserData()[WS_PLATFORM] });
	} catch (err) {
		// Fail closed: deny every topic in the batch with 'INTERNAL_ERROR'
		// so a throwing (or rejecting) hook cannot let unauthorized
		// subscribes through.
		console.error('[ws] subscribeBatch hook threw:', err);
		/** @type {Record<string, string>} */
		const failed = {};
		for (let i = 0; i < topics.length; i++) failed[topics[i]] = 'INTERNAL_ERROR';
		return failed;
	}
	/** @type {Record<string, string>} */
	const denials = {};
	if (!result || typeof result !== 'object') return denials;
	for (const [topic, val] of Object.entries(result)) {
		if (val === false) denials[topic] = 'FORBIDDEN';
		else if (typeof val === 'string') denials[topic] = val;
		// truthy / true / undefined -> allow (skip)
	}
	return denials;
}

/**
 * Run the user's subscribe-hook chain for a single topic, mirroring the
 * precedence the wire-level subscribe-batch handler uses: if `subscribeBatch`
 * is exported, treat the single subscribe as a 1-element batch and route
 * through it; otherwise fall back to the per-topic `subscribe` hook. This
 * way a user who exports only `subscribeBatch` for centralized auth gets
 * their gate fired for individual subscribes too - not just batch frames.
 *
 * Used by `platform.subscribe`, `platform.checkSubscribe`, and the wire-
 * level single-subscribe path so all three entry points share one decision
 * function. Fail-closed semantics inherited from the helpers above.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @returns {Promise<string | null>}
 */
export async function runUserSubscribeGate(ws, topic) {
	const batchDenials = await runSubscribeBatchHook(ws, [topic]);
	if (batchDenials !== null) {
		return batchDenials[topic] ?? null;
	}
	return await runSubscribeHook(ws, topic);
}

/**
 * Whether the app exported an explicit subscribe-authorization hook
 * (`subscribe` or `subscribeBatch`). Read by the wire-subscribe authorization
 * gate: with `subscribeAuth.enabled` set, a client subscribe to a topic the
 * server did not pre-authorize is hard-denied ONLY when no app hook exists - an
 * app that ships its own gate keeps full control (its hook decides every
 * topic). Cheap boolean read of the statically-imported handler module.
 *
 * @returns {boolean}
 */
export function hasUserSubscribeHook() {
	return !!(wsModule.subscribe || wsModule.subscribeBatch);
}

/**
 * Send a `subscribed` ack frame to the client when it provided a `ref`
 * with its subscribe op. No frame goes out for ref-less subscribes
 * (old clients) so backward compatibility is preserved.
 *
 * Carries the topic's current seq-space generation as `epoch` so a later
 * resume can tell whether the seq space it last saw still exists. The
 * value comes from the per-connection platform's `topicEpoch(topic)`: a
 * single worker returns the one per-process generation for every topic,
 * while a backend with its own per-topic seq authority (a shared store)
 * returns that topic's stored generation - so the same wire field carries
 * the right value per deployment with no wire change. The extra key is
 * additive: an old client ignores it and behaves exactly as before.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @param {number | string | null} ref
 */
export function sendSubscribed(ws, topic, ref) {
	if (ref === null) return;
	// epoch is an additive best-effort field. A throw in the live topicEpoch
	// delegate (a per-topic store authority can be wired here in a cluster)
	// must not block the ack or be charged to counters.closedWsAborts - that counter is
	// strictly for a closed-socket send failure. Fall back to PROCESS_EPOCH and
	// still send the ack.
	let epoch = processEpoch();
	try {
		const p = ws.getUserData()[WS_PLATFORM];
		if (p && typeof p.topicEpoch === 'function') epoch = p.topicEpoch(topic);
	} catch { epoch = processEpoch(); }
	const payload = JSON.stringify({ type: 'subscribed', topic, ref, epoch });
	try { ws.send(payload, false, false); } catch { counters.closedWsAborts++; return; }
	bumpOut(ws, payload);
}

/**
 * Send a `subscribe-denied` ack frame. Same back-compat rule as
 * `sendSubscribed` - silent when the client did not supply a `ref`.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} topic
 * @param {number | string | null} ref
 * @param {string} reason
 */
export function sendSubscribeDenied(ws, topic, ref, reason) {
	if (ref === null) return;
	const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
	try { ws.send(payload, false, false); } catch { counters.closedWsAborts++; return; }
	bumpOut(ws, payload);
}

/**
 * Drain any pending coalesce-by-key messages on a single connection.
 * Serializes lazily: only the surviving (latest) value per key pays
 * JSON.stringify cost.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 */
export function flushCoalescedFor(ws) {
	let userData;
	try { userData = ws.getUserData(); }
	catch { counters.closedWsAborts++; return; }
	const pending = userData[WS_COALESCED];
	if (!pending || pending.size === 0) return;
	assert(pending instanceof Map, 'coalesce.pending-type', null);
	let aborted = false;
	drainCoalesced(pending, (msg) => {
		if (aborted) return 2;
		assert(typeof msg.topic === 'string', 'coalesce.entry-topic-type', null);
		assert(typeof msg.event === 'string', 'coalesce.entry-event-type', null);
		const payload = envelopePrefix(msg.topic, msg.event) + JSON.stringify(msg.data ?? null) + '}';
		let result;
		try { result = ws.send(payload, false, false); }
		catch {
			// Socket closed mid-drain. There will be no further `drain`
			// event to retry on, so dropping the rest of the buffer is the
			// only correct outcome - returning 0 (enqueued-under-backpressure,
			// which is drainCoalesced's "stop" signal) clears the current
			// entry and halts the loop; `pending.clear()` below wipes the rest.
			counters.closedWsAborts++;
			aborted = true;
			return 0;
		}
		// `result` is the raw uWS send status and MUST propagate to
		// drainCoalesced: 1=sent removes the entry and continues; 0=enqueued-
		// under-backpressure removes it and halts; 2=dropped retains the entry
		// for retry on next drain. Don't refactor away the explicit return -
		// a previous refactor did and silently lost every DROPPED message.
		if (result !== 2) bumpOut(ws, payload);
		return result;
	});
	if (aborted) pending.clear();
}
