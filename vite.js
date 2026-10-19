import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCookies, createCookies } from './files/cookies.js';
import { esc, isValidWireTopic, createScopedTopic, resolveRequestId, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, nextTopicSeq, isAuthOriginAccepted, isOriginAllowed, assert, WS_SUBSCRIPTIONS, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, runHook, runUnsubscribeHook } from './files/utils.js';

// Vite 5 shares unfinished SSR imports across server instances. Keep only the
// outstanding work so a replacement can invalidate stale results after it settles.
const legacyImports = new Map();
const lifecycleTimeout = 30000;
const legacyImportMessage = 'Waiting for an earlier Vite 5 WebSocket handler import to finish. If it never settles, fix its module-scope initialization and restart the dev process.';
// Subscription checks deny once a handler file is found or configured but no
// handler instance is live, and for everything a retired instance owned.
const retiredHandlers = Object.freeze({ subscribe: () => 'INTERNAL_ERROR' });
// Vite keys module files with forward slashes on Windows. A handler import
// that fails to resolve keeps the spelling it was given, so pass that form.
const viteFile = file => process.platform === 'win32' ? file.replaceAll('\\', '/') : file;

// On Windows one file can be spelled with any letter case and with 8.3 short
// directory names, and the dev root, the watcher and Vite's resolver can each
// pick a different spelling. The disk's own spelling; a deleted file keeps the
// spelling of its directory.
function diskSpelling(file) {
	try { return realpathSync.native(file); } catch {}
	try { return path.join(realpathSync.native(path.dirname(file)), path.basename(file)); } catch {}
	return file;
}

// A test for paths naming `file`. The disk spellings are read only when the
// base names already match, and the one of `file` only once.
function pathMatcher(file) {
	const target = path.resolve(file);
	const base = path.basename(target).toLowerCase();
	let disk;
	return candidate => {
		const other = path.resolve(candidate);
		if (other === target) return true;
		if (process.platform !== 'win32' || path.basename(other).toLowerCase() !== base) return false;
		if (other.toLowerCase() === target.toLowerCase()) return true;
		disk ??= diskSpelling(target).toLowerCase();
		return diskSpelling(other).toLowerCase() === disk;
	};
}

const samePath = (a, b) => pathMatcher(b)(a);

// `file` spelled as `root` plus the disk's spelling below `rootDisk`, or null
// for a file outside that root.
function underRoot(root, rootDisk, file) {
	const below = path.relative(rootDisk, diskSpelling(file));
	if (!below || path.isAbsolute(below) || below === '..' || below.startsWith('..' + path.sep)) return null;
	return path.join(root, below);
}

// The path the handler is imported with. On Windows it is the root as SvelteKit
// spells it plus the disk's spelling below that root, so the handler's graph
// node is the file the watcher reports and its imports resolve like the routes'.
// A handler outside the root keeps its configured path.
function handlerImport(state) {
	if (process.platform !== 'win32' || !state.discoveryRoot) return state.path;
	state.discoveryDisk ??= diskSpelling(state.discoveryRoot);
	return underRoot(state.discoveryRoot, state.discoveryDisk, state.path) ?? state.path;
}

