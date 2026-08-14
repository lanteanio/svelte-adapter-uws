import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCookies, createCookies } from './runtime/cookies.js';
import { parse_origin, esc, isValidWireTopic, createScopedTopic, createTopicHelperCache, resolveRequestId, completeEnvelope, completeGameEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, nextTopicSeq, stampSeq, throwInvalidSeq, createHlc, processEpoch, isAuthOriginAccepted, isOriginAllowed, assert, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_LEASE, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './runtime/utils.js';
import { createLeaseState, leaseGrantFrame, controlFrameTooLargeFrame, DEFAULT_GRANT } from './runtime/wire.js';
import { isAuthorizationHook, releaseDerivedSubscriptions, beginPendingSubscribe, pendingSubscribeTotal, settlePendingSubscribe, settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership, tombstonePendingSubscribe, isPendingSubscribeCancelled, WS_REVOKED_UNSUBSCRIBE } from './runtime/utils/ws-symbols.js';
import { deniesWireSystemTopicSubscribe, deniesWireSubscribePreHook, deniesWireSubscribeLanding, wantsRecover, recoverIsRevoked, exceedsSubscriptionCap, exceedsPendingSubscribeCap, deniesUngrantedObserve } from './runtime/utils/subscribe-policy.js';
import {
	assertWireSubscribeAuthorization,
	assertProtectiveNumber,
	unknownOptionKeys,
	DEFAULT_MAX_PAYLOAD_LENGTH
} from './config-guards.js';
import { assertBatchSequenceAuthority, assertBatchEntrySequenceAuthority } from './runtime/handler/cluster-sequence-policy.js';
import { createMessageAdmission, messageOverloadedFrame, runAdmittedMessageHook, runAdmittedMessageWork } from './runtime/utils/message-admission.js';
import { snapshotUpgradeHeaders } from './runtime/utils/upgrade-headers.js';
import { emitOperationalDiagnostic, viteHandlerFailureDiagnostic, viteHandlerRecoveredDiagnostic } from './runtime/utils/operational-diagnostic.js';
import { trace } from './runtime/tracing.js';
import { emitOperationalEvent, diagnosticError } from './runtime/diagnostic.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine, adapterErrorMessage } from './runtime/error-registry.js';

/**
 * Options the dev plugin honors, mirroring `UWSPluginOptions` in vite.d.ts.
 *
 * Deliberately an explicit list rather than a derived one, for the same reason
 * the type is an explicit `Pick`: a flag added to the adapter's
 * `WebSocketOptions` is NOT honored here until it is wired in this file, so
 * accepting it silently would promise dev enforcement that does not exist. Keep
 * this set and the type in step - a key here that the type omits is a key an
 * app cannot pass without a type error, and the reverse is a silent drop.
 */
const KNOWN_PLUGIN_OPTION_KEYS = new Set([
	'path',
	'handler',
	'authPath',
	'allowedOrigins',
	'allowSystemTopicSubscribe',
	'allowNonAsciiTopics',
	'authPathRequireOrigin',
	'authorizeWireSubscribe',
	'maxPayloadLength',
	'messageAdmission',
	'devSkipOriginCheck',
	'timeoutMs'
]);

function viteDiagnosticEndpoint(server) {
	const configured = server?.config?.server ?? {};
	return {
		host: typeof configured.host === 'string' ? configured.host : null,
		port: Number.isInteger(configured.port) ? configured.port : null
	};
}
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './runtime/handler/ingress.js';
import { registerGameIngress } from './runtime/handler/game-ingress.js';
import { now, monotonicNow, randomFloat, randomU32, randomUuid, randomBytes } from './runtime/runtime.js';

/**
 * Vite plugin that provides WebSocket support during development.
 *
 * Uses the same subscribe/unsubscribe/publish protocol as the production
 * uWS handler, so the client store works identically in dev and prod.
 *
 * @param {import('./vite.d.ts').UWSPluginOptions} [options]
 * @returns {import('vite').Plugin}
 */
export default function uws(options = {}) {
	// The dev plugin reads a FLAT option bag, so it has both of the failure
	// modes the adapter build guards against: a misshaped value on a
	// restrictive flag, and an unrecognized key dropped in silence. The second
	// bites harder here than in production - a typo'd `authorizeWireSubcribe`
	// leaves dev wide open while the developer's own manual testing shows the
	// app working, so the misconfiguration is discovered in production or not
	// at all.
	assertWireSubscribeAuthorization(options, 'authorizeWireSubscribe', 'the uws() dev plugin option authorizeWireSubscribe');
	// The dev plugin's numeric options are guarded on the same terms as the
	// adapter's: a string from process.env does not become a resource bound.
	assertProtectiveNumber(options, 'maxPayloadLength', 'the uws() dev plugin option maxPayloadLength', {
		allowZero: false,
		// ws stores the receiver limit in a signed 32-bit integer, exactly as uWS
		// does on the production surface. The bound belongs to the shared guard so
		// the three surfaces cannot drift: this one was previously a hand-rolled
		// copy sitting after the call, and testing.js had a third spelling.
		ceiling: 0x7fffffff,
		zeroMeans:
			'ws reads maxPayload 0 as UNLIMITED, the opposite of a zero-byte ceiling. ' +
			'Use a positive byte limit instead.'
	});
	// `timeoutMs: process.env.X` is a string when set, and every
	// comparison against a non-number is false, so a misshaped value would not
	// fall back to the default - it would disable the timeout. Other adapter
	// size and timeout options are not dev-plugin options; passing one to
	// `uws()` warns as unknown.
	assertProtectiveNumber(options, 'timeoutMs', 'the uws() dev plugin option timeoutMs');
	const unknownPluginKeys = unknownOptionKeys(options, KNOWN_PLUGIN_OPTION_KEYS);
	if (unknownPluginKeys.length) {
		console.warn(
			`[adapter-uws] unknown uws() plugin option(s): ${unknownPluginKeys.join(', ')} - ` +
			'not recognized by the dev plugin and ignored. Check the spelling against ' +
			'UWSPluginOptions in vite.d.ts. Note the dev plugin takes these FLAT, not under ' +
			'a `websocket` key as svelte.config.js does.'
		);
	}

	const wsPath = options.path || '/ws';
	const wsAuthPath = options.authPath || '/__ws/auth';
	// One source of truth for both the actual ws receiver cap and the value app
	// code reads from platform. Production uses the same 1 MiB default.
	const MAX_PAYLOAD_LENGTH_V = options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;
	const messageAdmission = createMessageAdmission(options.messageAdmission);
	const rejectApplicationMessageV = (wrapped, rejection) => {
		const frame = messageOverloadedFrame(rejection);
		try { wrapped.send(frame, false, false); bumpOutV(wrapped.getUserData(), frame); } catch {}
	};
	const runIngressApplicationWorkV = (wrapped, context) =>
		dispatchIngressFrame(wrapped, wrapped.getUserData(), context.data, context.platform);
	const runGameApplicationWorkV = (wrapped, context) => {
		const msg = context.msg;
		const gud = wrapped.getUserData();
		const grantTopic = gud?.[WS_PUBLISH_GRANT];
		if (!grantTopic || typeof msg.event !== 'string') {
			const reason = grantTopic ? 'INVALID' : 'FORBIDDEN';
			const denied = msg.id === undefined
				? JSON.stringify({ type: 'game-denied', reason })
				: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
			wrapped.send(denied);
			bumpOutV(gud, denied);
			return;
		}
		context.platform.publishGame(wrapped, grantTopic, msg.event, msg.data, msg.id);
	};
	// Mirror production: block client-initiated subscribes to `__`-prefixed
	// system topics by default. A registered plugin namespace may reach its hook,
	// but landing still requires tracked membership. Apps that need the broad
	// opt-out can pass `allowSystemTopicSubscribe: true` to the dev plugin.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V = options.allowSystemTopicSubscribe === true;
	// Mirror production: wire topics default to printable ASCII only.
	const ALLOW_NON_ASCII_TOPICS_V = options.allowNonAsciiTopics === true;
	// Mirror production wire-subscribe authorization (see handler.js). `let` so
	// `platform.authorizeWireSubscribe()` can arm it at runtime the way the
	// framework does; seeded from the config option for the static path.
	let SUBSCRIBE_AUTHZ_V = options.authorizeWireSubscribe === true || options.authorizeWireSubscribe === 'strict';
	let SUBSCRIBE_AUTHZ_STRICT_V = options.authorizeWireSubscribe === 'strict';
	// A plugin's side-effect hook does not count as the app taking over the topic
	// decision, matching production. See WS_HOOK_SIDE_EFFECT_ONLY.
	const hasUserSubscribeHookV = () =>
		isAuthorizationHook(userHandlers.subscribe) || isAuthorizationHook(userHandlers.subscribeBatch);
	// Mirror production CSRF defense for the authenticate POST endpoint.
	// Same opt-out shape as the production handler: pass
	// `authPathRequireOrigin: false` to the dev plugin to accept native
	// (non-browser) clients without `x-requested-with` / `Sec-Fetch-Site`
	// / matching `Origin`.
	const AUTH_PATH_REQUIRE_ORIGIN_V = options.authPathRequireOrigin !== false;
	const ALLOWED_ORIGINS_V = /** @type {'*' | 'same-origin' | string[]} */ (options.allowedOrigins ?? 'same-origin');
	// The ORIGIN env pin, read the same way production reads it. Under
	// `same-origin` without a pin the check compares the request Origin against
	// the Host header, both of which a non-browser client supplies - so the pin
	// is what makes that mode mean anything. Dev honouring it too keeps the dev
	// server from being quietly more permissive than the deployment.
	const PINNED_ORIGIN_V = parse_origin(process.env.ORIGIN || undefined);

	/** @type {import('ws').WebSocketServer | undefined} */
	let wss;

	/** @type {Map<import('ws').WebSocket, Set<string>>} */
	const subscriptions = new Map();

	/** @type {Set<import('ws').WebSocket>} */
	const connections = new Set();

	/** @type {Map<import('ws').WebSocket, object>} */
	const wsWrappers = new Map();

	/** @type {{ upgrade?: Function, open?: Function, message?: Function, close?: Function, drain?: Function, subscribe?: Function, subscribeBatch?: Function, unsubscribe?: Function, resume?: Function, authenticate?: Function }} */
	let userHandlers = {};
	let sendToAsyncWarnedV = false;

	// Per-topic seq counter for the client-publish (`game`) lane. Dev skips
	// per-topic seq on the regular publish/cursor lanes (see publishBatched),
	// but the game lane's authoritative seq IS its contract - a client's
	// prediction-reconcile must behave the same in `vite dev` as in prod - so
	// the game envelope carries a stamped seq here too.
	/** @type {Map<string, number>} */
	const gameTopicSeqs = new Map();

	/**
	 * Wrap a ws WebSocket to mimic the uWS WebSocket API.
	 * @param {import('ws').WebSocket} rawWs
	 * @param {unknown} userData
	 */
	function wrapWebSocket(rawWs, userData) {
		const topics = subscriptions.get(rawWs) || new Set();
		return {
			send(message, isBinary = false, _compress = false) {
				if (rawWs.readyState !== 1) return 0;
				rawWs.send(typeof message === 'string' ? message : Buffer.from(message));
				return 1;
			},
			close() { rawWs.close(); },
			end(code, message) { rawWs.close(code, message?.toString()); },
			subscribe(topic) { topics.add(topic); return true; },
			unsubscribe(topic) { topics.delete(topic); return true; },
			publish(topic, message, isBinary = false, _compress = false) {
				const msg = typeof message === 'string' ? message : Buffer.from(message);
				for (const [ws, wsTopics] of subscriptions) {
					if (ws !== rawWs && wsTopics.has(topic) && ws.readyState === 1) {
						ws.send(msg);
					}
				}
				return true;
			},
			isSubscribed(topic) { return topics.has(topic); },
			getTopics() { return [...topics]; },
			getUserData() { return userData; },
			getBufferedAmount() { return rawWs.bufferedAmount || 0; },
			getRemoteAddress() {
				// uWS returns raw binary bytes (4 for IPv4, 16 for IPv6).
				const ip = rawWs._socket?.remoteAddress || '127.0.0.1';
				const v4 = ip.replace(/^::ffff:/, '');
				const parts = v4.split('.');
				if (parts.length === 4) return new Uint8Array(parts.map(Number)).buffer;
				// IPv6: expand :: into zeroes, pack 8 groups into 16 bytes
				const halves = v4.split('::');
				const left = halves[0] ? halves[0].split(':') : [];
				const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
				const pad = Array(8 - left.length - right.length).fill('0');
				const groups = [...left, ...pad, ...right].map(g => parseInt(g, 16));
				const buf = new Uint8Array(16);
				for (let i = 0; i < 8; i++) {
					buf[i * 2] = (groups[i] >> 8) & 0xff;
					buf[i * 2 + 1] = groups[i] & 0xff;
				}
				return buf.buffer;
			},
			getRemoteAddressAsText() {
				return new TextEncoder().encode(rawWs._socket?.remoteAddress || '127.0.0.1').buffer;
			},
			cork(fn) { fn(); }
		};
	}

	/**
	 * Publish to all subscribers of a topic.
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @param {{ relay?: boolean, excludeWs?: object }} [options] - `relay` is
	 *   accepted for API parity with production and ignored in dev
	 *   (single-process). `excludeWs` withholds delivery from that one
	 *   connection - matched as either the uWS-shaped wrapper handlers
	 *   receive or the underlying raw socket - mirroring the production
	 *   sender-exclusion contract.
	 * @returns {boolean}
	 */
	function publish(topic, event, data, options) {
		// Mirror the production `{ jitterMs }` de-herd window stamp (platform.publish):
		// carry the window so each client rolls its own dispatch delay.
		const jitterMs = (options && typeof options.jitterMs === 'number' && options.jitterMs > 0) ? options.jitterMs : null;
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + (jitterMs == null ? '}' : ',"j":' + jitterMs + '}');
		if (resumeBuffersV.size > 0) captureResumeFrameV(topic, envelope);
		const excludeWs = (options && options.excludeWs) || null;
		let sent = false;
		for (const [ws, topics] of subscriptions) {
			if (excludeWs !== null && (ws === excludeWs || wsWrappers.get(ws) === excludeWs)) continue;
			if (topics.has(topic) && ws.readyState === 1) {
				ws.send(envelope);
				sent = true;
			}
		}
		return sent;
	}

	/**
	 * Dev-mode equivalent of `platform.publishBatched`. Same wire shape
	 * as production - one `{type:'batch',events:[...]}` frame per
	 * cap-able subscriber, fall back to N individual frames per old
	 * client. Note: dev mode does not currently stamp per-topic seq on
	 * publish frames, so batch events emitted in dev carry no `seq`
	 * field. Tests that need to exercise the seq protocol should run
	 * against `createTestServer` (testing.js).
	 *
	 * @param {Array<{ topic: string, event: string, data?: unknown, options?: { relay?: boolean, seq?: boolean } }>} messages
	 */
	function publishBatched(messages) {
		if (!Array.isArray(messages) || messages.length === 0) return;
		messages = collapseByCoalesceKey(messages);
		if (messages.length === 0) return;
		const firstTopic = messages[0].topic;
		let allSameTopic = true;
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
		}
		let allSeeAll = allSameTopic;
		let batchTopics = null;
		if (!allSameTopic) {
			batchTopics = new Set();
			for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
			allSeeAll = true;
			for (const [ws, topics] of subscriptions) {
				if (ws.readyState !== 1 || topics.size === 0) continue;
				let touchesAny = false;
				let touchesAll = true;
				for (const t of batchTopics) {
					if (topics.has(t)) touchesAny = true;
					else touchesAll = false;
				}
				if (touchesAny && !touchesAll) { allSeeAll = false; break; }
			}
		}
		if (!allSameTopic && !allSeeAll) {
			// Slow-path fallback: per-event publish() so the caller
			// pays no penalty on small / disjoint batch shapes (parity
			// with the production handler).
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				publish(m.topic, m.event, m.data, m.options);
			}
			return;
		}
		// Fast path: build envelopes and a shared batch frame.
		const events = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			events[i] = {
				topic: m.topic,
				env: '{"topic":' + esc(m.topic) + ',"event":' + esc(m.event) + ',"data":' + JSON.stringify(m.data ?? null) + '}'
			};
		}
		// A caps-less resuming connection receives these as per-event JSON.
		if (resumeBuffersV.size > 0) {
			for (let i = 0; i < events.length; i++) captureResumeFrameV(events[i].topic, events[i].env);
		}
		const slice = new Array(events.length);
		for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
		const sharedBatchEnv = wrapBatchEnvelope(slice);
		for (const [ws, topics] of subscriptions) {
			if (ws.readyState !== 1) continue;
			let receives = false;
			if (allSameTopic) {
				receives = topics.has(firstTopic);
			} else {
				for (const t of batchTopics) {
					if (topics.has(t)) { receives = true; break; }
				}
			}
			if (!receives) continue;
			const userData = /** @type {any} */ (ws).__userData || {};
			const caps = userData[WS_CAPS];
			if (caps && caps.has('batch')) {
				ws.send(sharedBatchEnv);
				bumpOutV(userData, sharedBatchEnv);
			} else {
				for (let i = 0; i < events.length; i++) {
					ws.send(events[i].env);
					bumpOutV(userData, events[i].env);
				}
			}
		}
	}

	/**
	 * Send to a single connection.
	 * @param {object} ws - Wrapped WebSocket
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @returns {number}
	 */
	function send(ws, topic, event, data) {
		const payload = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
		const result = ws.send(payload, false, false) ?? 1;
		bumpOutV(ws.getUserData(), payload);
		return result;
	}

	/**
	 * Send to connections matching a filter (by userData).
	 * @param {(userData: any) => boolean} filter
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @returns {number}
	 */
	function sendTo(filter, topic, event, data) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
		let count = 0;
		for (const [, wrapped] of wsWrappers) {
			const decision = filter(wrapped.getUserData());
			if (decision && typeof decision.then === 'function') {
				if (!sendToAsyncWarnedV) {
					sendToAsyncWarnedV = true;
					console.error(
						'[adapter-uws] platform.sendTo filter returned a Promise; treating as fail-closed.\n' +
						'  Resolve filter inputs into userData from your `upgrade` hook so the\n' +
						'  filter can read them synchronously.\n' +
						'  See: https://svti.me/sendto-async'
					);
				}
				continue;
			}
			if (decision) {
				wrapped.send(envelope);
				bumpOutV(wrapped.getUserData(), envelope);
				count++;
			}
		}
		return count;
	}

	// Dev-mode parity for the per-connection traffic counters surfaced via
	// CloseContext. Cost is irrelevant in dev so the helpers run
	// unconditionally; the slot is always populated on open.
	function bumpInV(userData, payload) {
		const stats = userData?.[WS_STATS];
		if (!stats) return;
		stats.messagesIn++;
		stats.bytesIn += typeof payload === 'string' ? payload.length : payload.byteLength;
	}
	function bumpOutV(userData, payload) {
		const stats = userData?.[WS_STATS];
		if (!stats) return;
		stats.messagesOut++;
		stats.bytesOut += typeof payload === 'string' ? payload.length : payload.byteLength;
	}

	let nextRequestRefV = 1;

	// The documented dev default for `platform.request()`. Resolved HERE, at
	// plugin scope, because both call sites take their own `options` parameter -
	// which shadows the plugin bag of the same name, so `uws({ timeoutMs })` was
	// read as the per-call argument, found absent, and fell through to the
	// hardcoded default. Documented, type-exposed, allowlisted (so the new
	// unknown-key warning stayed quiet for it), and dead.
	const defaultRequestTimeoutMs =
		typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 5000;

	/**
	 * Dev-mode equivalent of `platform.request`. Same wire contract as
	 * production so apps that work in dev work in prod.
	 * @param {object} wrapped
	 * @param {string} event
	 * @param {unknown} [data]
	 * @param {{ timeoutMs?: number }} [options]
	 * @returns {Promise<unknown>}
	 */
	function request(wrapped, event, data, options) {
		const userData = wrapped.getUserData();
		let pending = userData[WS_PENDING_REQUESTS];
		if (!pending) {
			pending = new Map();
			userData[WS_PENDING_REQUESTS] = pending;
		}
		if (pending.size >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
			return Promise.reject(new Error(
				'pending requests exceeded ' + MAX_PENDING_REQUESTS_PER_CONNECTION +
				' on this connection'
			));
		}
		const ref = nextRequestRefV++;
		const timeoutMs = (options && options.timeoutMs) || defaultRequestTimeoutMs;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (pending.delete(ref)) reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT)));
			}, timeoutMs);
			pending.set(ref, { resolve, reject, timer });
			const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
			wrapped.send(payload);
			bumpOutV(wrapped.getUserData(), payload);
		});
	}

	// Dev-mode hybrid logical clock, mirroring production via the one shared
	// factory. Same {wall, logical, nodeId} shape and non-decreasing wall +
	// logical tiebreaker rule, sourced from the same injectable runtime module
	// so dev and prod share one swappable clock and RNG a harness can seed.
	const devHlc = createHlc();

	// Dev-mode platform - same API shape as production. Every primitive on
	// the production base platform must exist here too, even when dev
	// degrades it to a no-op or zero-valued snapshot. Downstream wrappers
	// (extensions packages, app-level platform decorators) capture method
	// references via `platform.X.bind(platform)` at construction time, and
	// silently-undefined properties become "Cannot read properties of
	// undefined (reading 'bind')" on the first message. Missing surface in
	// dev defeats the dev/prod parity contract.
	// Per-dev-server LRU cache of scoped topic helpers, bound to this closure's
	// publish on first platform.topic() call (see createTopicHelperCache).
	/** @type {((name: string) => ReturnType<typeof createScopedTopic>) | null} */
	let _topicHelperCache = null;
	// --- Resume-cutover live-frame barrier (dev twin of handler/resume-buffer.js) ---
	// Dev mode stamps no per-topic seq on ordinary publishes, so this holds the live
	// frames a topic misses during an async resume await and flushes them on cutover
	// WITHOUT seq dedup - it delivers the otherwise-lost frame (at-least-once in the
	// rare async-backend race). The in-memory replay plugin resumes synchronously, so
	// its buffer stays empty and this is a no-op.
	const resumeBuffersV = new Map();
	const MAX_RESUME_BUFFERED_FRAMES_V = 4096;
	function captureResumeFrameV(topic, env) {
		const set = resumeBuffersV.get(topic);
		if (set === undefined) return;
		for (const b of set) {
			if (b.frames.length >= MAX_RESUME_BUFFERED_FRAMES_V) { b.overflow = true; continue; }
			b.frames.push(env);
		}
	}
	function beginResumeCaptureV(topics, ws) {
		const entries = [];
		for (const topic of topics) {
			const buffer = { frames: [], overflow: false };
			let set = resumeBuffersV.get(topic);
			if (set === undefined) { set = new Set(); resumeBuffersV.set(topic, set); }
			set.add(buffer);
			entries.push({ topic, buffer });
		}
		return { ws, entries };
	}
	function unregisterResumeV(entry) {
		const set = resumeBuffersV.get(entry.topic);
		if (set === undefined) return;
		set.delete(entry.buffer);
		if (set.size === 0) resumeBuffersV.delete(entry.topic);
	}
	function discardResumeCaptureV(handle) {
		for (const entry of handle.entries) unregisterResumeV(entry);
	}
	function flushResumeTopicV(handle, topic) {
		const entry = handle.entries.find((e) => e.topic === topic);
		if (entry === undefined) return;
		const ws = handle.ws;
		if (ws.readyState !== 1) { unregisterResumeV(entry); return; }
		if (entry.buffer.overflow) {
			// Overflow: signal truncation FIRST so the resync marker is not lost
			// behind the partial flush (mirror of production).
			ws.send('{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}');
		}
		for (const env of entry.buffer.frames) ws.send(env);
		unregisterResumeV(entry);
		// Drop the entry from the handle too, so a repeat flush for this topic is a
		// no-op and the batch final-sweep discard only touches un-flushed topics.
		const ei = handle.entries.indexOf(entry);
		if (ei !== -1) handle.entries.splice(ei, 1);
	}

	const platform = {
		// The observer lane's deny-unwind (authorizeDerivedSubscribe) runs the
		// app's unsubscribe hook through this slot - the shared primitive has
		// no reference to this server's hook container. See
		// WS_REVOKED_UNSUBSCRIBE.
		[WS_REVOKED_UNSUBSCRIBE](ws, topic, ud) {
			userHandlers.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
		},
		publish,
		publishBatched,
		// Binary wire (publishWire/sendWire) is a production transport
		// optimization. Dev mode delegates to the JSON publish/send: a
		// binary-capable client receives JSON text frames, which its cursor
		// store consumes identically (the binary path is transparent and
		// optional). This mirrors dev's existing simpler-than-prod posture
		// (dev also skips per-topic seq stamping). The full binary `0x03` path
		// ships and is tested in production (src/runtime/handler.js) and the test
		// server (testing.js). Publish options flow through unchanged, so
		// sender exclusion (`excludeWs`) behaves identically in dev.
		publishWire(topic, event, data, _wire, options) {
			return publish(topic, event, data, options);
		},
		sendWire(ws, topic, event, data, _wire) {
			return send(ws, topic, event, data);
		},
		// The batched wire forms delegate to N per-entry JSON deliveries - the
		// same degradation the production walk applies to a JSON-only
		// connection, so dev observes byte-identical envelopes. Per-entry
		// sender exclusion flows through publishWire's options.
		publishWireBatch(topic, event, entries, _wire, options) {
			// Same refusal as production and the harness, checked before the
			// entries: dev routes every entry through publish() with one shared
			// options object, so a numeric seq would stamp them all identically
			// here as well - and an empty dev batch must refuse what a full one
			// refuses, or dev accepts a call production rejects.
			// Field reads rather than a spread, as production reads them: an
			// inherited or accessor-carried numeric seq must not slip a
			// refusal here that production applies.
			const opts = options == null
				? options
				: { seq: options.seq, relay: options.relay, compress: options.compress, excludeWs: options.excludeWs, jitterMs: options.jitterMs };
			assertBatchSequenceAuthority(opts);
			// Same one-read rule as production: the first publish runs application
			// toJSON, and every read for a later entry happens after it. Dev that
			// re-read them would disagree with production about what was sent.
			// Per-entry seqs are validated with production's predicate - dev must
			// refuse the call production refuses - and then carried through to
			// publish(), which stamps no seq in dev (the documented dev posture;
			// the seq protocol runs against createTestServer).
			const count = Array.isArray(entries) ? entries.length : 0;
			const datas = new Array(count);
			const excludes = new Array(count);
			let entrySeqs = null;
			for (let i = 0; i < count; i++) {
				const entry = entries[i];
				datas[i] = entry.data;
				excludes[i] = entry.excludeWs;
				// typeof, as the options lane keys: numbers validate or refuse
				// the batch, anything else falls through.
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
			let ok = false;
			for (let i = 0; i < count; i++) {
				const entrySeq = entrySeqs === null ? undefined : entrySeqs[i];
				let per = opts;
				if (excludes[i] !== undefined || entrySeq !== undefined) {
					per = { ...(opts || {}) };
					if (excludes[i] !== undefined) per.excludeWs = excludes[i];
					if (entrySeq !== undefined) per.seq = entrySeq;
				}
				ok = publish(topic, event, datas[i], per) || ok;
			}
			return ok;
		},
		sendWireBatch(ws, topic, event, entries, _wire) {
			const count = entries.length;
			const datas = new Array(count);
			for (let i = 0; i < count; i++) datas[i] = entries[i].data;
			let result = 1;
			for (let i = 0; i < count; i++) {
				result = send(ws, topic, event, datas[i]);
			}
			return result;
		},
		// The wire-codec registry feeds the production cross-worker relay's binary
		// re-encode. Dev is single-process with no relay and delegates publishWire to
		// JSON, so registration has nothing to drive: a no-op keeps the dev/prod
		// surface in parity (see the contract above) without dead machinery.
		registerWireCodec(_wire) {},
		batch(messages) {
			const results = [];
			for (let i = 0; i < messages.length; i++) {
				const { topic, event, data } = messages[i];
				results.push(publish(topic, event, data));
			}
			return results;
		},
		send,
		sendTo,
		sendCoalesced(ws, { topic, event, data }) {
			// dev runs over the `ws` library; there is no real C++ outbound
			// queue, so no backpressure to coalesce against. Immediate-send
			// matches the production happy-path observable behavior (entry
			// flushes on the first attempt with result === 0).
			send(ws, topic, event, data);
		},
		adviseReconnect(options) {
			// Dev-mode parity with the production platform: advise connected dev
			// clients to reconnect on a jittered schedule, then (default) close them.
			const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
				? Math.floor(options.windowMs) : 0;
			if (windowMs <= 0) return 0;
			const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
				? Math.floor(options.afterMs) : 0;
			const doClose = !options || options.close !== false;
			const filter = options && typeof options.filter === 'function' ? options.filter : null;
			const frame = afterMs > 0
				? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
				: '{"type":"reconnect","windowMs":' + windowMs + '}';
			let count = 0;
			for (const [, wrapped] of wsWrappers) {
				if (filter) {
					const decision = filter(wrapped.getUserData());
					if (decision && typeof decision.then === 'function') continue;
					if (!decision) continue;
				}
				wrapped.send(frame);
				bumpOutV(wrapped.getUserData(), frame);
				if (doClose && typeof wrapped.end === 'function') { try { wrapped.end(1001, 'Server draining'); } catch { /* already closed */ } }
				count++;
			}
			return count;
		},
		request,
		get connections() { return connections.size; },
		/**
		 * Dev mirror of the production tracing context. The dev server wires
		 * no tracing provider and keeps no per-connection context, so this is
		 * the same `null` production answers when tracing is not configured -
		 * present so `platform.traceContext` reads identically in both modes
		 * instead of being `undefined` under `vite dev`.
		 */
		get traceContext() { return null; },
		// The frozen vendor-neutral tracing surface. Without a provider its
		// run() path is a direct callback and current() stays null - the
		// exact production behavior when `tracing` is unset.
		trace,
		/**
		 * Dev mirror of the production divergence-diagnostic lookup. Dev runs
		 * a single process and records no divergence diagnostics, so every id
		 * answers `undefined`, exactly as production answers an unknown or
		 * expired id.
		 * @param {string} _diagnosticId
		 */
		diagnostic(_diagnosticId) { return undefined; },
		get pressure() {
			// Zero-valued snapshot rather than null so downstream code that
			// destructures `pressure.active` / `.reason` / `.topPublishers`
			// does not crash on field access.
			return {
				// Permanently null: dev runs no pressure sampler, so these zeros are
				// placeholders and never become readings. An ops dashboard developed
				// against dev therefore sees the same "not sampled yet" state it must
				// handle in production before the first tick, instead of believing
				// this worker measured 0 MB of resident memory.
				sampledAt: null,
				active: false,
				subscriberRatio: 0,
				publishRate: 0,
				memoryMB: 0,
				reason: 'NONE',
				maxBufferedBytes: 0,
				backpressuredConnections: 0,
				droppedFrames: 0,
				droppedBytes: 0,
				topPublishers: []
			};
		},
		get protection() {
			// Dev never engages upgrade admission control, so the protection
			// posture is always inert. A constant `'normal'` mirrors the
			// production getter's resolved value with no work.
			return 'normal';
		},
		get metrics() {
			// `websocket.metrics` is a build-time module path resolved by the
			// adapter build; dev mode runs the source directly with no such build
			// step, so there is no registry to expose. Always `null` in dev,
			// mirroring the production getter's surface (which is `null` when
			// `metrics` is unset).
			return null;
		},
		/**
		 * Mirrors the production `metricsSnapshot()`. Dev has no registry to
		 * collect and no worker threads to collect from, so it resolves to
		 * `null` - the same answer production gives when `metrics` is unset,
		 * which is what a scrape route written against dev will already handle.
		 *
		 * @returns {Promise<string | null>}
		 */
		metricsSnapshot() {
			return Promise.resolve(null);
		},
		onPressure(_cb) { return () => {}; },
		onPublishRate(_cb) { return () => {}; },
		async subscribe(ws, topic) {
			// Server-side subscribe with the user's `hooks.ws.subscribe`
			// authorization hook. Same contract as production: returns null
			// on success, denial reason string on failure. Awaits the user
			// hook so async hooks (the idiomatic style for hooks that touch
			// a session store or DB) gate correctly.
			if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
			const ud = ws.getUserData();
			const subs = ud?.[WS_SUBSCRIPTIONS];
			if (!(subs instanceof Set)) return 'INVALID_TOPIC';
			if (subs.has(topic)) return null;
			if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
			// In-flight authorization is bounded before the hook await, the same
			// bound production applies: pending attempts are live hook work the
			// landed cap cannot see.
			if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(ud), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) return 'RATE_LIMITED';
			// Enrolled, like the wire lanes and like production: a server-side
			// kick racing a server-side join must cancel it, not install the
			// grant a moment after `unsubscribe` answered "nothing to revoke".
			const tokenS = beginPendingSubscribe(ud, topic, subs.has(topic));
			const denial = await runUserSubscribeGateV(ws, topic);
			if (denial !== null) {
				// The hook denied, but it may have installed tracked membership
				// (a plugin join) before deciding, and a revocation may have tombstoned
				// this attempt mid-await. Settling blindly here left that membership
				// standing: the held branch below defers to a sibling attempt still in
				// flight, so when that sibling's hook denies too, every attempt leaves
				// through this exit and nothing remains to judge the membership.
				if (settleDeniedSubscribe(ud, topic, tokenS, subs.has(topic)) === 'deny-unwind') {
					unwindRevokedMembership(ws, topic);
					userHandlers.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
				}
				return denial;
			}
			// Post-await re-check: a concurrent subscribe may have raced
			// through and already added the topic during the gate await.
			if (subs.has(topic)) {
				// Held is not enough when this attempt was revoked mid-await and
				// its own hook installed the membership (a plugin join): read the
				// provenance, and unwind a grant no live authority backs.
				const heldVerdict = settleHeldSubscribe(ud, topic, tokenS);
				if (heldVerdict === 'ack') return null;
				if (heldVerdict === 'deny-unwind') {
					unwindRevokedMembership(ws, topic);
					userHandlers.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
				}
				return 'FORBIDDEN';
			}
			if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) { settlePendingSubscribe(ud, topic, tokenS); return 'RATE_LIMITED'; }
			if (!settlePendingSubscribe(ud, topic, tokenS, true)) return 'FORBIDDEN';
			ws.subscribe(topic);
			subs.add(topic);
			return null;
		},
		// `opts`, not `options`: the plugin-wide `options` is in scope here, and
		// shadowing it invites a future config read from the caller's object.
		async checkSubscribe(ws, topic, opts) {
			// Pure gate: consult the user's hook chain without subscribing.
			// Same precedence as production (subscribeBatch first, falls
			// back to subscribe). No state mutation, no cap check.
			// Observer-mode callers carry client-named snapshot topics, so their
			// alphabet must match this dev server's wire boundary.
			if (!isValidWireTopic(topic, opts && opts.requireGrant ? ALLOW_NON_ASCII_TOPICS_V : true)) {
				return 'INVALID_TOPIC';
			}
			// `requireGrant` is the observer-lane mode - "may this connection see
			// what it already holds?" - and it must not be the default, because the
			// ordinary use of this method gates BEFORE a grant exists. Same shared
			// predicate as the production runtime: without it, dev would hand out a
			// roster that production denies, and the developer's own manual testing
			// would show the permissive answer.
			const requireGrant = Boolean(opts && opts.requireGrant);
			let observerHasUserHook = false;
			if (requireGrant) {
				observerHasUserHook = hasUserSubscribeHookV();
				let granted;
				try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
				catch { return 'FORBIDDEN'; }
				if (deniesUngrantedObserve(SUBSCRIBE_AUTHZ_V, observerHasUserHook && !SUBSCRIBE_AUTHZ_STRICT_V, granted, topic)) {
					return 'FORBIDDEN';
				}
			}
			const denial = await runUserSubscribeGateV(ws, topic);
			if (denial !== null) return denial;
			if (requireGrant) {
				// Re-read after the async hook: a grant revoked inside that await must
				// not produce an allow answer after it is gone.
				let granted;
				try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
				catch { return 'FORBIDDEN'; }
				if (deniesUngrantedObserve(SUBSCRIBE_AUTHZ_V, observerHasUserHook && !SUBSCRIBE_AUTHZ_STRICT_V, granted, topic)) {
					return 'FORBIDDEN';
				}
			}
			return null;
		},
		authorizeWireSubscribe(mode = 'legacy') {
			// Mirror production: arm wire-subscribe authorization at runtime.
			if (mode !== 'legacy' && mode !== 'strict') {
				throw new TypeError("authorizeWireSubscribe mode must be 'legacy' or 'strict'");
			}
			SUBSCRIBE_AUTHZ_V = true;
			if (mode === 'strict') SUBSCRIBE_AUTHZ_STRICT_V = true;
			return SUBSCRIBE_AUTHZ_STRICT_V ? 'strict' : 'legacy';
		},
		unsubscribe(ws, topic) {
			const ud = ws.getUserData();
			const subs = ud?.[WS_SUBSCRIPTIONS];
			// BEFORE the membership early-return, as production
			// (handler/platform.js) and the in-process server (testing.js) both
			// do. Revoking a topic must release its taps and its write grant
			// whether or not the PRIMARY membership is still present, and an
			// observer socket holds only the derived tap: `cursor.snapshot` and
			// `presence.sync` subscribe `__cursor:{topic}` / `__presence:{topic}`
			// and never the base topic. Placed after the return, both statements
			// were inert in precisely the shape they were written for - the
			// revoke answered `false` and changed nothing.
			//
			// Revoking read access revokes WRITE access with it. The client-driven
			// `game` lane carries no topic and publishes to whatever binding the
			// connection holds, so a revoke that took the subscription away but
			// left the binding standing meant a kicked client kept publishing into
			// the room - silently, to everyone still in it.
			// Cancel any subscribe still parked in its authorization hook, exactly
			// as production and the in-process server do. Without this the revoke
			// returned, the parked subscribe landed afterwards, and the socket was
			// left subscribed to a topic it had just been removed from.
			const cancelledPendingV = ud ? tombstonePendingSubscribe(ud, topic) : false;
			if (ud && ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
			// And the observer taps: without this a revoked client kept receiving
			// the roster and every peer's cursor position, and for cursor kept
			// PUBLISHING, because that lane authorizes an outgoing frame by asking
			// whether the socket still holds the tap.
			releaseDerivedSubscriptions(ws, topic);
			// Cancelling an in-flight subscribe IS a removal, so it answers
			// truthfully even when no established membership was present - the
			// same contract production reports.
			if (!(subs instanceof Set) || !subs.has(topic)) return cancelledPendingV;
			ws.unsubscribe(topic);
			subs.delete(topic);
			userHandlers.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
			return true;
		},
		// Client-publish authorization (the `game` lane), mirroring the
		// production platform. A connection is bound to exactly one topic it may
		// publish to via a topicless `game` frame; the wire handler derives the
		// topic from this binding, so a client can never publish to a room it was
		// not granted. Dev's `ws.getUserData()` never throws (Node ws, not uWS),
		// so there is no closed-socket abort path here.
		grantPublish(ws, topic) {
			const ud = ws.getUserData();
			if (!ud) return false;
			ud[WS_PUBLISH_GRANT] = topic;
			return true;
		},
		revokePublish(ws) {
			const ud = ws.getUserData();
			if (!ud || ud[WS_PUBLISH_GRANT] === undefined) return false;
			ud[WS_PUBLISH_GRANT] = undefined;
			return true;
		},
		publishGrant(ws) {
			const ud = ws.getUserData();
			return ud?.[WS_PUBLISH_GRANT] ?? null;
		},
		publishGame(senderWs, topic, event, data, id) {
			// Stamp the per-room game seq and fan the game envelope out to the
			// topic's local subscribers EXCLUDING the sender (echo suppression),
			// echoing the sender's client id. Sender match handles both a raw
			// socket (the wire handler passes the connection socket) and its
			// wrapper (server-side app code), mirroring publish()'s excludeWs.
			const seq = stampSeq(undefined, gameTopicSeqs, topic);
			const env = completeGameEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, id);
			if (resumeBuffersV.size > 0) captureResumeFrameV(topic, env);
			let delivered = 0;
			for (const [ws, topics] of subscriptions) {
				if (ws === senderWs || wsWrappers.get(ws) === senderWs) continue;
				if (!topics.has(topic) || ws.readyState !== 1) continue;
				ws.send(env);
				bumpOutV(/** @type {any} */ (ws).__userData, env);
				delivered++;
			}
			return { seq, delivered };
		},
		get assertions() {
			// Dev never tracks invariant violations; production exposes a
			// live shared Map of category counts. Return a fresh empty Map
			// per read so downstream diagnostics that iterate or check size
			// see the documented "no violations" state.
			return new Map();
		},
		get closedWsAborts() {
			// Dev uses Node's `ws` library, not uWS - sockets do not
			// throw "Invalid access" when written to after close, so
			// the closed-WS abort path doesn't exist here. Mirror the
			// prod surface as a constant zero.
			return 0;
		},
		introspect() {
			// PII-free transport snapshot, mirroring the production platform over
			// the dev getters (which already return zero-valued / inert shapes).
			// topPublishers is omitted (topic names can embed ids); the dev
			// pressure getter carries no `value`, so it reads as 0.
			const p = platform.pressure;
			return {
				connections: platform.connections,
				closedWsAborts: platform.closedWsAborts,
				protection: platform.protection,
				maxPayloadLength: platform.maxPayloadLength,
				pressure: {
					sampledAt: p.sampledAt ?? null,
					active: p.active,
					reason: p.reason,
					value: p.value ?? 0,
					subscriberRatio: p.subscriberRatio,
					publishRate: p.publishRate,
					memoryMB: p.memoryMB,
					maxBufferedBytes: p.maxBufferedBytes ?? 0,
					backpressuredConnections: p.backpressuredConnections ?? 0,
					droppedFrames: p.droppedFrames ?? 0,
					droppedBytes: p.droppedBytes ?? 0
				},
				assertions: Object.fromEntries(platform.assertions)
			};
		},
		subscribers(topic) {
			let count = 0;
			for (const [, topics] of subscriptions) {
				if (topics.has(topic)) count++;
			}
			return count;
		},
		// Mirror production's per-subscriber walk over the ws -> Set<topic>
		// map that also backs subscribers(). Passes (ws, userData) so dev
		// exercises the same culling / backpressure call shape as prod.
		// getUserData() is called unguarded, matching production handler.js and
		// the dev subscribe/unsubscribe paths above (the `ws` library does not
		// throw on a closed socket, so no guard is needed or wanted here).
		forEachSubscriber(topic, fn) {
			for (const [ws, topics] of subscriptions) {
				if (!topics.has(topic)) continue;
				fn(ws, /** @type {any} */ (ws).getUserData());
			}
		},
		// Broadcast-request to every local subscriber of `topic`, mirroring
		// production platform.requestTopic; partial success per subscriber.
		requestTopic(topic, event, data, options) {
			const timeoutMs = (options && options.timeoutMs) || defaultRequestTimeoutMs;
			const targets = [];
			for (const [ws, topics] of subscriptions) {
				if (topics.has(topic)) targets.push(ws);
			}
			return Promise.all(targets.map((ws) =>
				request(ws, event, data, { timeoutMs })
					.then((reply) => ({ ok: true, reply }))
					.catch((err) => ({ ok: false, error: (err && err.message) ? err.message : String(err) }))
			));
		},
		// The same value is installed as WebSocketServer.maxPayload below, so
		// application sizing logic observes the limit the dev server enforces.
		get maxPayloadLength() { return MAX_PAYLOAD_LENGTH_V; },
		// `ws` library exposes `bufferedAmount` as a property, not a method.
		// Wrap so the surface matches production exactly.
		bufferedAmount(ws) {
			try {
				const raw = /** @type {any} */ (ws);
				if (typeof raw.getBufferedAmount === 'function') return raw.getBufferedAmount();
				return typeof raw.bufferedAmount === 'number' ? raw.bufferedAmount : 0;
			} catch { return 0; }
		},
		topic(name) {
			if (!_topicHelperCache) _topicHelperCache = createTopicHelperCache(publish);
			return _topicHelperCache(name);
		},
		/**
		 * Current generation of a topic's seq space, mirroring production.
		 * Single dev process: every topic shares the one process generation,
		 * so a resume hook compares this to the client's presented epoch to
		 * gap-fill on a match or cold-rehydrate on a mismatch.
		 * @param {string} name
		 * @returns {number}
		 */
		topicEpoch(name) {
			void name;
			return processEpoch();
		},

		// Clock and RNG, mirroring production. Both surfaces read through the
		// same injectable runtime module, so dev and prod share one swappable
		// source a controlled harness can seed.
		now: now,
		monotonic: monotonicNow,
		random: {
			float: randomFloat,
			u32: randomU32,
			uuid: randomUuid,
			bytes: randomBytes
		},
		// Causal stamp, mirroring production. Only read when an event needs a
		// causal stamp, so the per-publish hot path is untouched in dev too.
		hlc: devHlc
	};

	// Expose platform globally so hooks/load functions can access it in dev
	globalThis.__uws_dev_platform = platform;

	/** @type {Promise<void>} */
	let handlerReady;

	/** @type {import('vite').ViteDevServer | null} */
	let viteServer = null;

	/** @type {string | null} Resolved absolute path of the WS handler file */
	let resolvedHandlerPath = null;

	/** True when a handler file was found but failed to load - reject upgrades */
	let handlerFailed = false;

	/** True once a handler module has loaded and applied at least once. A later
	 *  failure is then a reload of a working handler; until it flips, every
	 *  failed load attempt - including retries on module-graph changes - is
	 *  still the initial load, and no previous handler exists to keep serving. */
	let handlerEverLoaded = false;

	/**
	 * Extract handler functions from a loaded module.
	 * @param {Record<string, any>} mod
	 */
	/**
	 * @param {unknown} ref
	 * @returns {ref is number | string}
	 */
	function hasRefValue(ref) {
		return typeof ref === 'number' || typeof ref === 'string';
	}

	/**
	 * @param {object} wrapped
	 * @param {string} topic
	 * @returns {Promise<string | null>}
	 */
	async function runSubscribeHookV(wrapped, topic) {
		if (!userHandlers.subscribe) return null;
		try {
			const result = await userHandlers.subscribe(wrapped, topic, { platform: wrapped.getUserData()[WS_PLATFORM] });
			if (result === false) return 'FORBIDDEN';
			if (typeof result === 'string') return result;
			return null;
		} catch (err) {
			console.error('[ws] subscribe hook threw:', err);
			return 'INTERNAL_ERROR';
		}
	}

	/**
	 * @param {object} wrapped
	 * @param {string[]} topics
	 * @returns {Promise<Record<string, string> | null>}
	 */
	async function runSubscribeBatchHookV(wrapped, topics) {
		if (!userHandlers.subscribeBatch) return null;
		let result;
		try {
			result = await userHandlers.subscribeBatch(wrapped, topics, { platform: wrapped.getUserData()[WS_PLATFORM] });
		} catch (err) {
			console.error('[ws] subscribeBatch hook threw:', err);
			/** @type {Record<string, string>} */
			const failed = Object.create(null);
			for (let i = 0; i < topics.length; i++) failed[topics[i]] = 'INTERNAL_ERROR';
			return failed;
		}
		// Null-prototype for the same reason as production: an empty `{}` reads
		// back every Object.prototype member name as truthy, so a topic named
		// `toString` or `constructor` would be DENIED here while production
		// allows it, and a `__proto__` key would reach the inherited setter and
		// store nothing.
		/** @type {Record<string, string>} */
		const denials = Object.create(null);
		if (!result || typeof result !== 'object') return denials;
		// Reading the hook RESULT can throw - a getter, a Proxy, a lazy ORM row.
		// This runs BETWEEN a batch's enrolment and its settle, so an escape here
		// would strand every pending entry for the connection's life as well as
		// leaving the client's ref'd frames unanswered. Fail closed
		// on the whole batch instead, and keep the shape identical to production so
		// the three surfaces stay comparable.
		try {
			for (const [topic, val] of Object.entries(result)) {
				if (val === false) denials[topic] = 'FORBIDDEN';
				else if (typeof val === 'string') denials[topic] = val;
			}
		} catch (err) {
			console.error('[ws] subscribeBatch result read threw:', err);
			/** @type {Record<string, string>} */
			const broken = Object.create(null);
			for (let i = 0; i < topics.length; i++) broken[topics[i]] = 'INTERNAL_ERROR';
			return broken;
		}
		return denials;
	}

	/**
	 * Run the user's subscribe-hook chain for a single topic, mirroring
	 * production: subscribeBatch wins if exported, else fall back to
	 * subscribe. Used by platform.subscribe, platform.checkSubscribe, and
	 * the wire-level single-subscribe path.
	 *
	 * @param {object} wrapped
	 * @param {string} topic
	 * @returns {Promise<string | null>}
	 */
	async function runUserSubscribeGateV(wrapped, topic) {
		const batchDenials = await runSubscribeBatchHookV(wrapped, [topic]);
		if (batchDenials !== null) {
			return batchDenials[topic] ?? null;
		}
		return await runSubscribeHookV(wrapped, topic);
	}

	/**
	 * @param {import('ws').WebSocket} ws
	 * @param {string} topic
	 * @param {number | string | null} ref
	 */
	function sendSubscribedV(ws, topic, ref) {
		if (ref === null) return;
		// Mirror production: carry the topic's current generation on the ack so
		// a later resume can detect a reset seq space. The dev process shares
		// the one process-generation value across every topic via the dev
		// platform's topicEpoch.
		const epoch = typeof platform.topicEpoch === 'function' ? platform.topicEpoch(topic) : processEpoch();
		const payload = JSON.stringify({ type: 'subscribed', topic, ref, epoch });
		ws.send(payload);
		bumpOutV(/** @type {any} */ (ws).__userData, payload);
	}

	/**
	 * @param {import('ws').WebSocket} ws
	 * @param {string} topic
	 * @param {number | string | null} ref
	 * @param {string} reason
	 */
	function sendDenied(ws, topic, ref, reason) {
		if (ref === null) return;
		const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
		ws.send(payload);
		bumpOutV(/** @type {any} */ (ws).__userData, payload);
	}

	function applyHandlers(mod) {
		userHandlers = {
			init: mod.init,
			shutdown: mod.shutdown,
			upgrade: mod.upgrade,
			open: mod.open,
			message: mod.message,
			close: mod.close,
			drain: mod.drain,
			subscribe: mod.subscribe,
			subscribeBatch: mod.subscribeBatch,
			unsubscribe: mod.unsubscribe,
			resume: mod.resume,
			authenticate: mod.authenticate
		};
	}

	/**
	 * Fire the user's `init` hook once the WS server is set up. Awaited
	 * so a slow async init does not race with incoming connections (the
	 * dev WSS is attached to vite's HTTP server, so connections are
	 * handled in the same process; for app-level "capture platform"
	 * patterns the await is enough to guarantee init runs first).
	 *
	 * Throws are re-thrown to surface boot failures loudly. Mirrors
	 * production `handler.js` semantics.
	 */
	let initFired = false;
	async function fireInitOnceV() {
		if (initFired) return;
		if (typeof userHandlers.init === 'function') {
			// Latch only on COMPLETION. Latching before the await would burn
			// the once-guard when init throws, so a later recovery would
			// report "no operator action is required" while the user's init
			// never ran.
			await userHandlers.init({ platform });
		}
		initFired = true;
	}

	/**
	 * Fire the user's `shutdown` hook on dev server teardown. Throws are
	 * logged-and-ignored (we cannot refuse to shut down).
	 */
	async function fireShutdownOnceV() {
		if (typeof userHandlers.shutdown === 'function') {
			try {
				await userHandlers.shutdown({ platform });
			} catch (err) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WS_SHUTDOWN_HOOK_THREW), err);
			}
		}
	}

	/**
	 * The adapter's `websocket.handler`, read from SvelteKit's resolved config.
	 *
	 * The plugin and the adapter are two halves of one package that both decide
	 * which module becomes the WS handler, and the plugin decides FIRST: it
	 * emits `ws-handler.js` into the SSR output and the adapter then takes that
	 * file as it stands. A handler named only on the adapter would therefore
	 * never be read, and the app would silently run whatever auto-discovery
	 * found instead - a different module, with a different set of authorization
	 * hooks. Reading the adapter's value here is what makes one value drive
	 * both surfaces.
	 *
	 * A null `handler` means the active config does not name one; resolution then
	 * falls back to auto-discovery, and the adapter still cross-checks what was
	 * bundled.
	 *
	 * Prefer the resolved SvelteKit plugin API over importing a config file. It
	 * carries the validated config SvelteKit is actually running, including the
	 * direct `sveltekit(config)` form (which intentionally ignores
	 * svelte.config.js), and avoids evaluating an app config a second time.
	 * Older SvelteKit releases without that API retain the file-import fallback.
	 *
	 * @param {string} root
	 * @param {{ plugins?: Array<any> } | null | undefined} resolved
	 * @returns {Promise<{ handler: string | null, from: string | null }>}
	 */
	async function adapterHandlerOption(root, resolved) {
		for (const plugin of resolved?.plugins ?? []) {
			const adapter = plugin?.api?.options?.kit?.adapter;
			if (adapter?.name !== 'adapter-uws') continue;
			const handler = adapter.websocketHandler;
			const metrics = adapter.websocketMetrics;
			return {
				handler: typeof handler === 'string' && handler ? handler : null,
				metrics: typeof metrics === 'string' && metrics ? metrics : null,
				from: 'websocket.handler in SvelteKit config',
				configName: 'SvelteKit config'
			};
		}

		for (const name of ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.cjs']) {
			const full = path.resolve(root, name);
			if (!existsSync(full)) continue;
			try {
				// Compatibility path for old SvelteKit releases that do not expose
				// the validated config through their Vite plugin API. Current Kit's
				// loader cache-busts config imports, so modern releases must take the
				// API path above to avoid evaluating app config twice.
				const mod = await import(pathToFileURL(full).href);
				const adapter = mod?.default?.kit?.adapter;
				if (adapter?.name !== 'adapter-uws') return { handler: null, metrics: null, from: null, configName: null };
				const handler = adapter.websocketHandler;
				const metrics = adapter.websocketMetrics;
				return {
					handler: typeof handler === 'string' && handler ? handler : null,
					metrics: typeof metrics === 'string' && metrics ? metrics : null,
					from: `websocket.handler in ${name}`,
					configName: name
				};
			} catch {
				return { handler: null, metrics: null, from: null, configName: null };
			}
		}
		return { handler: null, metrics: null, from: null, configName: null };
	}

	/**
	 * Resolve the WS handler module, for the dev server and the SSR build alike.
	 *
	 * Precedence: the plugin's own `handler`, then the adapter's
	 * `websocket.handler`, then auto-discovery of `src/hooks.ws.{js,ts,mjs}`.
	 * Two explicit values that disagree is a configuration error rather than a
	 * precedence question - there is no reading of the app's intent under which
	 * one of them is meant to lose silently.
	 *
	 * @param {string} root
	 * @param {{ plugins?: Array<any> } | null | undefined} resolved
	 * @returns {Promise<{ path: string, from: string } | null>}
	 */
	async function discoverHandler(root, resolved, preReadAdapterOption) {
		// `preReadAdapterOption` exists so the SSR-build path can read the adapter
		// options ONCE and share the reading between the handler and the metrics
		// registry: on old Kit the fallback imports the app's svelte.config, and
		// two independent reads would evaluate it twice.
		const adapterOption = preReadAdapterOption ?? await adapterHandlerOption(root, resolved);
		const fromAdapter = adapterOption.handler;
		// `websocket.handler` belongs to the adapter, whose non-plugin fallback
		// resolves it with path.resolve() from the project process cwd. Vite's
		// `root` is the base only for the plugin-owned `uws({ handler })` option;
		// applying it to the adapter option makes dev/build name a different file
		// whenever an app uses an explicit Vite root.
		const adapterPath = fromAdapter ? path.resolve(fromAdapter) : null;

		if (options.handler) {
			const pluginPath = path.resolve(root, options.handler);
			const pathsAgree = adapterPath === pluginPath || (
				process.platform === 'win32' &&
				adapterPath?.toLowerCase() === pluginPath.toLowerCase()
			);
			if (fromAdapter && !pathsAgree) {
				throw new Error(
					'[adapter-uws] the WebSocket handler is named twice, and the two disagree:\n' +
					`  vite.config.js    uws({ handler: ${JSON.stringify(options.handler)} })\n` +
					`  SvelteKit config  websocket.handler: ${JSON.stringify(fromAdapter)}\n` +
					'Remove one of them. The dev plugin honors the adapter\'s websocket.handler, ' +
					'so naming it once on the adapter covers dev and the build.'
				);
			}
			assertHandlerExists(pluginPath, options.handler, 'uws({ handler }) in vite.config.js');
			return { path: pluginPath, from: 'uws({ handler }) in vite.config.js' };
		}

		if (fromAdapter) {
			assertHandlerExists(adapterPath, fromAdapter, adapterOption.from ?? 'websocket.handler in SvelteKit config');
			return { path: adapterPath, from: adapterOption.from ?? 'websocket.handler in SvelteKit config' };
		}

		const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
		for (const candidate of candidates) {
			const full = path.resolve(root, candidate);
			if (existsSync(full)) return { path: full, from: `auto-discovered ${candidate}` };
		}
		return null;
	}

	/**
	 * A handler the app named as a FILE must exist. Auto-discovery may come up
	 * empty (that is its job), but a named path that does not resolve is a typo
	 * the app should hear about by name rather than as a bundler resolve error.
	 *
	 * Only file-shaped specifiers are checked. A handler may equally be a
	 * virtual module id served by another Vite plugin (`/virtual-ws-handler`,
	 * `virtual:ws`) or a bare package specifier, none of which exist on disk and
	 * all of which resolve perfectly well - checking those turns a working setup
	 * into a build failure.
	 *
	 * @param {string} full
	 * @param {string} named
	 * @param {string} where
	 */
	function assertHandlerExists(full, named, where) {
		// RELATIVE specifiers only - the documented form, and the one a typo
		// actually lands in. Everything else belongs to the resolver: an
		// extension test refused `$lib/server/ws.js` (a SvelteKit alias that both
		// the esbuild path and ssrLoadModule resolve), `my-pkg/ws.js` and
		// `@scope/pkg/ws.js`; adding absolute paths then refused Vite virtual
		// ids like `/virtual-ws-handler`, which `path.isAbsolute` calls absolute
		// on every platform and which exist only inside a plugin. Guessing wrong
		// here turns a working app into a build failure, so the guess is narrow.
		const fileShaped = named.startsWith('./') || named.startsWith('../');
		if (!fileShaped || existsSync(full)) return;
		throw new Error(
			`[adapter-uws] WebSocket handler ${JSON.stringify(named)} (${where}) does not exist.\n` +
			`  looked for: ${full}`
		);
	}

	/** SSR-build state captured in `configResolved` and consumed in `buildStart`. */
	let ssrHandler = /** @type {{ path: string, from: string } | null} */ (null);
	let ssrRoot = '';
	// The adapter's `websocket.metrics` module, resolved for the SSR build. Kept
	// beside ssrHandler because the two ride the same mechanism: emitted as a
	// chunk of the app's own Rollup pass, so modules shared with routes dedupe
	// into `chunks/` and the registry is ONE instance per module graph (one per
	// cluster worker; workers each evaluate their own graph). Bundling it
	// separately (the adapter's esbuild fallback) instantiates the module a
	// second time in any graph that also imports it: adapter counters land on
	// one copy while an app-graph import reads the other, and module-level side
	// effects run once per copy.
	let ssrMetrics = /** @type {{ path: string, source: string, from: string } | null} */ (null);
	// Rollup virtual-module id for the emitted registry entry. The entry cannot
	// be the user's module itself: its default export must be the NORMALIZED
	// registry (`default` / `metrics` / `registry`, whichever the app exported),
	// so a wrapper module does the pick and the user's module stays a plain
	// import that Rollup can dedupe with the routes.
	const METRICS_REGISTRY_ENTRY_ID = '\0adapter-uws:metrics-registry-entry';

	return {
		name: 'svelte-adapter-uws',
		config() {
			return {
				server: {
					fs: {
						// The cursor render worker loads as its own module-worker
						// entry (a `?worker_file` request). Vite's fs allow-list
						// check runs on that raw request WITHOUT the known-module
						// bypass regular page imports get, so when this package is
						// installed via a link (file:/workspace dev setups) the
						// worker chunk 403s in dev and cursors silently stay on
						// the last painted frame. Allowing the package's own
						// directory keeps the zero-config promise for linked
						// installs; for a regular node_modules install the path
						// is already allowed and this is a no-op.
						allow: [path.dirname(fileURLToPath(import.meta.url))]
					}
				}
			};
		},
		async configResolved(resolved) {
			// Capture the handler path once the resolved Vite config is
			// available. SvelteKit runs Vite 7's environment API with
			// separate `client` and `ssr` environments; `env.isSsrBuild`
			// in `config()` is `false` even during the SSR build, so we
			// detect SSR via `resolved.build.ssr` instead.
			if (resolved.build?.ssr) {
				ssrRoot = resolved.root || process.cwd();
				const adapterOption = await adapterHandlerOption(ssrRoot, resolved);
				ssrHandler = await discoverHandler(ssrRoot, resolved, adapterOption);
				// Resolved from the process cwd, NOT the Vite root, for the same
				// reason as the handler above: the adapter's esbuild fallback
				// resolves `websocket.metrics` with path.resolve() from cwd, and the
				// two sides must name the same file or the adapter's origin check
				// reports a mismatch for the module the plugin actually bundled.
				ssrMetrics = adapterOption.metrics
					? {
						path: path.resolve(adapterOption.metrics),
						source: adapterOption.metrics,
						from: `websocket.metrics in ${adapterOption.configName ?? 'SvelteKit config'}`
					}
					: null;
			}
		},
		resolveId(id) {
			if (id === METRICS_REGISTRY_ENTRY_ID) return id;
		},
		load(id) {
			if (id !== METRICS_REGISTRY_ENTRY_ID || !ssrMetrics) return;
			// The same normalization the adapter's esbuild fallback generates:
			// accept `default`, `metrics`, or `registry` exports. Read through a
			// function so Rollup does not statically bind the export names the
			// user's module happens not to have and warn about each one.
			return (
				`import * as m from ${JSON.stringify(ssrMetrics.path)};\n` +
				'const pick = (ns) => ns.default ?? ns.metrics ?? ns.registry ?? null;\n' +
				'export default pick(m);\n'
			);
		},
		buildStart() {
			// Inject the ws-handler entry directly into the active Rollup
			// pass. Runs after SvelteKit has set its own input config, so
			// our entry survives. Gated to the `ssr` environment so the
			// client build does not also try to emit a server-side file.
			//
			// `fileName: 'ws-handler.js'` forces the output to the top
			// level of the SSR output dir (overriding Vite's default of
			// putting emitFile-emitted chunks under `chunks/`). The
			// adapter's `index.js` checks `${tmp}/ws-handler.js` for the
			// Vite plugin path; matching the location keeps the second-
			// pass Rollup bundling fed correctly.
			//
			// The emitted chunk participates in Vite's chunking strategy,
			// so modules shared between hooks.ws and SvelteKit routes
			// (metrics registries, leader-election state, in-memory
			// caches) land in `chunks/` rather than getting duplicated
			// into the ws-handler bundle.
			if (this.environment?.name && this.environment.name !== 'ssr') return;
			// The metrics registry rides the same mechanism, and sharing is the
			// POINT here rather than a nicety: emitted into the app's own Rollup
			// pass, the user's registry module dedupes into `chunks/` with every
			// route that imports it, so `platform.metrics` and an app-graph
			// import read ONE instance. The adapter's standalone esbuild fallback
			// instantiates the module a second time by construction.
			if (ssrMetrics) {
				if (!existsSync(ssrMetrics.path)) {
					throw new Error(
						`[adapter-uws] websocket.metrics names '${ssrMetrics.source}', which does not exist ` +
						`(resolved from the process working directory to ${ssrMetrics.path}).`
					);
				}
				this.emitFile({
					type: 'chunk',
					id: METRICS_REGISTRY_ENTRY_ID,
					fileName: 'metrics-registry.js'
				});
				// Record WHICH module was bundled, beside the chunk, for the same
				// reason as the handler record below: the adapter takes the emitted
				// file as it stands, so without a record a substitution would ship
				// silently - here as counters incrementing on a registry no scrape
				// route reads.
				this.emitFile({
					type: 'asset',
					fileName: 'metrics-registry.origin.json',
					source: JSON.stringify({
						source: ssrMetrics.source,
						absolute: ssrMetrics.path,
						from: ssrMetrics.from
					}) + '\n'
				});
			}
			if (!ssrHandler) return;
			this.emitFile({
				type: 'chunk',
				id: ssrHandler.path,
				fileName: 'ws-handler.js'
			});
			// Record WHICH module became the handler, beside the chunk itself.
			// The adapter reads this to name the module in its build log and to
			// refuse a build whose own `websocket.handler` disagrees with what
			// was actually bundled. Without it the adapter can see only that
			// some ws-handler.js exists, which is what let a substitution pass
			// silently while the build log positively reported success.
			this.emitFile({
				type: 'asset',
				fileName: 'ws-handler.origin.json',
				source: JSON.stringify({
					source: path.relative(ssrRoot, ssrHandler.path).split(path.sep).join('/'),
					// The absolute path is what the adapter COMPARES. `source` is
					// relative to the Vite root and the adapter resolves against
					// its own cwd, so in any project where the two differ - a
					// monorepo, or an explicit Vite `root` - comparing the
					// relative form would report a mismatch for the same file.
					absolute: ssrHandler.path,
					from: ssrHandler.from
				}) + '\n'
			});
		},
		async configureServer(server) {
			// In middleware mode Vite does not own the HTTP server, so WS upgrade cannot be attached.
			if (!server.httpServer) {
				server.config.logger.warn(
					'[svelte-adapter-uws] WebSocket support requires Vite to own the HTTP server. ' +
					'It is not available in middleware mode (server.httpServer is null). ' +
					'WebSocket features will be disabled in dev.'
				);
				return;
			}

			/** @type {typeof import('ws').WebSocketServer} */
			let WebSocketServer;
			try {
				({ WebSocketServer } = await import('ws'));
			} catch {
				server.config.logger.warn(
					'[svelte-adapter-uws] The "ws" package is not installed. ' +
					'WebSocket features are disabled in dev. Install with: npm i -D ws'
				);
				return;
			}

			// Warn if our WS path collides with the Vite HMR WebSocket path.
			const hmrConfig = server.config.server?.hmr;
			if (hmrConfig && typeof hmrConfig === 'object' && hmrConfig.path === wsPath) {
				server.config.logger.warn(
					`[svelte-adapter-uws] WebSocket path "${wsPath}" collides with the Vite HMR path. ` +
					'Set a different path via the websocket.path adapter option or server.hmr.path in vite.config.'
				);
			}

			// Register the client-relay (`game` lane) binary twin (ingress kind
			// `game:1`), matching production - so a dev client can run its input
			// path over `0x03` exactly as it will in prod.
			registerGameIngress();

			wss = new WebSocketServer({
				noServer: true,
				maxPayload: MAX_PAYLOAD_LENGTH_V,
				// Echo the client's offered subprotocol. The production upgrade
				// passes Sec-WebSocket-Protocol straight through, and a client
				// that offered one (the cursor render worker dials with the
				// cursor-lane token) hard-fails its handshake when the echo is
				// missing - so dev must answer the same way or worker-rendered
				// cursors only work in production builds. With no offered
				// protocols this returns false and the header is simply omitted
				// (normal clients unaffected).
				handleProtocols: (protocols) => {
					const first = protocols.values().next().value;
					return first === undefined ? false : first;
				}
			});
			viteServer = server;
			const root = server.config.root;

			// Load the user's WebSocket handler via Vite's ssrLoadModule (handles
			// TS/aliases/etc.). Resolution goes through the SAME resolver the SSR
			// build uses, so the module dev runs is the module the build bundles.
			// Dev used to resolve independently - its own option, then
			// auto-discovery, never the adapter's `websocket.handler` - so an app
			// that named a handler on the adapter could develop against one set of
			// authorization hooks and ship another. A misconfiguration throws here
			// and aborts dev startup, which is the point: it is the same error the
			// build raises, surfaced at the earliest moment an app can see it.
			const resolvedHandler = await discoverHandler(root, server.config);

			handlerReady = (async () => {
				if (!resolvedHandler) return;
				resolvedHandlerPath = resolvedHandler.path;
				try {
					const mod = await server.ssrLoadModule(resolvedHandler.path);
					handlerFailed = false;
					applyHandlers(mod);
					handlerEverLoaded = true;
				} catch (err) {
					handlerFailed = true;
					emitOperationalDiagnostic(viteHandlerFailureDiagnostic({
						phase: 'load',
						source: resolvedHandler.from,
						...viteDiagnosticEndpoint(server),
						error: err
					}));
					// The structured record keeps a bounded name/code/message;
					// the raw error is what carries the stack, Vite frame, and
					// source location a developer needs to follow the action.
					console.error('[adapter-uws] handler load error detail:', err);
				}
			})();

			// Fire the user's `init` hook once the handler module has loaded.
			// Awaited so a throwing init surfaces during dev startup rather
			// than on first connect. Skipped if the handler failed to load.
			handlerReady = handlerReady.then(async () => {
				if (!handlerFailed) await fireInitOnceV();
			});

			// Fire the user's `shutdown` hook when the vite dev server closes
			// (Ctrl-C, restart, programmatic close). Awaited inside vite's
			// own close pipeline.
			server.httpServer?.once('close', () => { fireShutdownOnceV(); });

			// /__ws/auth middleware: runs the user's `authenticate` hook as a normal
			// HTTP POST so session cookies are refreshed via a standard Set-Cookie
			// on a 200-series response. Mirrors the production handler in dev.
			server.middlewares.use(wsAuthPath, async (req, res, next) => {
				await handlerReady;
				if (!userHandlers.authenticate) { next(); return; }
				if (req.method !== 'POST') {
					res.statusCode = 405;
					res.setHeader('allow', 'POST');
					res.setHeader('content-type', 'text/plain');
					res.end('Method Not Allowed');
					return;
				}

				/** @type {Record<string, string>} */
				const headers = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (typeof v === 'string') headers[k] = v;
					else if (Array.isArray(v)) headers[k] = v.join(', ');
				}

				if (AUTH_PATH_REQUIRE_ORIGIN_V && !isAuthOriginAccepted(headers, {
					allowedOrigins: ALLOWED_ORIGINS_V,
					// Same ORIGIN-env pin as production. Without it the `same-origin`
					// mode compares the request Origin against the Host header, which
					// a non-browser client controls - two attacker-supplied values
					// compared against each other. Dev being MORE permissive than
					// production is the direction that misleads: the developer's own
					// testing passes and the deployment refuses.
					pinnedOrigin: PINNED_ORIGIN_V,
					isTls: false,
					hasUpgradeHook: false
				})) {
					res.statusCode = 403;
					res.setHeader('content-type', 'text/plain');
					res.end('Origin not allowed');
					return;
				}

				// Read body (capped at 64 KB; the hook rarely needs it).
				const AUTH_BODY_LIMIT = 64 * 1024;
				/** @type {Buffer[]} */
				const chunks = [];
				let total = 0;
				let oversized = false;
				for await (const chunk of req) {
					total += chunk.length;
					if (total > AUTH_BODY_LIMIT) { oversized = true; break; }
					chunks.push(chunk);
				}
				if (oversized) {
					res.statusCode = 413;
					res.setHeader('content-type', 'text/plain');
					res.end('Content Too Large');
					return;
				}
				const bodyBuf = Buffer.concat(chunks);

				const origin = (req.socket?.encrypted ? 'https://' : 'http://') + (headers['host'] || 'localhost');
				const url = req.url || wsAuthPath;
				const request = new Request(origin + url, {
					method: 'POST',
					headers,
					body: bodyBuf.length > 0 ? bodyBuf : undefined,
					// @ts-expect-error
					duplex: 'half'
				});

				const cookies = createCookies(headers['cookie'], request.url);
				const clientIp = req.socket?.remoteAddress || '';
				const authRequestId = resolveRequestId(headers['x-request-id']) || randomUUID();
				const authPlatform = Object.create(platform);
				authPlatform.requestId = authRequestId;
				const event = {
					request,
					headers,
					cookies,
					url,
					remoteAddress: clientIp,
					getClientAddress: () => clientIp,
					platform: authPlatform
				};

				try {
					const result = await Promise.resolve(userHandlers.authenticate(event));

					if (result === false) {
						res.statusCode = 401;
						res.setHeader('content-type', 'text/plain');
						res.end('Unauthorized');
						return;
					}

					if (result instanceof Response) {
						res.statusCode = result.status;
						for (const [hk, hv] of result.headers) {
							if (hk === 'set-cookie' || hk === 'content-length') continue;
							res.setHeader(hk, hv);
						}
						const outCookies = [
							...result.headers.getSetCookie(),
							...cookies._serialize()
						];
						if (outCookies.length > 0) res.setHeader('set-cookie', outCookies);
						if (result.body) {
							const buf = Buffer.from(await result.arrayBuffer());
							res.end(buf);
						} else {
							res.end();
						}
						return;
					}

					res.statusCode = 204;
					const outCookies = cookies._serialize();
					if (outCookies.length > 0) res.setHeader('set-cookie', outCookies);
					res.end();
				} catch (err) {
					// Same event and echo as the production endpoint: a
					// developer verifying correlation under `vite dev` must
					// see the id and the structured record, not dev-only
					// prose.
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.authenticate',
						event: 'runtime.authenticate.failed',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'The WebSocket authentication endpoint failed.',
						attributes: { requestId: authRequestId, error: diagnosticError(err) }
					});
					res.statusCode = 500;
					res.setHeader('content-type', 'text/plain');
					if (authRequestId) res.setHeader('x-request-id', authRequestId);
					res.end('Internal Server Error');
				}
			});

			server.httpServer?.on('upgrade', async (req, socket, head) => {
				const { pathname } = new URL(req.url || '', 'http://localhost');
				if (pathname !== wsPath) return;
				// The missing-Origin branch delegates trust to an app upgrade hook.
				// Resolve the handler before reading that authority: configureServer
				// starts module loading without awaiting it, so an upgrade arriving in
				// that window used to observe an empty userHandlers object and get 403,
				// even though the same request is accepted once the hook has loaded (and
				// by production, whose handler is static before it begins listening).
				await handlerReady;

				// Mirror production: enforce allowedOrigins on the dev WSS
				// upgrade. The dev plugin runs on a localhost port that is
				// reachable from any other process on the machine - a hostile
				// page in another browser tab can connect just like it can to
				// the production endpoint, so we apply the same gate. Apps
				// that need to accept dev connections from arbitrary origins
				// can set `allowedOrigins: '*'` or pass `devSkipOriginCheck:
				// true` to the plugin.
				if (!options.devSkipOriginCheck) {
					/** @type {Record<string, string>} */
					const upgHeaders = {};
					for (const [k, v] of Object.entries(req.headers)) {
						if (typeof v === 'string') upgHeaders[k] = v;
						else if (Array.isArray(v)) upgHeaders[k] = v.join(', ');
					}
					if (!isOriginAllowed(upgHeaders['origin'], upgHeaders, {
						allowedOrigins: ALLOWED_ORIGINS_V,
						// See the auth-path check above: production honours ORIGIN as
						// the authoritative host pin, and dev must not be looser.
						pinnedOrigin: PINNED_ORIGIN_V,
						isTls: false,
						hasUpgradeHook: !!userHandlers.upgrade
					})) {
						socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nOrigin not allowed');
						socket.destroy();
						return;
					}
				}

				// If user has an upgrade handler, run it for auth
				let userData = {};
				// If the handler file exists but failed to load, reject the
				// upgrade so a broken auth handler does not silently degrade
				// to open access.
				if (handlerFailed) {
					socket.write(
						'HTTP/1.1 500 Internal Server Error\r\n' +
						'Content-Type: text/plain\r\n\r\n' +
						'WebSocket handler failed to load - check the server console'
					);
					socket.destroy();
					return;
				}

				/** @type {Record<string, string>} */
				const upgradeHeaders = {};
				for (const [key, value] of Object.entries(req.headers)) {
					if (typeof value === 'string') upgradeHeaders[key] = value;
					else if (Array.isArray(value)) upgradeHeaders[key] = value.join(', ');
				}
				const wsRequestId = resolveRequestId(upgradeHeaders['x-request-id']) || randomUUID();

				if (userHandlers.upgrade) {
					try {
						const result = await Promise.resolve(
							userHandlers.upgrade({
								headers: upgradeHeaders,
								cookies: parseCookies(upgradeHeaders['cookie']),
								url: req.url || pathname,
								remoteAddress: req.socket?.remoteAddress || '',
								requestId: wsRequestId
							})
						);
						if (result === false) {
							socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
							socket.destroy();
							return;
						}
						if (result && result.__upgradeResponse === true) {
							userData = result.userData || {};
							// Dev cannot emit custom 101 headers, but it must still reject
							// the same malformed result production rejects. Otherwise an app
							// verifies a broken upgrade in dev and only production fails.
							const responseHeaders = snapshotUpgradeHeaders(result.headers);
							if (responseHeaders && Object.keys(responseHeaders).length > 0) {
								const hasSetCookie = Object.keys(responseHeaders).some(
									(k) => k.toLowerCase() === 'set-cookie'
								);
								if (hasSetCookie) {
									console.warn(
										'[adapter-uws] upgradeResponse() attaches Set-Cookie to the 101 response. ' +
										'This fails silently behind Cloudflare Tunnel and some other strict edge proxies ' +
										'(WebSocket opens, then closes with 1006). Use the `authenticate` hook to ' +
										'refresh session cookies over a normal HTTP response.\n' +
										'  See: https://svti.me/cf-cookies'
									);
								} else {
									console.warn('[adapter-uws] upgrade() returned response headers. These are only applied in production (uWS); the ws library used in dev does not support custom 101 headers.\n  See: https://svti.me/dev-101-headers');
								}
							}
						} else {
							userData = result || {};
						}
					} catch (err) {
						emitOperationalEvent({
							source: 'svelte-adapter-uws',
							component: 'runtime.websocket-upgrade',
							event: 'runtime.websocket-upgrade.failed',
							severity: 'error',
							dataClass: 'pseudonymous',
							message: 'The WebSocket upgrade hook failed.',
							attributes: { requestId: wsRequestId, error: diagnosticError(err) }
						});
						socket.write(
							'HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n' +
							(wsRequestId ? 'X-Request-ID: ' + wsRequestId + '\r\n' : '') +
							'\r\nInternal Server Error'
						);
						socket.destroy();
						return;
					}
				}

				wss.handleUpgrade(req, socket, head, (ws) => {
					// Ensure remoteAddress is always present in userData, matching
					// what the production handler injects. Plugins like ratelimit
					// depend on ws.getUserData().remoteAddress for per-IP keying.
					const remoteAddress = /** @type {any} */ (userData).remoteAddress
						|| req.socket?.remoteAddress
						|| '';
					const merged = { remoteAddress, .../** @type {any} */ (userData) };
					merged[WS_REQUEST_ID_KEY] = wsRequestId;
					/** @type {any} */ (ws).__userData = merged;
					wss.emit('connection', ws, req);
				});
			});

			wss.on('connection', (ws) => {
				connections.add(ws);
				subscriptions.set(ws, new Set());
				// `ws` emits a connection-level error before closing with 1009 when
				// maxPayload is exceeded. Consume that expected boundary event so an
				// oversized dev frame cannot become an uncaught process exception.
				ws.on('error', (err) => {
					if (err?.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
						console.error('[ws] dev connection error:', err);
					}
				});

				const userData = /** @type {any} */ (ws).__userData || {};
				userData[WS_SUBSCRIPTIONS] = new Set();
				// Promote the upgrade-time requestId into a per-connection
				// platform clone (parity with the production handler).
				const wsPlatform = Object.create(platform);
				wsPlatform.requestId = userData[WS_REQUEST_ID_KEY];
				userData[WS_PLATFORM] = wsPlatform;
				delete userData[WS_REQUEST_ID_KEY];
				const sessionId = randomUUID();
				userData[WS_SESSION_ID] = sessionId;
				userData[WS_STATS] = {
					openedAt: Date.now(),
					messagesIn: 0,
					messagesOut: 0,
					bytesIn: 0,
					bytesOut: 0
				};
				const wrapped = wrapWebSocket(ws, userData);
				wsWrappers.set(ws, wrapped);

				const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
				ws.send(welcome);
				bumpOutV(userData, welcome);

				// Call user open handler
				userHandlers.open?.(wrapped, { platform: userData[WS_PLATFORM] });

				ws.on('message', async (raw, isBinary) => {
					// Convert to ArrayBuffer (matching uWS interface)
					const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
					const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
					bumpInV(userData, arrayBuffer);

					// Binary ingress (client->server 0x03), mirroring the production
					// handler: an ingress-capable connection's id-addressed binary
					// frames decode and route here ahead of the JSON control block
					// and the app hook. Only an actual 0x03 frame pays the cap lookup.
					if (isBinary && buf[0] === 0x03) {
						const icaps = userData[WS_CAPS];
						if (icaps !== undefined && icaps.has(WIRE_INGRESS_CAP)) {
							await runAdmittedMessageWork(messageAdmission, wrapped, { data: buf, platform: userData[WS_PLATFORM] }, runIngressApplicationWorkV, rejectApplicationMessageV);
							return;
						}
					}

					// Oversized control-shaped frame: reject explicitly instead of a
					// silent fall-through. Mirrors handler.js + testing.js.
					if (!isBinary && buf.byteLength >= 8192 && buf[3] === 0x79 /* 'y' in {"type" */) {
						// Count the reject bytes into the connection's outbound total, matching
						// handler.js so the dev server and the real handler agree on a close
						// hook's byte accounting.
						const rejectFrame = controlFrameTooLargeFrame(buf.byteLength);
						ws.send(rejectFrame);
						bumpOutV(userData, rejectFrame);
						return;
					}

					// Handle subscribe/unsubscribe/subscribe-batch from client store.
				// Byte-prefix check: {"type" has byte[3]='y' (0x79), user envelopes
				// {"topic" have byte[3]='o' - skip JSON.parse for non-control messages.
				// 8192 bytes matches the production handler ceiling and is large
				// enough for a subscribe-batch with many topics.
				//
				// `msg` is hoisted to outer scope so it can be forwarded to the
				// user handler in the fall-through delegation below. When the
				// prefix matched and JSON.parse produced an object that did NOT
				// match any known control type, the parsed value reaches plugin-
				// layer dispatchers (e.g. svelte-realtime's `onJsonMessage`)
				// directly, so they don't re-run TextDecoder + JSON.parse on
				// every frame.
					/** @type {any} */
					let msg;
					if (!isBinary && buf.byteLength < 8192 && buf[3] === 0x79) {
						try {
							msg = JSON.parse(buf.toString());
							// Reject null / primitives / arrays so `msg` only reaches
							// the user handler as a {type,...} object envelope. Throw
							// to the catch (which clears `msg`) for a unified fall-
							// through path with parse failures.
							if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) throw 0;
							if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
								const ref = hasRefValue(msg.ref) ? msg.ref : null;
								if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS_V)) {
									sendDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
									return;
								}
								if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V, topic: msg.topic })) {
									sendDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
									return;
								}
								const subs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								// Mirror production: a missing or wrong-shape subs Set is
								// a framework invariant violation, not an
								// every-subscribe-bypasses-the-cap shrug. Asserting here
								// makes dev/test fail the same way the production
								// handler does, so a regression that breaks userData
								// initialization shows up in the CI lane that always
								// runs first.
								assert(subs instanceof Set, 'subs.shape', null);
								const isNew = !subs.has(msg.topic);
								if (exceedsSubscriptionCap({ held: !isNew, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								// Wire-subscribe authorization (mirror): a client may only
								// (re)subscribe to a topic the server already authorized for
								// this connection, unless the app ships its own subscribe hook.
								// The plugin-owned carve-out belongs on BOTH spellings. It was
								// on the batch path only, so the same client, server and
								// topic got opposite answers depending on how many topics
								// happened to be pending when the client flushed -
								// src/client.js sends a single `subscribe` frame when exactly
								// one is queued, so a documented group join worked or failed
								// on microtask coalescing. Paired with the landing re-check
								// below, which is what keeps the exemption from BEING the
								// gate here.
								if (deniesWireSubscribePreHook({ armed: SUBSCRIBE_AUTHZ_V, hasUserHook: hasUserSubscribeHookV() && !SUBSCRIBE_AUTHZ_STRICT_V, held: !isNew, topic: msg.topic })) {
									sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
								// ENROL before the await, so a revocation landing while the
								// app's authorization hook is parked can SEE this subscribe
								// and cancel it. Dev had no pending-subscribe tracking at
								// all: a `platform.unsubscribe` inside that window was a
								// silent no-op and the parked subscribe re-installed the
								// membership afterwards - the "dev looser than production"
								// direction an app then develops against.
								const pendingUdV = wrapped.getUserData();
								// In-flight authorization is bounded before it begins, the
								// same bound production's wire lane applies: pending
								// attempts are live hook work the landed cap cannot see.
								if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(pendingUdV), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) {
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								const pendingTokenV = beginPendingSubscribe(pendingUdV, msg.topic, subs.has(msg.topic));
								const denial = await runUserSubscribeGateV(wrapped, msg.topic);
								if (denial !== null) {
									// The hook denied, but it may have installed tracked membership
									// (a plugin join) before deciding, and a revocation may have tombstoned
									// this attempt mid-await. Settling blindly here left that membership
									// standing: the held branch below defers to a sibling attempt still in
									// flight, so when that sibling's hook denies too, every attempt leaves
									// through this exit and nothing remains to judge the membership.
									if (settleDeniedSubscribe(pendingUdV, msg.topic, pendingTokenV, subs.has(msg.topic)) === 'deny-unwind') {
										unwindRevokedMembership(wrapped, msg.topic);
										userHandlers.unsubscribe?.(wrapped, msg.topic, { platform: pendingUdV[WS_PLATFORM] });
									}
									sendDenied(ws, msg.topic, ref, denial);
									return;
								}
								// Post-await re-check: a concurrent subscribe may have
								// raced through and added the topic during the gate await.
								// NOT when a gap-fill was requested - live membership
								// arriving during the await carries no HISTORY, so acking
								// here leaves a client that asked to recover believing
								// itself caught up. Mirrors production.
								const _wantsRecoverV = wantsRecover({ hasResumeHook: userHandlers.resume, recover: msg.recover });
								if (subs.has(msg.topic) && !_wantsRecoverV) {
									// Held is not enough: the membership may have been installed
									// mid-await by THIS attempt's own hook after a revocation
									// tombstoned it. settleHeldSubscribe reads the provenance -
									// ack a surviving attempt or a fresh post-revoke grant, deny
									// a revoked one, unwinding hook-installed membership when no
									// live authority backs it. Mirrors runtime/handler.js.
									const heldVerdictV = settleHeldSubscribe(pendingUdV, msg.topic, pendingTokenV);
									if (heldVerdictV === 'ack') {
										sendSubscribedV(ws, msg.topic, ref);
										return;
									}
									if (heldVerdictV === 'deny-unwind') {
										unwindRevokedMembership(wrapped, msg.topic);
										userHandlers.unsubscribe?.(wrapped, msg.topic, { platform: pendingUdV[WS_PLATFORM] });
									}
									sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
								// Landing re-check (mirror). The pre-gate above stands aside
								// for a plugin-owned topic so the plugin's own hook can run;
								// something must then confirm the hook ACTUALLY admitted this
								// socket, or the exemption is the entire gate. Scoped to a
								// topic the socket does NOT already hold, so the recover
								// fall-through above cannot be refused by it.
								if (deniesWireSubscribeLanding({ armed: SUBSCRIBE_AUTHZ_V, hasUserHook: hasUserSubscribeHookV() && !SUBSCRIBE_AUTHZ_STRICT_V, held: subs.has(msg.topic), topic: msg.topic })) {
									settlePendingSubscribe(pendingUdV, msg.topic, pendingTokenV);
									sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
								if (exceedsSubscriptionCap({ held: subs.has(msg.topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
									settlePendingSubscribe(pendingUdV, msg.topic, pendingTokenV);
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								// Resume-on-subscribe (mirror): gap-fill via the resume hook before
								// subscribing to live, so __replay frames precede the first live frame.
								let _cap = null;
								// Same guard as production: this serves the topic's replay
								// HISTORY, and the landing refuses the subscription only
								// afterwards - by which time the messages have gone out.
								const _recoverRevokedV = recoverIsRevoked({
									held: subs instanceof Set && subs.has(msg.topic),
									wireAuthz: SUBSCRIBE_AUTHZ_V && (SUBSCRIBE_AUTHZ_STRICT_V || !hasUserSubscribeHookV()),
									cancelled: isPendingSubscribeCancelled(pendingUdV, msg.topic, pendingTokenV),
									topic: msg.topic
								});
								if (!_recoverRevokedV && _wantsRecoverV) {
									const _rEpochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
									_cap = beginResumeCaptureV([msg.topic], ws);
									try {
										await userHandlers.resume(wrapped, { sessionId: wrapped.getUserData()[WS_SESSION_ID], lastSeenSeqs: { [msg.topic]: msg.recover.offset }, lastSeenEpochs: _rEpochs, platform: wrapped.getUserData()[WS_PLATFORM] });
									} catch (err) { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err); }
									if (subs.has(msg.topic)) {
										const heldVerdictVR = settleHeldSubscribe(pendingUdV, msg.topic, pendingTokenV);
										if (heldVerdictVR === 'ack') { discardResumeCaptureV(_cap); sendSubscribedV(ws, msg.topic, ref); return; }
										// Revoked mid-await; the replay went out, but a grant
										// installed by the revoked attempt's own hook must not stand.
										if (heldVerdictVR === 'deny-unwind') {
											unwindRevokedMembership(wrapped, msg.topic);
											userHandlers.unsubscribe?.(wrapped, msg.topic, { platform: pendingUdV[WS_PLATFORM] });
										}
										discardResumeCaptureV(_cap);
										sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
										return;
									}
								}
								// Landing settle. A revocation that bumped this subscribe's
								// epoch while the hook was parked means the grant must be
								// discarded rather than installed, and the client's ref'd
								// frame answered truthfully - the same landing production
								// and the in-process server perform.
								if (!settlePendingSubscribe(pendingUdV, msg.topic, pendingTokenV, true)) {
									if (_cap) discardResumeCaptureV(_cap);
									sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
								subscriptions.get(ws)?.add(msg.topic);
								subs.add(msg.topic);
								if (_cap) flushResumeTopicV(_cap, msg.topic);
								sendSubscribedV(ws, msg.topic, ref);
								return;
							}
							if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
								// A client-driven unsubscribe is a revocation too: it must
								// cancel this connection's own subscribe if one is still
								// parked in its authorization hook, or the parked frame
								// lands afterwards and re-installs the membership the
								// client just asked to drop. Production tombstones here for
								// exactly this TOCTOU.
								const uudV = /** @type {any} */ (ws).__userData;
								if (uudV) tombstonePendingSubscribe(uudV, msg.topic);
								subscriptions.get(ws)?.delete(msg.topic);
								uudV?.[WS_SUBSCRIPTIONS]?.delete(msg.topic);
								// Read access gone means write access gone, as production does.
								if (uudV && uudV[WS_PUBLISH_GRANT] === msg.topic) uudV[WS_PUBLISH_GRANT] = undefined;
								releaseDerivedSubscriptions(wrapped, msg.topic);
								userHandlers.unsubscribe?.(wrapped, msg.topic, { platform: wrapped.getUserData()[WS_PLATFORM] });
								return;
							}
							if (msg.type === 'hello' && Array.isArray(msg.caps)) {
								const ud = /** @type {any} */ (ws).__userData;
								if (ud) {
									const caps = new Set();
									for (let i = 0; i < msg.caps.length; i++) {
										if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
									}
									ud[WS_CAPS] = caps;
									// Opt-in arm for internal flow control, mirroring
									// the production handler. Only the first hello
									// allocates the slot and emits the first window;
									// absence of the cap keeps the immediate send
									// path byte-identical.
									if (caps.has('lease') && !ud[WS_LEASE]) {
										const gate = createLeaseState({ requestCount: DEFAULT_GRANT.requestCount, ttlMs: DEFAULT_GRANT.ttlMs });
										gate.grant();
										ud[WS_LEASE] = { gate, saturation: gate.pressureValue() };
										ws.send('{"type":"lease-ok"}');
										bumpOutV(ud, '{"type":"lease-ok"}');
										const frame = leaseGrantFrame(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs);
										ws.send(frame);
										bumpOutV(ud, frame);
									}
									// Opt-in confirm for binary ingress (mirror of lease-ok).
									if (caps.has(WIRE_INGRESS_CAP)) {
										const okFrame = ingressOkFrame();
										ws.send(okFrame);
										bumpOutV(ud, okFrame);
									}
								}
								return;
							}
							if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
								// Sent by the client store on open/reconnect to resubscribe all
								// topics in one message instead of N individual subscribe frames.
								// Topics past the 256 cap are denied loudly, never silently
								// dropped (same rule as the production runtime).
								const subs = subscriptions.get(ws);
								const topics = msg.topics.slice(0, 256);
								const ref = hasRefValue(msg.ref) ? msg.ref : null;
								for (let i = 256; i < msg.topics.length; i++) {
									if (typeof msg.topics[i] === 'string') {
										sendDenied(ws, msg.topics[i], ref, 'BATCH_OVERFLOW');
									}
								}
								const valid = [];
								for (const topic of topics) {
									if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS_V)) {
										sendDenied(ws, topic, ref, 'INVALID_TOPIC');
										continue;
									}
									if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V, topic })) {
										sendDenied(ws, topic, ref, 'INVALID_TOPIC');
										continue;
									}
									valid.push(topic);
								}
								// Wire-subscribe authorization (mirror, batch): pre-deny every
								// valid topic the server has not already authorized when no app
								// hook is present; with a hook, that hook decides.
								// Hoisted once per frame, so every topic in one frame is judged
								// against one reading of the app's hooks. `userHandlers` is
								// REASSIGNED by the hook-reload path, so a per-topic read could
								// split a single frame across two versions of the app's hooks.
								const _hasUserHookV = hasUserSubscribeHookV();
								const _wireAuthzV = SUBSCRIBE_AUTHZ_V && (SUBSCRIBE_AUTHZ_STRICT_V || !_hasUserHookV);
								// Fails CLOSED when the grant set is missing. Requiring a
								// truthy `_authzSubsV` made an absent or malformed slot
								// skip the gate entirely, so dev admitted what production
								// refuses - production asserts the Set and always computes
								// the decision. An armed gate with no grants denies
								// everything, which is the correct reading of "the server
								// has authorized nothing on this connection".
								const _authzSubsV = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								const authzDeniedV = _wireAuthzV
									? valid.map((t) => deniesWireSubscribePreHook({ armed: SUBSCRIBE_AUTHZ_V, hasUserHook: _hasUserHookV && !SUBSCRIBE_AUTHZ_STRICT_V, held: _authzSubsV instanceof Set && _authzSubsV.has(t), topic: t }))
									: null;
								// In-flight authorization capacity, mirroring production's
								// batch lane: topics beyond the pending-attempt budget take
								// no further part in the frame. Decided BEFORE the hook
								// input is derived below, or the refused topics would still
								// reach the hook and spend exactly the work this budget
								// bounds. A topic the grant gate already refused keeps its
								// FORBIDDEN verdict, because the client retries
								// RATE_LIMITED and only RATE_LIMITED. Skipped when no
								// userData exists - such a socket does not enrol below.
								const batchUdV = /** @type {any} */ (ws).__userData;
								if (batchUdV) {
									const _headroomV = MAX_PENDING_SUBSCRIBES_PER_CONNECTION - pendingSubscribeTotal(batchUdV);
									if (_headroomV < valid.length) {
										for (let i = Math.max(_headroomV, 0); i < valid.length; i++) {
											sendDenied(ws, valid[i], ref, authzDeniedV?.[i] ? 'FORBIDDEN' : 'RATE_LIMITED');
										}
										valid.length = Math.max(_headroomV, 0);
									}
								}
								// A topic the grant gate already denied must not reach the
								// hook, as on the single path. Calling the hook first and
								// reading the decision only at the landing lets a plugin
								// hook's side effects (roster join, observer tap) land for a
								// topic the caller is then told FORBIDDEN about.
								const hookTopics = authzDeniedV === null
									// Keep the hook's mutable input separate from the
									// landing queue whose topics/tokens still have to settle.
									? valid.slice()
									: valid.filter((_t, i) => !authzDeniedV[i]);
								// ENROL EVERY TOPIC IN THE BATCH, for the same reason the
								// single lane does - and this is the lane that matters most,
								// because `src/client.js` sends a single frame only when
								// exactly one topic is queued and a `subscribe-batch`
								// otherwise. Leaving it unenrolled meant a ban landing during
								// authorization was defeated in dev depending on nothing but
								// microtask coalescing. Note the landing's own grant re-check
								// is inert here whenever the app ships a subscribe hook,
								// since `_wireAuthzV` is false in exactly that configuration -
								// which is the configuration where a hook can park at all.
								const batchTokensV = batchUdV
									? valid.map((t) => beginPendingSubscribe(batchUdV, t, batchUdV?.[WS_SUBSCRIPTIONS] instanceof Set && batchUdV[WS_SUBSCRIPTIONS].has(t)))
									: null;
								const batchDenials = hookTopics.length > 0
									? await runSubscribeBatchHookV(wrapped, hookTopics)
									: null;
								const perTopicDenials = batchDenials === null && userHandlers.subscribe
									? await Promise.all(valid.map((t, i) =>
										(authzDeniedV !== null && authzDeniedV[i]) ? null : runSubscribeHookV(wrapped, t)))
									: null;
								const udSubs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								assert(udSubs instanceof Set, 'subs.shape-batch', null);
								// Resume-on-subscribe (mirror, batch): gap-fill every recover-tagged topic
								// that passed the auth gate in one resume-hook call, before the subscribe loop.
								let _recoverSeqs = null;
								let _recoverEpochs = null;
								let _batchCap = null;
								if (msg.recover && typeof msg.recover === 'object') {
									for (let i = 0; i < valid.length; i++) {
										const _t = valid[i];
										// Between the hook awaits and the landing, and it serves
										// a topic's replay history - so read the CURRENT grant
										// set rather than the pre-await snapshot, and the
										// revocation tombstone with it. This lane used to ask
										// only the grant gate, so with the gate off (the
										// default) a topic whose pending subscribe had been
										// cancelled mid-await still had its history served.
										const _heldV = udSubs instanceof Set && udSubs.has(_t);
										// Pre-hook decision first (a pre-denied topic is filtered out
										// of the hook pass, so nothing downstream would catch it),
										// and both halves of wireAuthz read exactly as the landing
										// reads them - otherwise the two sites disagree inside one
										// frame, which is how this repair failed the first time.
										const _denial = (authzDeniedV !== null && authzDeniedV[i] ? 'FORBIDDEN' : null)
											?? (recoverIsRevoked({ held: _heldV, wireAuthz: SUBSCRIBE_AUTHZ_V && (SUBSCRIBE_AUTHZ_STRICT_V || !_hasUserHookV), cancelled: batchTokensV === null || isPendingSubscribeCancelled(batchUdV, _t, batchTokensV[i]), topic: _t }) ? 'FORBIDDEN' : null)
											?? (batchDenials !== null ? (batchDenials[_t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
										if (_denial !== null) continue;
										const _rec = msg.recover[_t];
										if (wantsRecover({ hasResumeHook: userHandlers.resume, recover: _rec })) {
											if (_recoverSeqs === null) _recoverSeqs = {};
											_recoverSeqs[_t] = _rec.offset;
											if (Number.isInteger(_rec.epoch)) { if (_recoverEpochs === null) _recoverEpochs = {}; _recoverEpochs[_t] = _rec.epoch; }
										}
									}
									if (_recoverSeqs !== null && userHandlers.resume) {
									_batchCap = beginResumeCaptureV(Object.keys(_recoverSeqs), ws);
										try {
											await userHandlers.resume(wrapped, { sessionId: wrapped.getUserData()[WS_SESSION_ID], lastSeenSeqs: _recoverSeqs, lastSeenEpochs: _recoverEpochs || undefined, platform: wrapped.getUserData()[WS_PLATFORM] });
										} catch (err) { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err); }
									}
								}
								for (let i = 0; i < valid.length; i++) {
									const topic = valid[i];
									// Re-evaluated HERE against the current grant set, not from the
									// reading taken before the awaits, so a revocation landing in
									// the await window cannot be defeated by a pre-await decision.
									// Mirrors the production landing in runtime/handler.js.
									//
									// Settle this topic's enrolment exactly once, and MEMBERSHIP
									// FIRST: the tombstone is consulted only after the topic has
									// failed to be an existing membership. Consulting it before
									// (which this lane used to do) cannot tell a revoke from a
									// revoke followed by a legitimate re-grant inside the same
									// await window, so it denied a topic the connection holds -
									// the same reasoning recoverIsRevoked is built on. It also
									// answered FORBIDDEN over the hook's own denial reason and
									// over RATE_LIMITED. Production and src/testing.js both
									// settle last; this lane was the only one that did not.
									const settleV = (granted) => (batchTokensV === null
										? true
										: settlePendingSubscribe(batchUdV, topic, batchTokensV[i], granted === true));
									const settleHeldV = () => (batchTokensV === null
										? 'ack'
										: settleHeldSubscribe(batchUdV, topic, batchTokensV[i]));
									const settleDeniedV = (heldNow) => (batchTokensV === null
										? 'deny'
										: settleDeniedSubscribe(batchUdV, topic, batchTokensV[i], heldNow));
									// Read once and handed to both decisions below; nothing
									// between here and the subscribe mutates it for this topic.
									const held = udSubs.has(topic);
									const denial = (deniesWireSubscribeLanding({ armed: SUBSCRIBE_AUTHZ_V, hasUserHook: _hasUserHookV && !SUBSCRIBE_AUTHZ_STRICT_V, held, topic }) ? 'FORBIDDEN' : null)
										?? (batchDenials !== null
											? (batchDenials[topic] ?? null)
											: (perTopicDenials !== null ? perTopicDenials[i] : null));
									if (denial !== null) {
										// The hook denied, but it may have installed tracked membership
										// (a plugin join) before deciding, and a revocation may have tombstoned
										// this attempt mid-await. Settling blindly here left that membership
										// standing: the held branch below defers to a sibling attempt still in
										// flight, so when that sibling's hook denies too, every attempt leaves
										// through this exit and nothing remains to judge the membership.
										if (settleDeniedV(held) === 'deny-unwind') {
											unwindRevokedMembership(wrapped, topic);
											userHandlers.unsubscribe?.(wrapped, topic, { platform: batchUdV[WS_PLATFORM] });
										}
										sendDenied(ws, topic, ref, denial);
										continue;
									}
									if (held) {
										// Same provenance read as the single lane: a revoked
										// attempt whose own hook installed the membership must
										// not ack it.
										const heldVerdictV = settleHeldV();
										if (heldVerdictV === 'ack') {
											sendSubscribedV(ws, topic, ref);
											continue;
										}
										if (heldVerdictV === 'deny-unwind') {
											unwindRevokedMembership(wrapped, topic);
											userHandlers.unsubscribe?.(wrapped, topic, { platform: batchUdV[WS_PLATFORM] });
										}
										sendDenied(ws, topic, ref, 'FORBIDDEN');
										continue;
									}
									if (exceedsSubscriptionCap({ held, size: udSubs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
										settleV();
										sendDenied(ws, topic, ref, 'RATE_LIMITED');
										continue;
									}
									// Revocation tombstone: a platform.unsubscribe that landed
									// during the hook or resume awaits cancelled this topic -
									// discard the grant and answer truthfully rather than acking.
									if (!settleV(true)) {
										sendDenied(ws, topic, ref, 'FORBIDDEN');
										continue;
									}
									subs?.add(topic);
									udSubs.add(topic);
									if (_batchCap) flushResumeTopicV(_batchCap, topic);
									sendSubscribedV(ws, topic, ref);
								}
								if (_batchCap) discardResumeCaptureV(_batchCap);
								return;
							}
							if (msg.type === 'reply' && hasRefValue(msg.ref)) {
								const ud = /** @type {any} */ (ws).__userData || {};
								const pending = ud[WS_PENDING_REQUESTS];
								const entry = pending?.get(msg.ref);
								if (entry) {
									pending.delete(msg.ref);
									clearTimeout(entry.timer);
									if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
									else entry.resolve(msg.data);
								}
								return;
							}
							if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
								msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
								// Mirror production: forward the per-topic epochs the
								// client presented (raw, parallel to lastSeenSeqs) so
								// the hook can compare each to platform.topicEpoch and
								// choose gap-fill or cold-rehydrate. Absent for an old
								// client; the hook then treats every topic as a match.
								const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
									? msg.lastSeenEpochs
									: undefined;
								// Mirror production's grant filter: `resume` is
								// client-named and yields a topic's replay history,
								// so under the pure-grant model ungranted topics are
								// dropped before the hook sees them. Dev running a
								// looser rule than production is how an app ends up
								// developing against a gate that is not there.
								let resumeSeqsV = msg.lastSeenSeqs;
								if (SUBSCRIBE_AUTHZ_V && (SUBSCRIBE_AUTHZ_STRICT_V || !hasUserSubscribeHookV()) && resumeSeqsV && typeof resumeSeqsV === 'object') {
									const grantsV = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
									/** @type {Record<string, unknown>} */
									const allowedV = Object.create(null);
									let droppedV = 0;
									for (const t of Object.keys(resumeSeqsV)) {
										if (deniesUngrantedObserve(true, false, grantsV, t)) { droppedV++; continue; }
										allowedV[t] = resumeSeqsV[t];
									}
									if (droppedV > 0) resumeSeqsV = allowedV;
								}
								if (userHandlers.resume) {
									try {
										// Mirror production: await the user hook so
										// per-topic replay completes before the
										// `resumed` ack tells the client to switch
										// to live mode.
										await userHandlers.resume(wrapped, {
											sessionId: msg.sessionId,
											lastSeenSeqs: resumeSeqsV,
											lastSeenEpochs,
											platform: wrapped.getUserData()[WS_PLATFORM]
										});
									} catch (err) {
										console.error('[adapter-uws] resume hook threw:', err);
									}
								}
								ws.send('{"type":"resumed"}');
								bumpOutV(userData, '{"type":"resumed"}');
								return;
							}
							if (msg.type === 'request-n') {
								const ud = /** @type {any} */ (ws).__userData;
								const slot = ud && ud[WS_LEASE];
								if (slot) {
									slot.gate.requestN(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs);
									const frame = leaseGrantFrame(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs);
									ws.send(frame);
									bumpOutV(ud, frame);
									slot.saturation = slot.gate.pressureValue();
								}
								return;
							}
							if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
								// Client binds a client-allocated ingress id to a
								// decode+route destination (mirror of the production
								// handler). Unknown kind -> no bind, no ack, JSON fallback.
								const bindUd = /** @type {any} */ (ws).__userData;
								if (bindUd && bindIngress(bindUd, wrapped, msg.id, msg.kind, msg.target)) {
									const boundFrame = ingressBoundFrame(msg.id);
									ws.send(boundFrame);
									bumpOutV(bindUd, boundFrame);
								}
								return;
							}
							if (msg.type === 'game') {
								// Client-driven relay publish (the game lane). The topic
								// is the connection's publish grant, never client-supplied.
								// Ungranted or a non-string event -> game-denied; granted
								// -> stamp seq, fan out to the room excluding this sender.
								await runAdmittedMessageWork(messageAdmission, wrapped, { msg, platform }, runGameApplicationWorkV, rejectApplicationMessageV);
								return;
							}
						} catch {
							// Not JSON, not an object envelope, or a known control
							// type that threw inside its handler. Clear `msg` so the
							// fall-through delegation sees `msg: undefined` (raw
							// bytes only).
							msg = undefined;
						}
					}

					// Delegate to user handler. `msg` is the JSON-parsed envelope
					// when the prefix matched + parsed to an object + no control
					// type matched; otherwise undefined.
					await handlerReady;
					await runAdmittedMessageHook(messageAdmission, userHandlers.message, wrapped, { data: arrayBuffer, isBinary: !!isBinary, msg, platform: wrapped.getUserData()[WS_PLATFORM] }, rejectApplicationMessageV);
				});

				ws.on('close', (code, reason) => {
					const reasonBuf = reason || Buffer.alloc(0);
					const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
					const ud = /** @type {any} */ (ws).__userData || {};
					messageAdmission.close(wrapped);
					const subs = ud[WS_SUBSCRIPTIONS] || new Set();
					const pending = ud[WS_PENDING_REQUESTS];
					if (pending && pending.size > 0) {
						for (const entry of pending.values()) {
							clearTimeout(entry.timer);
							try { entry.reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED))); } catch {}
						}
						pending.clear();
					}
					const stats = ud[WS_STATS];
					const closePlatform = ud[WS_PLATFORM];
					const ctx = stats
						? {
							code,
							message: reasonAB,
							platform: closePlatform,
							subscriptions: subs,
							id: ud[WS_SESSION_ID],
							duration: Date.now() - stats.openedAt,
							messagesIn: stats.messagesIn,
							messagesOut: stats.messagesOut,
							bytesIn: stats.bytesIn,
							bytesOut: stats.bytesOut
						}
						: { code, message: reasonAB, platform: closePlatform, subscriptions: subs };
					userHandlers.close?.(wrapped, ctx);
					if (ud[WS_LEASE]) ud[WS_LEASE] = undefined;
					connections.delete(ws);
					subscriptions.delete(ws);
					wsWrappers.delete(ws);
				});
			});

			console.log(`[adapter-uws] Dev WebSocket endpoint at ${wsPath}`);
			if (wsPath !== '/ws') {
				console.log(`[adapter-uws] Client must match: connect({ path: '${wsPath}' })`);
			}
		},
		handleHotUpdate({ server }) {
			if (!resolvedHandlerPath) return;
			// Vite invalidates a module and all its importers when a file changes.
			// Re-load the handler on every HMR update - ssrLoadModule returns the
			// cached module instantly when nothing was invalidated, so this is cheap.
			// We compare function references to detect actual changes.
			handlerReady = server.ssrLoadModule(resolvedHandlerPath).then(async (mod) => {
				const recovered = handlerFailed;
				handlerFailed = false;
				let connectionsRestarted = false;
				if (mod.upgrade !== userHandlers.upgrade ||
					mod.open !== userHandlers.open ||
					mod.message !== userHandlers.message ||
					mod.close !== userHandlers.close ||
					mod.drain !== userHandlers.drain ||
					mod.subscribe !== userHandlers.subscribe ||
					mod.subscribeBatch !== userHandlers.subscribeBatch ||
					mod.unsubscribe !== userHandlers.unsubscribe ||
					mod.resume !== userHandlers.resume) {
					applyHandlers(mod);
					connectionsRestarted = connections.size > 0;
					// Close existing connections so they reconnect with the new handler.
					// 1012 = "Service Restart" - clients with auto-reconnect will reconnect.
					for (const ws of connections) {
						ws.close(1012, 'Handler reloaded');
					}
					console.log('[adapter-uws] WebSocket handler reloaded, existing connections closed');
				}
				handlerEverLoaded = true;
				if (recovered) {
					// Recovery from an INITIAL load failure must also run the
					// user's init hook, or the recovered event's "no operator
					// action is required" would be false: init never ran at
					// configureServer time (the load failed), and nothing else
					// ever fires it. fireInitOnceV is a no-op after a normal
					// startup; a throwing init falls into the catch below and
					// reports as a reload failure - loud, not silent.
					await fireInitOnceV();
					emitOperationalDiagnostic(viteHandlerRecoveredDiagnostic({
						...viteDiagnosticEndpoint(server),
						connectionsRestarted
					}));
				}
			}).catch((err) => {
				handlerFailed = true;
				const phase = handlerEverLoaded ? 'reload' : 'load';
				emitOperationalDiagnostic(viteHandlerFailureDiagnostic({
					phase,
					source: path.relative(server.config.root, resolvedHandlerPath).replaceAll(path.sep, '/') || path.basename(resolvedHandlerPath),
					...viteDiagnosticEndpoint(server),
					error: err
				}));
				// The raw error carries the stack, Vite frame, and source
				// location the structured record deliberately bounds away.
				console.error(`[adapter-uws] handler ${phase} error detail:`, err);
			});
		}
	};
}

/** @deprecated Use `uws()` instead. */
export const uwsDev = uws;
