import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCookies, createCookies } from './runtime/cookies.js';
import { esc, isValidWireTopic, createScopedTopic, createTopicHelperCache, resolveRequestId, completeEnvelope, completeGameEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, nextTopicSeq, stampSeq, createHlc, processEpoch, isAuthOriginAccepted, isOriginAllowed, assert, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_LEASE, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './runtime/utils.js';
import { createLeaseState, leaseGrantFrame, controlFrameTooLargeFrame, DEFAULT_GRANT } from './runtime/wire.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './runtime/handler/ingress.js';
import { registerGameIngress } from './runtime/handler/game-ingress.js';
import { now, monotonicNow, randomFloat, randomU32, randomUuid, randomBytes } from './runtime/runtime.js';

/**
 * Vite plugin that provides WebSocket support during development.
 *
 * Uses the same subscribe/unsubscribe/publish protocol as the production
 * uWS handler, so the client store works identically in dev and prod.
 *
 * @param {{ path?: string, handler?: string, authPath?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function uws(options = {}) {
	const wsPath = options.path || '/ws';
	const wsAuthPath = options.authPath || '/__ws/auth';
	// Mirror production: block client-initiated subscribes to `__`-prefixed
	// system topics by default. Apps that need to opt in can pass
	// `allowSystemTopicSubscribe: true` to the dev plugin in vite.config.js.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V = options.allowSystemTopicSubscribe === true;
	// Mirror production: wire topics default to printable ASCII only.
	const ALLOW_NON_ASCII_TOPICS_V = options.allowNonAsciiTopics === true;
	// Mirror production wire-subscribe authorization (see handler.js). `let` so
	// `platform.authorizeWireSubscribe()` can arm it at runtime the way the
	// framework does; seeded from the config option for the static path.
	let SUBSCRIBE_AUTHZ_V = options.authorizeWireSubscribe === true;
	const hasUserSubscribeHookV = () => !!(userHandlers.subscribe || userHandlers.subscribeBatch);
	// Mirror production CSRF defense for the authenticate POST endpoint.
	// Same opt-out shape as the production handler: pass
	// `authPathRequireOrigin: false` to the dev plugin to accept native
	// (non-browser) clients without `x-requested-with` / `Sec-Fetch-Site`
	// / matching `Origin`.
	const AUTH_PATH_REQUIRE_ORIGIN_V = options.authPathRequireOrigin !== false;
	const ALLOWED_ORIGINS_V = /** @type {'*' | 'same-origin' | string[]} */ (options.allowedOrigins ?? 'same-origin');

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
		const timeoutMs = (options && options.timeoutMs) || 5000;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (pending.delete(ref)) reject(new Error('request timed out'));
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
	const platform = {
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
			let ok = false;
			for (let i = 0; i < entries.length; i++) {
				const per = entries[i].excludeWs !== undefined
					? { ...(options || {}), excludeWs: entries[i].excludeWs }
					: options;
				ok = publish(topic, event, entries[i].data, per) || ok;
			}
			return ok;
		},
		sendWireBatch(ws, topic, event, entries, _wire) {
			let result = 1;
			for (let i = 0; i < entries.length; i++) {
				result = send(ws, topic, event, entries[i].data);
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
		get pressure() {
			// Zero-valued snapshot rather than null so downstream code that
			// destructures `pressure.active` / `.reason` / `.topPublishers`
			// does not crash on field access.
			return {
				active: false,
				subscriberRatio: 0,
				publishRate: 0,
				memoryMB: 0,
				reason: 'NONE',
				maxBufferedBytes: 0,
				backpressuredConnections: 0,
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
			if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
			const denial = await runUserSubscribeGateV(ws, topic);
			if (denial !== null) return denial;
			// Post-await re-check: a concurrent subscribe may have raced
			// through and already added the topic during the gate await.
			if (subs.has(topic)) return null;
			if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
			ws.subscribe(topic);
			subs.add(topic);
			return null;
		},
		async checkSubscribe(ws, topic) {
			// Pure gate: consult the user's hook chain without subscribing.
			// Same precedence as production (subscribeBatch first, falls
			// back to subscribe). No state mutation, no cap check.
			if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
			return await runUserSubscribeGateV(ws, topic);
		},
		authorizeWireSubscribe() {
			// Mirror production: arm wire-subscribe authorization at runtime.
			SUBSCRIBE_AUTHZ_V = true;
		},
		unsubscribe(ws, topic) {
			const ud = ws.getUserData();
			const subs = ud?.[WS_SUBSCRIPTIONS];
			if (!(subs instanceof Set) || !subs.has(topic)) return false;
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
					active: p.active,
					reason: p.reason,
					value: p.value ?? 0,
					subscriberRatio: p.subscriberRatio,
					publishRate: p.publishRate,
					memoryMB: p.memoryMB,
					maxBufferedBytes: p.maxBufferedBytes ?? 0,
					backpressuredConnections: p.backpressuredConnections ?? 0
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
			const timeoutMs = (options && options.timeoutMs) || 5000;
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
		// Dev mode runs over the `ws` library which does not enforce a
		// per-frame cap; report the production default (1 MB) so app code
		// that branches on `platform.maxPayloadLength` sees a consistent
		// number across dev / prod.
		get maxPayloadLength() { return 1024 * 1024; },
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
		initFired = true;
		if (typeof userHandlers.init === 'function') {
			await userHandlers.init({ platform });
		}
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
				console.error('[ws] shutdown hook threw:', err);
			}
		}
	}

	/**
	 * Discover the WS handler file path.
	 * @param {string} root
	 * @returns {string | null}
	 */
	function discoverHandler(root) {
		if (options.handler) return path.resolve(root, options.handler);
		const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
		for (const candidate of candidates) {
			const full = path.resolve(root, candidate);
			if (existsSync(full)) return full;
		}
		return null;
	}

	/** SSR-build state captured in `configResolved` and consumed in `buildStart`. */
	let ssrHandlerPath = /** @type {string | null} */ (null);

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
		configResolved(resolved) {
			// Capture the handler path once the resolved Vite config is
			// available. SvelteKit runs Vite 7's environment API with
			// separate `client` and `ssr` environments; `env.isSsrBuild`
			// in `config()` is `false` even during the SSR build, so we
			// detect SSR via `resolved.build.ssr` instead.
			if (resolved.build?.ssr) {
				ssrHandlerPath = discoverHandler(resolved.root || process.cwd());
			}
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
			if (!ssrHandlerPath) return;
			if (this.environment?.name && this.environment.name !== 'ssr') return;
			this.emitFile({
				type: 'chunk',
				id: ssrHandlerPath,
				fileName: 'ws-handler.js'
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

			// Load user's WebSocket handler via Vite's ssrLoadModule (handles TS/aliases/etc.)
			const handlerPath = options.handler
				? path.resolve(root, options.handler)
				: null;

			if (handlerPath) {
				resolvedHandlerPath = handlerPath;
				handlerReady = server.ssrLoadModule(handlerPath).then((mod) => {
					handlerFailed = false;
					applyHandlers(mod);
				}).catch((err) => {
					handlerFailed = true;
					console.error(`[adapter-uws] Failed to load WebSocket handler '${options.handler}':`, err, '\n  See: https://svti.me/ws-handler-load');
				});
			} else {
				// Auto-discover src/hooks.ws.{js,ts,mjs}
				const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
				handlerReady = (async () => {
					for (const candidate of candidates) {
						const fullPath = path.resolve(root, candidate);
						if (!existsSync(fullPath)) continue;
						resolvedHandlerPath = fullPath;
						try {
							const mod = await server.ssrLoadModule(fullPath);
							handlerFailed = false;
							applyHandlers(mod);
							break;
						} catch (err) {
							handlerFailed = true;
							console.error(`[adapter-uws] Error loading '${candidate}':`, err.message);
							break;
						}
					}
				})();
			}

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

				const origin = 'http://' + (headers['host'] || 'localhost');
				const url = req.url || wsAuthPath;
				const request = new Request(origin + url, {
					method: 'POST',
					headers,
					body: bodyBuf.length > 0 ? bodyBuf : undefined,
					// @ts-expect-error
					duplex: 'half'
				});

				const cookies = createCookies(headers['cookie']);
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
					console.error('[adapter-uws] authenticate error:', err);
					res.statusCode = 500;
					res.setHeader('content-type', 'text/plain');
					res.end('Internal Server Error');
				}
			});

			server.httpServer?.on('upgrade', async (req, socket, head) => {
				const { pathname } = new URL(req.url || '', 'http://localhost');
				if (pathname !== wsPath) return;

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
				await handlerReady;

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
							if (result.headers && Object.keys(result.headers).length > 0) {
								const hasSetCookie = Object.keys(result.headers).some(
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
						console.error('[adapter-uws] WebSocket upgrade error:', err);
						socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nInternal Server Error');
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
							dispatchIngressFrame(wrapped, userData, buf, userData[WS_PLATFORM]);
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
								if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V && msg.topic.charCodeAt(0) === 95 && msg.topic.charCodeAt(1) === 95) {
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
								if (isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								// Wire-subscribe authorization (mirror): a client may only
								// (re)subscribe to a topic the server already authorized for
								// this connection, unless the app ships its own subscribe hook.
								if (SUBSCRIBE_AUTHZ_V && isNew && !hasUserSubscribeHookV()) {
									sendDenied(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
								const denial = await runUserSubscribeGateV(wrapped, msg.topic);
								if (denial !== null) {
									sendDenied(ws, msg.topic, ref, denial);
									return;
								}
								// Post-await re-check: a concurrent subscribe may have
								// raced through and added the topic during the gate await.
								if (subs.has(msg.topic)) {
									sendSubscribedV(ws, msg.topic, ref);
									return;
								}
								if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								// Resume-on-subscribe (mirror): gap-fill via the resume hook before
								// subscribing to live, so __replay frames precede the first live frame.
								if (msg.recover && typeof msg.recover === 'object' && Number.isInteger(msg.recover.offset) && msg.recover.offset >= 0 && userHandlers.resume) {
									const _rEpochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
									try {
										await userHandlers.resume(wrapped, { sessionId: wrapped.getUserData()[WS_SESSION_ID], lastSeenSeqs: { [msg.topic]: msg.recover.offset }, lastSeenEpochs: _rEpochs, platform: wrapped.getUserData()[WS_PLATFORM] });
									} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
									if (subs.has(msg.topic)) { sendSubscribedV(ws, msg.topic, ref); return; }
								}
								subscriptions.get(ws)?.add(msg.topic);
								subs.add(msg.topic);
								sendSubscribedV(ws, msg.topic, ref);
								return;
							}
							if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
								subscriptions.get(ws)?.delete(msg.topic);
								/** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS]?.delete(msg.topic);
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
									if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE_V && typeof topic === 'string' &&
										topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
										sendDenied(ws, topic, ref, 'INVALID_TOPIC');
										continue;
									}
									valid.push(topic);
								}
								// Wire-subscribe authorization (mirror, batch): pre-deny every
								// valid topic the server has not already authorized when no app
								// hook is present; with a hook, that hook decides.
								const _wireAuthzV = SUBSCRIBE_AUTHZ_V && !hasUserSubscribeHookV();
								const _authzSubsV = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								const authzDeniedV = (_wireAuthzV && _authzSubsV)
									? valid.map((t) => !_authzSubsV.has(t))
									: null;
								const batchDenials = await runSubscribeBatchHookV(wrapped, valid);
								const perTopicDenials = batchDenials === null && userHandlers.subscribe
									? await Promise.all(valid.map((t) => runSubscribeHookV(wrapped, t)))
									: null;
								const udSubs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								assert(udSubs instanceof Set, 'subs.shape-batch', null);
								// Resume-on-subscribe (mirror, batch): gap-fill every recover-tagged topic
								// that passed the auth gate in one resume-hook call, before the subscribe loop.
								let _recoverSeqs = null;
								let _recoverEpochs = null;
								if (msg.recover && typeof msg.recover === 'object') {
									for (let i = 0; i < valid.length; i++) {
										const _t = valid[i];
										const _denial = (authzDeniedV !== null && authzDeniedV[i] ? 'FORBIDDEN' : null)
											?? (batchDenials !== null ? (batchDenials[_t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
										if (_denial !== null) continue;
										const _rec = msg.recover[_t];
										if (_rec && typeof _rec === 'object' && Number.isInteger(_rec.offset) && _rec.offset >= 0) {
											if (_recoverSeqs === null) _recoverSeqs = {};
											_recoverSeqs[_t] = _rec.offset;
											if (Number.isInteger(_rec.epoch)) { if (_recoverEpochs === null) _recoverEpochs = {}; _recoverEpochs[_t] = _rec.epoch; }
										}
									}
									if (_recoverSeqs !== null && userHandlers.resume) {
										try {
											await userHandlers.resume(wrapped, { sessionId: wrapped.getUserData()[WS_SESSION_ID], lastSeenSeqs: _recoverSeqs, lastSeenEpochs: _recoverEpochs || undefined, platform: wrapped.getUserData()[WS_PLATFORM] });
										} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
									}
								}
								for (let i = 0; i < valid.length; i++) {
									const topic = valid[i];
									const denial = (authzDeniedV !== null && authzDeniedV[i] ? 'FORBIDDEN' : null)
										?? (batchDenials !== null
											? (batchDenials[topic] ?? null)
											: (perTopicDenials !== null ? perTopicDenials[i] : null));
									if (denial !== null) {
										sendDenied(ws, topic, ref, denial);
										continue;
									}
									if (udSubs.has(topic)) {
										sendSubscribedV(ws, topic, ref);
										continue;
									}
									if (udSubs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
										sendDenied(ws, topic, ref, 'RATE_LIMITED');
										continue;
									}
									subs?.add(topic);
									udSubs.add(topic);
									sendSubscribedV(ws, topic, ref);
								}
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
								if (userHandlers.resume) {
									try {
										// Mirror production: await the user hook so
										// per-topic replay completes before the
										// `resumed` ack tells the client to switch
										// to live mode.
										await userHandlers.resume(wrapped, {
											sessionId: msg.sessionId,
											lastSeenSeqs: msg.lastSeenSeqs,
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
								const gud = /** @type {any} */ (ws).__userData;
								const grantTopic = gud?.[WS_PUBLISH_GRANT];
								if (!grantTopic || typeof msg.event !== 'string') {
									const reason = grantTopic ? 'INVALID' : 'FORBIDDEN';
									const denied = msg.id === undefined
										? JSON.stringify({ type: 'game-denied', reason })
										: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
									ws.send(denied);
									bumpOutV(gud, denied);
									return;
								}
								platform.publishGame(ws, grantTopic, msg.event, msg.data, msg.id);
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
					if (userHandlers.message) {
						userHandlers.message(wrapped, { data: arrayBuffer, isBinary: !!isBinary, msg, platform: wrapped.getUserData()[WS_PLATFORM] });
					}
				});

				ws.on('close', (code, reason) => {
					const reasonBuf = reason || Buffer.alloc(0);
					const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
					const ud = /** @type {any} */ (ws).__userData || {};
					const subs = ud[WS_SUBSCRIPTIONS] || new Set();
					const pending = ud[WS_PENDING_REQUESTS];
					if (pending && pending.size > 0) {
						for (const entry of pending.values()) {
							clearTimeout(entry.timer);
							try { entry.reject(new Error('connection closed')); } catch {}
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
			handlerReady = server.ssrLoadModule(resolvedHandlerPath).then((mod) => {
				handlerFailed = false;
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
					// Close existing connections so they reconnect with the new handler.
					// 1012 = "Service Restart" - clients with auto-reconnect will reconnect.
					for (const ws of connections) {
						ws.close(1012, 'Handler reloaded');
					}
					console.log('[adapter-uws] WebSocket handler reloaded, existing connections closed');
				}
			}).catch((err) => {
				handlerFailed = true;
				console.error('[adapter-uws] Failed to reload WebSocket handler:', err.message);
			});
		}
	};
}

/** @deprecated Use `uws()` instead. */
export const uwsDev = uws;