// The handler's graph nodes under every spelling it may be keyed by: the
// configured one, the disk's, the one it is imported with, and Vite's own root
// spelling, which keeps 8.3 short names until Vite's startup path probe ends.
function handlerNodes(graph, state) {
	const keys = [state.path];
	if (process.platform === 'win32') {
		state.rootDisk ??= diskSpelling(state.root);
		keys.push(diskSpelling(state.path), handlerImport(state), underRoot(state.root, state.rootDisk, state.path) ?? state.path);
	}
	const nodes = new Set();
	for (const key of new Set(keys.map(viteFile))) for (const node of graph?.getModulesByFile(key) ?? []) nodes.add(node);
	return nodes;
}

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
	const subscriptionOwners = new WeakMap();
	const platformOwners = new WeakMap();
	let sendToAsyncWarnedV = false;

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

	// A socket is judged by the hooks of the instance that accepted it. Other
	// sockets go through the receiver's platform epoch, which denies once its
	// instance retires.
	function subscriptionOwner(ws, receiver, fallback) {
		const owner = subscriptionOwners.get(ws);
		if (owner) return owner;
		// Request code often derives its own object from a platform clone.
		for (let target = receiver; target && typeof target === 'object'; target = Object.getPrototypeOf(target)) {
			const epoch = platformOwners.get(target);
			if (epoch) return epoch.handlers;
		}
		return fallback();
	}

	function createSubscriptionMethods(getHandlers) {
		return {
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
				const denial = await runUserSubscribeGateV(ws, topic, subscriptionOwner(ws, this, getHandlers));
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
				return await runUserSubscribeGateV(ws, topic, subscriptionOwner(ws, this, getHandlers));
			},
			unsubscribe(ws, topic) {
				const ud = ws.getUserData();
				const subs = ud?.[WS_SUBSCRIPTIONS];
				if (!(subs instanceof Set) || !subs.has(topic)) return false;
				ws.unsubscribe(topic);
				subs.delete(topic);
				runUnsubscribeHook(subscriptionOwner(ws, this, getHandlers), ws, topic, { platform: ud[WS_PLATFORM] });
				return true;
			}
		};
	}

	// Dev-mode platform - same API shape as production. Every primitive on
	// the production base platform must exist here too, even when dev
	// degrades it to a no-op or zero-valued snapshot. Downstream wrappers
	// (extensions packages, app-level platform decorators) capture method
	// references via `platform.X.bind(platform)` at construction time, and
	// silently-undefined properties become "Cannot read properties of
	// undefined (reading 'bind')" on the first message. Missing surface in
	// dev defeats the dev/prod parity contract.
	function createPlatformEpoch() {
		const epoch = { handlers: {}, platform: null };
		epoch.platform = {
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
			...createSubscriptionMethods(() => epoch.handlers),
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
		return epoch;
	}

	let platformEpoch = createPlatformEpoch();
	// Deny until configureServer knows whether a handler file exists.
	platformEpoch.handlers = retiredHandlers;
	let platform = platformEpoch.platform;
	const builtinKeys = new Set(Reflect.ownKeys(platform));

	function installEpoch(epoch) {
		const previous = platform;
		epoch.handlers = retiredHandlers;
		platformEpoch = epoch;
		platform = epoch.platform;
		if (globalThis.__uws_dev_platform === previous) globalThis.__uws_dev_platform = platform;
	}

	function resetPlatform(instance) {
		if (instance.epoch !== platformEpoch) return false;
		// The abandoned platform keeps denying, also while a late shutdown runs.
		instance.epoch.abandoned = true;
		instance.epoch.handlers = retiredHandlers;
		installEpoch(createPlatformEpoch());
		return true;
	}

	// Each handler instance gets its own platform object. A retired instance's
	// platform is replaced with fresh built-ins, so wrappers installed on them
	// at any time never stack across reloads, while custom properties carry
	// over as shared state.
	function replacePlatform(instance) {
		if (instance.epoch !== platformEpoch) return;
		const epoch = createPlatformEpoch();
		const previous = instance.epoch.platform;
		for (const key of Reflect.ownKeys(previous)) {
			if (!builtinKeys.has(key)) Reflect.defineProperty(epoch.platform, key, Reflect.getOwnPropertyDescriptor(previous, key));
		}
		installEpoch(epoch);
	}

	// Expose platform globally so hooks/load functions can access it in dev
	globalThis.__uws_dev_platform = platform;

	/** @type {Promise<void>} */
	let handlerReady = Promise.resolve();
	let handlersSettled = true;
	const handlerWaiters = new Set();
	let lifecycleState;
	const environmentStates = new WeakMap();

	/** @type {import('vite').ViteDevServer | null} */
	let viteServer = null;
	let loadDevModule;
	let useEnvironmentRunner = false;
	const reloadModuleId = '\0svelte-adapter-uws:reload';
	const reloadEvent = 'svelte-adapter-uws:reload';

	/** @type {string | null} Resolved absolute path of the WS handler file */
	let resolvedHandlerPath = null;

	/** True when a handler file was found but failed to load - reject upgrades */
	let handlerFailed = false;

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
	async function runSubscribeHookV(wrapped, topic, handlers = userHandlers) {
		if (!handlers.subscribe) return null;
		try {
			const result = await handlers.subscribe(wrapped, topic, { platform: wrapped.getUserData()[WS_PLATFORM] });
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
	async function runSubscribeBatchHookV(wrapped, topics, handlers = userHandlers) {
		if (!handlers.subscribeBatch) return null;
		let result;
		try {
			result = await handlers.subscribeBatch(wrapped, topics, { platform: wrapped.getUserData()[WS_PLATFORM] });
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
	async function runUserSubscribeGateV(wrapped, topic, handlers = userHandlers) {
		if (handlers.subscribeBatch) {
			const batchDenials = await runSubscribeBatchHookV(wrapped, [topic], handlers);
			if (batchDenials !== null) {
				return batchDenials[topic] ?? null;
			}
		} else {
			// Skip the batch probe's async frame and topic array, but keep its
			// await so the subscribe hook runs on the same tick as in production.
			await undefined;
		}
		return await runSubscribeHookV(wrapped, topic, handlers);
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

	/** @param {Record<string, any>} mod */
	function extractHandlers(mod) {
		return {
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

	function setHandlerReady(ready) {
		handlerReady = ready;
		handlersSettled = false;
		void ready.then(() => { if (ready === handlerReady) handlersSettled = true; });
		for (const notify of handlerWaiters) notify();
		handlerWaiters.clear();
	}

	async function waitForHandlers() {
		while (!handlersSettled) {
			const ready = handlerReady;
			let notify;
			const changed = new Promise(resolve => { notify = resolve; });
			handlerWaiters.add(notify);
			try {
				// A superseded import can stay pending forever. Wake existing requests
				// when the generation changes instead of waiting for that import.
				await Promise.race([ready, changed]);
			} finally {
				handlerWaiters.delete(notify);
			}
			if (ready === handlerReady) break;
		}
		return { generation: lifecycleState?.generation, instance: lifecycleState?.active, handlers: userHandlers };
	}

	function currentHandlers(state, snapshot) {
		return handlersSettled && isCurrent(state, snapshot.generation) &&
			state.active === snapshot.instance && userHandlers === snapshot.handlers;
	}

	function advanceGeneration(state) {
		return ++state.generation;
	}

	function isCurrent(state, generation) {
		return lifecycleState === state && !state.closed && state.generation === generation;
	}

	function enqueueLifecycle(state, operation) {
		state.queue = state.queue.then(operation, operation);
		return state.queue;
	}

	async function runLifecycleHook(instance, hook) {
		if (typeof instance.handlers[hook] !== 'function') return;
		const running = Promise.resolve().then(() => instance.handlers[hook]({ platform: instance.platform }));
		if (hook === 'init') {
			instance.initializing = running;
			void running.then(
				() => { instance.initSettled = true; },
				() => { instance.initSettled = true; }
			);
		}
		let timer;
		try {
			await Promise.race([running, new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					const reset = resetPlatform(instance);
					const error = new Error(`WebSocket ${hook} hook did not finish within 30 seconds.` + (reset ? ' Dev platform state was reset. Restart the dev process if initialization relies on state outside the platform.' : ''));
					if (hook === 'init') {
						console.error('[adapter-uws] ' + error.message + ' Its cleanup will run if initialization finishes later.');
					}
					reject(error);
				}, lifecycleTimeout);
				timer.unref?.();
			})]);
		} finally { clearTimeout(timer); }
	}

	async function shutdownInstance(instance) {
		if (!instance || instance.stopped) return;
		instance.stopped = true;
		const cleanup = async () => {
			if (!instance.epoch.abandoned) instance.epoch.handlers = instance.handlers;
			try { await runLifecycleHook(instance, 'shutdown'); }
			catch (error) { console.error('[ws] shutdown hook threw:', error); }
			finally {
				if (instance.epoch.handlers === instance.handlers) instance.epoch.handlers = retiredHandlers;
				replacePlatform(instance);
			}
		};
		if (instance.initializing && !instance.initSettled) {
			// A timed-out init can still acquire resources when its await ends.
			// Clean those resources once, after that invocation settles.
			void instance.initializing.then(cleanup, cleanup);
			return;
		}
		await cleanup();
	}

	async function retireHandlers(state) {
		const previous = state.active;
		state.active = null;
		if (lifecycleState === state) {
			for (const ws of connections) ws.close(1012, 'Handler reloaded');
			userHandlers = {};
		}
		await shutdownInstance(previous);
	}

	function stopLifecycle(state) {
		if (!state) return Promise.resolve();
		if (state.stopping) return state.stopping;
		state.closed = true;
		advanceGeneration(state);
		state.disconnect?.();
		state.cancelListening?.();
		if (lifecycleState === state) {
			handlerFailed = true;
			setHandlerReady(Promise.resolve());
		}
		state.stopping = enqueueLifecycle(state, () => retireHandlers(state));
		return state.stopping;
	}

	function settleLegacyLoad(state, loading, generation) {
		if (state.currentLoad === loading) state.currentLoad = null;
		if (state.closed) return;
		if (!isCurrent(state, generation)) state.repairLegacyGraph = true;
		if (!state.repairLegacyGraph || state.currentLoad || state.repairQueued) return;
		state.repairQueued = true;
		queueMicrotask(() => {
			state.repairQueued = false;
			if (state.closed || state.currentLoad || !state.repairLegacyGraph) return;
			state.repairLegacyGraph = false;
			// The compatibility loader can write stale exports after invalidation.
			// Let the current import settle, then rebuild one shared graph.
			state.server.moduleGraph.invalidateAll();
			void reloadHandlers(state);
		});
	}

	function reloadHandlers(state, gate = Promise.resolve()) {
		const generation = advanceGeneration(state);
		const work = (async () => {
			await gate;
			await state.listening;
			if (!useEnvironmentRunner) {
				// Legacy transforms started in the invalidation millisecond are not
				// cached by Vite. Import on a later tick so HTTP reuses this graph.
				const invalidatedAt = Date.now();
				do { await new Promise(resolve => setTimeout(resolve, 1)); }
				while (Date.now() <= invalidatedAt);
			}
			if (!isCurrent(state, generation)) return;
			const unfinished = state.vite5 && legacyImports.get(state.root);
			if (unfinished?.size) {
				state.importPending = true;
				handlerFailed = true;
				console.error('[adapter-uws] ' + legacyImportMessage);
				await enqueueLifecycle(state, () => retireHandlers(state));
				void Promise.allSettled([...unfinished]).then(() => {
					// A late rejection can cache an error after HMR invalidation,
					// even when a newer save has already superseded this waiter.
					state.repairLegacyGraph = true;
					settleLegacyLoad(state, null, generation);
				});
				return;
			}
			state.importPending = false;
			const loading = state.load(handlerImport(state));
			if (!useEnvironmentRunner) {
				state.currentLoad = loading;
				void loading.then(
					() => settleLegacyLoad(state, loading, generation),
					() => settleLegacyLoad(state, loading, generation)
				);
			}
			if (state.vite5) {
				const pending = legacyImports.get(state.root) ?? new Set();
				legacyImports.set(state.root, pending);
				pending.add(loading);
				void loading.catch(() => {}).finally(() => {
					pending.delete(loading);
					if (pending.size === 0 && legacyImports.get(state.root) === pending) legacyImports.delete(state.root);
				});
			}
			const mod = await loading;
			if (!isCurrent(state, generation)) return;
			await enqueueLifecycle(state, async () => {
				if (!isCurrent(state, generation)) return;
				const handlers = extractHandlers(mod);
				if (state.active && Object.keys(handlers).every(key => handlers[key] === state.active.handlers[key])) {
					handlerFailed = false;
					return;
				}
				await retireHandlers(state);
				if (!isCurrent(state, generation)) return;
				platformEpoch.handlers = handlers;
				const instance = { handlers, stopped: false, epoch: platformEpoch, platform };
				state.active = instance;
				try { await runLifecycleHook(instance, 'init'); }
				catch (error) {
					state.active = null;
					await shutdownInstance(instance);
					throw error;
				}
				if (!isCurrent(state, generation)) {
					state.active = null;
					await shutdownInstance(instance);
					return;
				}
				userHandlers = handlers;
				handlerFailed = false;
			});
		})().catch(async (error) => {
			if (!isCurrent(state, generation)) return;
			await enqueueLifecycle(state, async () => {
				if (!isCurrent(state, generation)) return;
				handlerFailed = true;
				await retireHandlers(state);
				console.error('[adapter-uws] Failed to load or initialize WebSocket handler:', error);
				if (error instanceof TypeError && /redefine property|read[- ]only|cannot delete property|only a getter/i.test(error.message)) {
					console.error('[adapter-uws] If this error comes from a locked platform property: custom platform properties carry over to the next development platform with their descriptors, so keep them configurable and writable, and give accessors a setter, when init sets them again. Restart the dev process to clear a locked property.');
				}
			});
		});
		state.ready = work;
		if (lifecycleState === state) setHandlerReady(work);
		return work;
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

	function affectsLegacyHandler(server, state, file) {
		const changed = pathMatcher(file);
		if (changed(state.path)) return true;
		const graph = server.environments?.ssr?.moduleGraph ?? server.moduleGraph;
		const pending = [...handlerNodes(graph, state)];
		const visited = new Set();
		while (pending.length > 0) {
			const mod = pending.pop();
			if (visited.has(mod)) continue;
			visited.add(mod);
			if (mod.file && changed(mod.file)) return true;
			for (const dependency of mod.ssrImportedModules ?? mod.importedModules ?? []) pending.push(dependency);
		}
		return false;
	}

	function connectLegacyReload(server, state) {
		if (server.environments) {
			// Vite 6+ invalidates the SSR graph after all hotUpdate hooks. Run
			// the import only when its environment update coordinator completes.
			const previous = server.config.server.hotUpdateEnvironments;
			async function updateEnvironments(server, update) {
				try {
					if (previous) await previous(server, update);
					else await Promise.all(Object.values(server.environments).map(environment => update(environment)));
				} finally {
					state.legacyUpdates = Math.max(0, state.legacyUpdates - 1);
				}
				if (!state.closed && state.legacyUpdates === 0 && state.legacyDirty) {
					state.legacyDirty = false;
					void reloadHandlers(state);
				}
			}
			server.config.server.hotUpdateEnvironments = updateEnvironments;
			state.disconnect = () => {
				if (server.config.server.hotUpdateEnvironments === updateEnvironments) {
					if (previous) server.config.server.hotUpdateEnvironments = previous;
					else delete server.config.server.hotUpdateEnvironments;
				}
			};
			return;
		}

		// Vite 5 broadcasts from its aggregate hot channel after invalidating
		// the legacy graph. Individual plugin WebSocket messages are separate.
		const hot = server.hot ?? server.ws;
		if (!hot) return;
		const send = hot.send;
		// A created or deleted handler file reloads only once Vite has invalidated
		// its graph node: a broadcast for another file can come first, and an
		// import then would return the cached module. Such an earlier reload
		// leaves the file event pending.
		const fileEventSettled = () => state.legacyFileEvent &&
			[...handlerNodes(server.moduleGraph, state)].every(node => !node.ssrModule && !node.ssrTransformResult);
		function sendWithReload(...args) {
			const result = send.apply(this, args);
			if (state.closed || (args[0]?.type !== 'full-reload' && args[0]?.type !== 'update')) return result;
			const settled = fileEventSettled();
			if (state.legacyDirty || settled) {
				state.legacyDirty = false;
				if (settled) state.legacyFileEvent = false;
				void reloadHandlers(state);
			}
			return result;
		}
		hot.send = sendWithReload;
		state.disconnect = () => { if (hot.send === sendWithReload) hot.send = send; };
	}

	async function connectRunnerReload(server, state) {
		const environment = server.environments.ssr;
		const hot = environment.hot;
		if (!hot) return;
		const { onReload } = await environment.runner.import(reloadModuleId);
		if (state.closed) return;
		const pending = new Map();
		let token = 0;
		const disconnect = onReload((id) => {
			const entry = pending.get(id);
			if (!entry) return;
			clearTimeout(entry.timer);
			pending.delete(id);
			entry.resolve();
			// User init must not block the runner from processing the next edit.
		});
		if (!disconnect) return;
		const send = hot.send;
		function sendWithReload(...args) {
			const payload = args[0];
			let entry;
			let id;
			if (!state.closed && state.path && (payload?.type === 'full-reload' || payload?.type === 'update')) {
				id = ++token;
				entry = {};
				const ready = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
				// Reserve the new generation before the runner starts invalidating.
				entry.work = reloadHandlers(state, ready);
				entry.timer = setTimeout(() => {
					pending.delete(id);
					entry.reject(new Error('The Vite SSR reload did not finish. Restart the dev server.'));
				}, 10000);
				entry.timer.unref?.();
				pending.set(id, entry);
			}
			const result = send.apply(this, args);
			if (entry) {
				// Custom events run after the preceding reload has cleared the runner
				// cache and reimported affected entrypoints.
				send.call(this, { type: 'custom', event: reloadEvent, data: id });
			}
			return result;
		}
		hot.send = sendWithReload;
		state.disconnect = () => {
			disconnect();
			if (hot.send === sendWithReload) hot.send = send;
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.resolve();
			}
			pending.clear();
		};
	}

	/** SSR-build state captured in `configResolved` and consumed in `buildStart`. */
	let ssrHandlerPath = /** @type {string | null} */ (null);
	/** The root as SvelteKit computes it from the user config, before Vite resolves it. */
	let configRoot = /** @type {string | null} */ (null);

	return {
		name: 'svelte-adapter-uws',
		resolveId(id) {
			if (id === reloadModuleId) return id;
		},
		load(id) {
			if (id === reloadModuleId) {
				return `export function onReload(callback) {
	const hot = import.meta.hot;
	if (!hot) return;
	hot.on(${JSON.stringify(reloadEvent)}, callback);
	return () => hot.off(${JSON.stringify(reloadEvent)}, callback);
}`;
			}
		},
		config(config) {
			configRoot = config.root ? path.resolve(config.root) : process.cwd();
		},
		configResolved(resolved) {
			// Capture the handler path once the resolved Vite config is
			// available. SvelteKit runs Vite 7's environment API with
			// separate `client` and `ssr` environments; `env.isSsrBuild`
			// in `config()` is `false` even during the SSR build, so we
			// detect the legacy SSR build or the shared server environment.
			if (resolved.build?.ssr || (resolved.command === 'build' && resolved.environments?.ssr)) {
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
				// No handler can run, so subscription checks behave as without one.
				platformEpoch.handlers = {};
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
				platformEpoch.handlers = {};
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

			await stopLifecycle(lifecycleState);
			const state = {
				generation: 0, active: null, queue: Promise.resolve(), closed: false,
				legacyUpdates: 0, legacyDirty: false, vite5: !server.environments,
				importPending: false,
				server, root: path.resolve(server.config.root)
			};
			lifecycleState = state;
			for (const environment of Object.values(server.environments ?? {})) environmentStates.set(environment, state);
			if (!server.environments) {
				// Inline plugins can be reused while Vite creates the replacement
				// server. Closing the old server must retire only its own handler.
				const close = server.close;
				server.close = async () => {
					try { await stopLifecycle(state); }
					finally { await close.call(server); }
				};
			}
			handlerFailed = false;
			setHandlerReady(Promise.resolve());
			server.httpServer.once('close', () => { void stopLifecycle(state); });
			wss = new WebSocketServer({ noServer: true });
			viteServer = server;
			// On Windows discover the handler under the root spelling SvelteKit uses
			// for routes; Vite 8 can resolve its own root to the disk's spelling.
			const root = state.discoveryRoot = (process.platform === 'win32' && configRoot) || server.config.root;

			// Kit 3 serves routes through the runnable SSR environment. Its legacy
			// ssrLoadModule graph is separate, so using it would duplicate shared state.
			useEnvironmentRunner = (server.config.plugins ?? []).some(plugin =>
				plugin?.name === 'vite-plugin-sveltekit-setup' && plugin.api?.options?.paths
			);
			state.listening = server.httpServer.listening ? Promise.resolve() : new Promise(resolve => {
				const ready = () => {
					server.httpServer.off('listening', ready);
					state.cancelListening = null;
					resolve();
				};
				state.cancelListening = ready;
				server.httpServer.once('listening', ready);
			});
			let runnerReloadReady;
			state.load = loadDevModule = async (id) => {
				if (useEnvironmentRunner) {
					await (runnerReloadReady ??= connectRunnerReload(server, state));
					return server.environments.ssr.runner.import(viteFile(id));
				}
				return server.ssrLoadModule(viteFile(id));
			};

			if (!useEnvironmentRunner) connectLegacyReload(server, state);
			state.path = resolvedHandlerPath = discoverHandler(root);
			// Without a handler file or option subscription checks allow, as in
			// production without hooks; with one they deny until its instance is live.
			platformEpoch.handlers = state.path ? retiredHandlers : {};

			if (state.path) reloadHandlers(state);

			// /__ws/auth middleware: runs the user's `authenticate` hook as a normal
			// HTTP POST so session cookies are refreshed via a standard Set-Cookie
			// on a 200-series response. Mirrors the production handler in dev.
			server.middlewares.use(wsAuthPath, async (req, res, next) => {
				let authHandlers = await waitForHandlers();
				if (req.aborted || res.destroyed) return;
				if (!currentHandlers(state, authHandlers)) {
					res.statusCode = 503;
					res.end('WebSocket handler reloading');
					return;
				}
				if (handlerFailed) {
					res.statusCode = state.importPending ? 503 : 500;
					res.end(state.importPending ? legacyImportMessage : 'WebSocket handler unavailable');
					return;
				}
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
				try {
					for await (const chunk of req) {
						total += chunk.length;
						if (total > AUTH_BODY_LIMIT) { oversized = true; break; }
						chunks.push(chunk);
					}
				} catch {
					if (!res.destroyed) {
						res.statusCode = 400;
						res.end('Could not read authentication request');
					}
					return;
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

				authHandlers = await waitForHandlers();
				if (req.aborted || res.destroyed) return;
				if (!currentHandlers(state, authHandlers)) {
					res.statusCode = 503;
					res.end('WebSocket handler reloading');
					return;
				}
				if (handlerFailed) {
					res.statusCode = state.importPending ? 503 : 500;
					res.end(state.importPending ? legacyImportMessage : 'WebSocket handler unavailable');
					return;
				}
				if (!userHandlers.authenticate) { next(); return; }

				const cookies = createCookies(headers['cookie']);
				const clientIp = req.socket?.remoteAddress || '';
				const authRequestId = resolveRequestId(headers['x-request-id']) || randomUUID();
				const authPlatform = Object.create(state.active?.platform ?? platform);
				platformOwners.set(authPlatform, authHandlers.instance?.epoch ?? platformEpoch);
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
					const result = await Promise.resolve(authHandlers.handlers.authenticate(event));
					if (req.aborted || res.destroyed) return;
					if (!currentHandlers(state, authHandlers)) {
						res.statusCode = 503;
						res.end('WebSocket handler reloading');
						return;
					}

					if (result === false) {
						res.statusCode = 401;
						res.setHeader('content-type', 'text/plain');
						res.end('Unauthorized');
						return;
					}

					if (result instanceof Response) {
						const body = result.body ? Buffer.from(await result.arrayBuffer()) : null;
						if (req.aborted || res.destroyed) return;
						if (!currentHandlers(state, authHandlers)) {
							res.statusCode = 503;
							res.end('WebSocket handler reloading');
							return;
						}
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
						res.end(body);
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
				// A target such as `//` does not parse, and a throw here would
				// reject this listener's promise with nothing to catch it.
				let pathname;
				try {
					({ pathname } = new URL(req.url || '', 'http://localhost'));
				} catch {
					return;
				}
				if (pathname !== wsPath) return;

				// Node removes its own socket error listener when it hands over an
				// upgrade, and this handler awaits before ws owns the socket. A
				// client that resets in that window, or while one of the refusals
				// below is written, must not crash the dev server.
				const onSocketError = () => socket.destroy();
				socket.on('error', onSocketError);

				const upgradeHandlers = await waitForHandlers();
				if (!currentHandlers(state, upgradeHandlers)) {
					socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nWebSocket handler reloading');
					return;
				}

				// If the handler failed to load, reject the
				// upgrade so a broken auth handler does not silently degrade
				// to open access.
				if (handlerFailed) {
					if (state.importPending) {
						socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n' + legacyImportMessage);
						return;
					}
					socket.write(
						'HTTP/1.1 500 Internal Server Error\r\n' +
						'Content-Type: text/plain\r\n\r\n' +
						'WebSocket handler failed to load - check the server console'
					);
					socket.destroy();
					return;
				}

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

				/** @type {Record<string, string>} */
				const upgradeHeaders = {};
				for (const [key, value] of Object.entries(req.headers)) {
					if (typeof value === 'string') upgradeHeaders[key] = value;
					else if (Array.isArray(value)) upgradeHeaders[key] = value.join(', ');
				}
				const wsRequestId = resolveRequestId(upgradeHeaders['x-request-id']) || randomUUID();

				if (upgradeHandlers.handlers.upgrade) {
					try {
						const result = await Promise.resolve(
							upgradeHandlers.handlers.upgrade({
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
										'A cookie on the 101 reaches the browser only if every proxy in the path ' +
										'forwards the 101 unchanged. Use the `authenticate` hook to refresh ' +
										'session cookies over a normal HTTP response.\n' +
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

				if (!currentHandlers(state, upgradeHandlers)) {
					socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nWebSocket handler reloading');
					return;
				}

				socket.removeListener('error', onSocketError);
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
				const connectionHandlers = userHandlers;
				const connectionOwner = state.active?.epoch ?? platformEpoch;
				connections.add(ws);
				subscriptions.set(ws, new Set());

				const userData = /** @type {any} */ (ws).__userData || {};
				userData[WS_SUBSCRIPTIONS] = new Set();
				// Promote the upgrade-time requestId into a per-connection
				// platform clone (parity with the production handler).
				const wsPlatform = Object.create(state.active?.platform ?? platform);
				platformOwners.set(wsPlatform, connectionOwner);
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
				subscriptionOwners.set(wrapped, connectionHandlers);
				wsWrappers.set(ws, wrapped);

				const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
				ws.send(welcome);
				bumpOutV(userData, welcome);

				// Call user open handler
				runHook(connectionHandlers, 'open', 'Open handler error', wrapped, { platform: userData[WS_PLATFORM] });

				ws.on('message', async (raw, isBinary) => {
					await waitForHandlers();
					if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
					if (handlerFailed) { ws.close(1011, 'Handler unavailable'); return; }
					// Convert to ArrayBuffer (matching uWS interface)
					const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
					const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
					bumpInV(userData, arrayBuffer);

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
								const denial = await runUserSubscribeGateV(wrapped, msg.topic, connectionHandlers);
								if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
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
								subscriptions.get(ws)?.add(msg.topic);
								subs.add(msg.topic);
								sendSubscribedV(ws, msg.topic, ref);
								return;
							}
							if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
								subscriptions.get(ws)?.delete(msg.topic);
								/** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS]?.delete(msg.topic);
								runUnsubscribeHook(connectionHandlers, wrapped, msg.topic, { platform: wrapped.getUserData()[WS_PLATFORM] });
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
								const batchDenials = await runSubscribeBatchHookV(wrapped, valid, connectionHandlers);
								if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
								const perTopicDenials = batchDenials === null && connectionHandlers.subscribe
									? await Promise.all(valid.map((t) => runSubscribeHookV(wrapped, t, connectionHandlers)))
									: null;
								if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
								const udSubs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS];
								assert(udSubs instanceof Set, 'subs.shape-batch', null);
								for (let i = 0; i < valid.length; i++) {
									const topic = valid[i];
									const denial = batchDenials !== null
										? (batchDenials[topic] ?? null)
										: (perTopicDenials !== null ? perTopicDenials[i] : null);
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
								if (connectionHandlers.resume) {
									try {
										// Mirror production: await the user hook so
										// per-topic replay completes before the
										// `resumed` ack tells the client to switch
										// to live mode.
										await connectionHandlers.resume(wrapped, {
											sessionId: msg.sessionId,
											lastSeenSeqs: msg.lastSeenSeqs,
											platform: wrapped.getUserData()[WS_PLATFORM]
										});
									} catch (err) {
										console.error('[adapter-uws] resume hook threw:', err);
									}
								}
								if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
								ws.send('{"type":"resumed"}');
								bumpOutV(userData, '{"type":"resumed"}');
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
					if (ws.readyState !== 1 || connectionHandlers !== userHandlers || state.closed) return;
					runHook(connectionHandlers, 'message', 'Message handler error', wrapped, { data: arrayBuffer, isBinary: !!isBinary, msg, platform: wrapped.getUserData()[WS_PLATFORM] });
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
					runHook(connectionHandlers, 'close', null, wrapped, ctx);
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
		watchChange(id, change) {
			// Kit 3 sees created and deleted handler files in its SSR hotUpdate.
			// The legacy hooks never discover a handler created after startup,
			// and Vite 5 runs handleHotUpdate only for edits.
			const state = lifecycleState;
			if (!state || state.closed || useEnvironmentRunner || !viteServer) return;
			if (change?.event !== 'create' && change?.event !== 'delete') return;
			if (!state.path) {
				if (change.event !== 'create') return;
				const discovered = discoverHandler(state.discoveryRoot);
				if (!discovered || !samePath(id, discovered)) return;
				state.path = resolvedHandlerPath = discovered;
				if (!state.active) platformEpoch.handlers = retiredHandlers;
				// Vite 6+ reports this creation to hotUpdate next; this reload covers it.
				state.createdHandler = !state.vite5;
				void reloadHandlers(state);
				return;
			}
			if (!state.vite5 || !samePath(id, state.path)) return;
			// Vite 5 invalidates the file's graph node after this hook and then
			// broadcasts; reload on that broadcast. With no node there is no
			// cached module to go stale, so reload now.
			if (handlerNodes(viteServer.moduleGraph, state).size) state.legacyFileEvent = true;
			else void reloadHandlers(state);
		},
		handleHotUpdate({ file }) {
			const state = lifecycleState;
			if (!state || state.closed || !state.path || useEnvironmentRunner) return;
			state.legacyDirty ||= affectsLegacyHandler(viteServer, state, file);
		},
		hotUpdate({ type, file }) {
			const state = lifecycleState;
			if (!state || state.closed) return;
			if (!useEnvironmentRunner) {
				if (this.environment.name === 'client') {
					state.legacyUpdates++;
					// The creation watchChange just discovered is already reloading.
					const created = state.createdHandler && type === 'create' && samePath(file, state.path);
					state.createdHandler = false;
					if (state.path && !created) state.legacyDirty ||= affectsLegacyHandler(viteServer, state, file);
				}
				return;
			}
			if (this.environment.name !== 'ssr') return;
			if (handlerFailed && state.path) {
				// Failed imports can lack a propagation boundary or dependency node.
				this.environment.moduleGraph.invalidateAll();
				this.environment.hot.send({ type: 'full-reload' });
				return [];
			}
			if (type === 'update') return;
			const discovered = state.path || discoverHandler(state.discoveryRoot);
			if (!discovered || !samePath(file, discovered)) return;
			const firstHandler = !state.path;
			state.path = resolvedHandlerPath = discovered;
			if (firstHandler) {
				if (!state.active) platformEpoch.handlers = retiredHandlers;
				void reloadHandlers(state);
				return [];
			}
			this.environment.moduleGraph.invalidateAll();
			this.environment.hot.send({ type: 'full-reload' });
			return [];
		},
		closeBundle() {
			if (this.environment) return stopLifecycle(environmentStates.get(this.environment));
		}
	};
}

/** @deprecated Use `uws()` instead. */
export const uwsDev = uws;
