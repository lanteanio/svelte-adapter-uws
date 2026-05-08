import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCookies, createCookies } from './files/cookies.js';
import { esc, isValidWireTopic, createScopedTopic, resolveRequestId, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, nextTopicSeq, WS_SUBSCRIPTIONS, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './files/utils.js';

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
	 * @param {{ relay?: boolean }} [_options] - Accepted for API parity with production; ignored in dev (single-process).
	 * @returns {boolean}
	 */
	function publish(topic, event, data, _options) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
		let sent = false;
		for (const [ws, topics] of subscriptions) {
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
			if (filter(wrapped.getUserData())) {
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

	// Dev-mode platform - same API shape as production. Every primitive on
	// the production base platform must exist here too, even when dev
	// degrades it to a no-op or zero-valued snapshot. Downstream wrappers
	// (extensions packages, app-level platform decorators) capture method
	// references via `platform.X.bind(platform)` at construction time, and
	// silently-undefined properties become "Cannot read properties of
	// undefined (reading 'bind')" on the first message. Missing surface in
	// dev defeats the dev/prod parity contract.
	const platform = {
		publish,
		publishBatched,
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
				topPublishers: []
			};
		},
		onPressure(_cb) { return () => {}; },
		onPublishRate(_cb) { return () => {}; },
		subscribe(ws, topic) {
			// Server-side subscribe with the user's `hooks.ws.subscribe`
			// authorization hook. Same contract as production: returns null
			// on success, denial reason string on failure.
			if (!isValidWireTopic(topic)) return 'INVALID_TOPIC';
			const ud = ws.getUserData();
			const subs = ud?.[WS_SUBSCRIPTIONS];
			if (!(subs instanceof Set)) return 'INVALID_TOPIC';
			if (subs.has(topic)) return null;
			if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
			const denial = runUserSubscribeGateV(ws, topic);
			if (denial !== null) return denial;
			ws.subscribe(topic);
			subs.add(topic);
			return null;
		},
		checkSubscribe(ws, topic) {
			// Pure gate: consult the user's hook chain without subscribing.
			// Same precedence as production (subscribeBatch first, falls
			// back to subscribe). No state mutation, no cap check.
			if (!isValidWireTopic(topic)) return 'INVALID_TOPIC';
			return runUserSubscribeGateV(ws, topic);
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
		get assertions() {
			// Dev never tracks invariant violations; production exposes a
			// live shared Map of category counts. Return a fresh empty Map
			// per read so downstream diagnostics that iterate or check size
			// see the documented "no violations" state.
			return new Map();
		},
		subscribers(topic) {
			let count = 0;
			for (const [, topics] of subscriptions) {
				if (topics.has(topic)) count++;
			}
			return count;
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
			return createScopedTopic(publish, name);
		}
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
	 * @returns {string | null}
	 */
	function runSubscribeHookV(wrapped, topic) {
		if (!userHandlers.subscribe) return null;
		try {
			const result = userHandlers.subscribe(wrapped, topic, { platform: wrapped.getUserData()[WS_PLATFORM] });
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
	 * @returns {Record<string, string> | null}
	 */
	function runSubscribeBatchHookV(wrapped, topics) {
		if (!userHandlers.subscribeBatch) return null;
		let result;
		try {
			result = userHandlers.subscribeBatch(wrapped, topics, { platform: wrapped.getUserData()[WS_PLATFORM] });
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
	 * @returns {string | null}
	 */
	function runUserSubscribeGateV(wrapped, topic) {
		const batchDenials = runSubscribeBatchHookV(wrapped, [topic]);
		if (batchDenials !== null) {
			return batchDenials[topic] ?? null;
		}
		return runSubscribeHookV(wrapped, topic);
	}

	/**
	 * @param {import('ws').WebSocket} ws
	 * @param {string} topic
	 * @param {number | string | null} ref
	 */
	function sendSubscribedV(ws, topic, ref) {
		if (ref === null) return;
		const payload = JSON.stringify({ type: 'subscribed', topic, ref });
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

			console.warn('[adapter-uws] Dev mode does not enforce allowedOrigins. ' +
				'WebSocket origin checks only run in production.');
			wss = new WebSocketServer({ noServer: true });
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
					console.error(`[adapter-uws] Failed to load WebSocket handler '${options.handler}':`, err);
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
										'refresh session cookies over a normal HTTP response.'
									);
								} else {
									console.warn('[adapter-uws] upgrade() returned response headers. These are only applied in production (uWS); the ws library used in dev does not support custom 101 headers.');
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

					// Handle subscribe/unsubscribe/subscribe-batch from client store.
				// Byte-prefix check: {"type" has byte[3]='y' (0x79), user envelopes
				// {"topic" have byte[3]='o' - skip JSON.parse for non-control messages.
				// 8192 bytes matches the production handler ceiling and is large
				// enough for a subscribe-batch with many topics.
					if (!isBinary && buf.byteLength < 8192 && buf[3] === 0x79) {
						try {
							const msg = JSON.parse(buf.toString());
							if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
								const ref = hasRefValue(msg.ref) ? msg.ref : null;
								if (!isValidWireTopic(msg.topic)) {
									sendDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
									return;
								}
								const subs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								const isNew = subs ? !subs.has(msg.topic) : true;
								if (subs && isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
									sendDenied(ws, msg.topic, ref, 'RATE_LIMITED');
									return;
								}
								const denial = runUserSubscribeGateV(wrapped, msg.topic);
								if (denial !== null) {
									sendDenied(ws, msg.topic, ref, denial);
									return;
								}
								subscriptions.get(ws)?.add(msg.topic);
								subs?.add(msg.topic);
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
								}
								return;
							}
							if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
								// Sent by the client store on open/reconnect to resubscribe all
								// topics in one message instead of N individual subscribe frames.
								const subs = subscriptions.get(ws);
								const topics = msg.topics.slice(0, 256);
								const ref = hasRefValue(msg.ref) ? msg.ref : null;
								const valid = [];
								for (const topic of topics) {
									if (!isValidWireTopic(topic)) {
										sendDenied(ws, topic, ref, 'INVALID_TOPIC');
										continue;
									}
									valid.push(topic);
								}
								const batchDenials = runSubscribeBatchHookV(wrapped, valid);
								const udSubs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								for (const topic of valid) {
									const isNew = udSubs ? !udSubs.has(topic) : true;
									if (udSubs && isNew && udSubs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
										sendDenied(ws, topic, ref, 'RATE_LIMITED');
										continue;
									}
									const denial = batchDenials !== null
										? (batchDenials[topic] ?? null)
										: runSubscribeHookV(wrapped, topic);
									if (denial !== null) {
										sendDenied(ws, topic, ref, denial);
										continue;
									}
									subs?.add(topic);
									udSubs?.add(topic);
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
								if (userHandlers.resume) {
									try {
										userHandlers.resume(wrapped, {
											sessionId: msg.sessionId,
											lastSeenSeqs: msg.lastSeenSeqs,
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
						} catch {
							// Not JSON - fall through to user handler
						}
					}

					// Delegate to user handler
					await handlerReady;
					if (userHandlers.message) {
						userHandlers.message(wrapped, { data: arrayBuffer, isBinary: !!isBinary, platform: wrapped.getUserData()[WS_PLATFORM] });
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
