// In-memory doubles of the uWS app + WebSocket surface that the createTestServer
// dispatch drives. Swapping the real `uWS.App()` for an InMemoryApp lets the
// exact same dispatch run under the virtual clock + seeded fault engine: no real
// sockets, no real timers, every frame routed through one fault-gated channel.
//
// Simulation infrastructure, not framework runtime. The TextEncoder/Decoder it
// uses to bridge string <-> ArrayBuffer are the wire's own encoding, nothing
// time- or randomness-dependent.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Normalize a wire payload to an ArrayBuffer (what the dispatch's `message`
 * handler reads: `.byteLength`, `new Uint8Array(msg)`, `Buffer.from(msg)`).
 * @param {string | Uint8Array | ArrayBuffer} payload
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(payload) {
	if (typeof payload === 'string') {
		const u8 = enc.encode(payload);
		return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
	}
	if (payload instanceof Uint8Array) {
		return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
	}
	if (payload instanceof ArrayBuffer) return payload;
	const u8 = enc.encode(String(payload));
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** uWS WebSocket.send return codes. */
const SEND_BACKPRESSURE = 0;
const SEND_SUCCESS = 1;
const SEND_DROPPED = 2;
void SEND_BACKPRESSURE; void SEND_DROPPED; // reserved for a later backpressure model

/**
 * Build the in-memory uWS app double + the means to open client connections to
 * it. The returned object is passed to createTestServer as the injected `app`;
 * `connect()` is the sim-only entry the runner drives clients through.
 *
 * @param {{
 *   scheduler: import('./sim-core.js').createScheduler extends (...a: any) => infer R ? R : any,
 *   faultEngine: { plan: (p: string | Uint8Array) => Array<{ delayMs: number, payload: string | Uint8Array }> },
 *   port?: number
 * }} opts
 */
export function createInMemoryApp(opts) {
	const scheduler = opts.scheduler;
	const faults = opts.faultEngine;
	const boundPort = opts.port || 4000;

	/** @type {Set<any>} live server-side ws handles */
	const connections = new Set();
	/** @type {{ open?: Function, message?: Function, close?: Function, drain?: Function, upgrade?: Function }} */
	let behavior = {};
	let wsPath = '/ws';
	/** @type {Map<string, Function>} GET/POST route handlers (waiting room etc.) */
	const routes = new Map();
	let listenSocket = null;
	let connSeq = 0;

	/**
	 * Schedule a one-way channel delivery through the fault engine + virtual
	 * clock. A dropped frame schedules nothing; delayed/duplicated frames land in
	 * a later timers phase, so reorder emerges from the per-frame sampled delays.
	 * @param {string | Uint8Array} payload
	 * @param {(payload: string | Uint8Array) => void} sink
	 */
	function channelSend(payload, sink) {
		const plan = faults.plan(payload);
		for (const d of plan) {
			scheduler._scheduleTimer(() => sink(d.payload), d.delayMs, [], false);
		}
	}

	// - Server-side WebSocket double ------------------------------------------

	/**
	 * @param {any} userData
	 * @param {{ deliver: (payload: string | Uint8Array, isBinary: boolean) => void, onServerClose: (code: number, reason: string) => void }} clientSide
	 */
	function makeServerWs(userData, clientSide) {
		/** @type {Set<string>} this connection's subscribed topics (the in-memory TopicTree) */
		const topics = new Set();
		let closed = false;
		const id = connSeq++;
		const ws = {
			_simId: id,
			_topics: topics,
			getUserData() { return userData; },
			send(message, isBinary = false, _compress = false, _routingTopic) {
				if (closed) throw new Error('Invalid access of closed uWS.WebSocket');
				// _routingTopic is the topic a publish fanned out on (set by app.publish);
				// undefined for a direct send. It rides through the fault-gated channel so
				// the client can be checked for misdelivery against the UNcorrupted routing
				// key rather than the (corruptible) decoded envelope body.
				channelSend(message, (payload) => clientSide.deliver(payload, !!isBinary, _routingTopic));
				return SEND_SUCCESS;
			},
			subscribe(topic) { if (closed) throw new Error('Invalid access of closed uWS.WebSocket'); topics.add(topic); return true; },
			unsubscribe(topic) { if (closed) throw new Error('Invalid access of closed uWS.WebSocket'); return topics.delete(topic); },
			isSubscribed(topic) { return topics.has(topic); },
			getTopics() { return [...topics]; },
			getBufferedAmount() { return 0; },
			// Report the same peer the upgrade resolved (the dispatch stamps it onto
			// userData.remoteAddress), so a live-ws read agrees with the upgrade-time
			// res.getRemoteAddressAsText() as it does on real uWS.
			getRemoteAddress() {
				const ip = String((userData && userData.remoteAddress) || '127.0.0.1');
				const parts = ip.split('.');
				return parts.length === 4
					? new Uint8Array(parts.map((n) => Number(n) & 0xff)).buffer
					: new Uint8Array([127, 0, 0, 1]).buffer;
			},
			getRemoteAddressAsText() { return enc.encode(String((userData && userData.remoteAddress) || '127.0.0.1')).buffer; },
			cork(fn) { return fn(); },
			end(code = 1000, reason = '') {
				if (closed) return;
				closed = true;
				connections.delete(ws);
				behavior.close?.(ws, code, enc.encode(String(reason)).buffer);
				clientSide.onServerClose(code, String(reason));
			},
			close() { ws.end(1006, ''); }
		};
		return ws;
	}

	// - The HTTP request/response doubles for the upgrade handshake -----------

	/** @param {Record<string, string>} headers @param {string} path @param {string} query */
	function makeReq(headers, path, query) {
		const lower = {};
		for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
		return {
			getHeader: (k) => lower[String(k).toLowerCase()] ?? '',
			forEach: (fn) => { for (const k of Object.keys(lower)) fn(k, lower[k]); },
			getQuery: () => query || '',
			getUrl: () => path,
			getMethod: () => 'get'
		};
	}

	/**
	 * @param {Record<string, string>} headers
	 * @param {(result: { ok: true, ws: any } | { ok: false, status: string, body: string }) => void} settle
	 * @param {{ deliver: (payload: string | Uint8Array, isBinary: boolean) => void, onServerClose: (code: number, reason: string) => void }} clientSide
	 */
	function makeRes(headers, settle, clientSide) {
		let status = '200 OK';
		let aborted = false;
		let settled = false;
		const res = {
			onAborted: (cb) => { res._onAborted = cb; },
			cork: (fn) => fn(),
			writeStatus: (s) => { status = s; return res; },
			writeHeader: () => res,
			getRemoteAddressAsText: () => enc.encode(headers['x-forwarded-for'] || '127.0.0.1').buffer,
			end: (body) => {
				if (settled) return res;
				settled = true;
				settle({ ok: false, status, body: body == null ? '' : String(body) });
				return res;
			},
			upgrade: (ud, _secKey, _secProtocol, _secExtensions, _context) => {
				if (settled || aborted) return;
				settled = true;
				const userData = ud && typeof ud === 'object' ? ud : {};
				const ws = makeServerWs(userData, clientSide);
				connections.add(ws);
				behavior.open?.(ws);
				settle({ ok: true, ws });
			},
			markAborted: () => { aborted = true; if (typeof res._onAborted === 'function') res._onAborted(); }
		};
		return res;
	}

	// - The client facade -----------------------------------------------------

	/**
	 * Open a client connection: synthesize the upgrade, run the dispatch's
	 * upgrade hook (which may await), and on res.upgrade() create the server ws +
	 * fire `open`. Returns a facade the runner drives. The connection completes
	 * during scheduler.run() when the upgrade hook's microtasks settle.
	 *
	 * @param {{ headers?: Record<string, string>, query?: string }} [connectOpts]
	 */
	function connect(connectOpts = {}) {
		const headers = connectOpts.headers || {};
		/** @type {Array<{ payload: string | Uint8Array, isBinary: boolean }>} */
		const received = [];
		/** @type {Array<(frame: { payload: string | Uint8Array, isBinary: boolean }) => void>} */
		const messageHandlers = [];
		let serverWs = null;
		let openState = 'connecting'; // 'connecting' | 'open' | 'rejected' | 'closed'
		let rejection = null;
		let closeInfo = null;

		const clientSide = {
			deliver(payload, isBinary, routingTopic) {
				const frame = { payload, isBinary, routingTopic };
				received.push(frame);
				for (const h of messageHandlers) h(frame);
			},
			onServerClose(code, reason) {
				if (openState === 'closed') return;
				openState = 'closed';
				closeInfo = { code, reason };
			}
		};

		const req = makeReq(headers, wsPath, connectOpts.query || '');
		const res = makeRes(headers, (result) => {
			if (result.ok) { serverWs = result.ws; openState = 'open'; }
			else { openState = 'rejected'; rejection = { status: result.status, body: result.body }; }
		}, clientSide);

		// Run the registered upgrade hook. With no user upgrade hook + no admission
		// budget the dispatch calls res.upgrade synchronously; an async upgrade
		// hook settles during scheduler.run().
		try {
			if (typeof behavior.upgrade === 'function') behavior.upgrade(res, req, {});
			else res.upgrade({}, '', '', '', {});
		} catch (err) {
			openState = 'rejected';
			rejection = { status: '500', body: String(err && err.message || err) };
		}

		const facade = {
			get state() { return openState; },
			get rejection() { return rejection; },
			get closeInfo() { return closeInfo; },
			/** Raw frames as received, in delivery order. */
			frames: () => received.slice(),
			/** Frames decoded to UTF-8 text. */
			texts: () => received.map((f) => (typeof f.payload === 'string' ? f.payload : dec.decode(f.payload))),
			/** Frames parsed as JSON envelopes; non-JSON frames become null. */
			json: () => received.map((f) => { try { return JSON.parse(typeof f.payload === 'string' ? f.payload : dec.decode(f.payload)); } catch { return null; } }),
			onMessage: (cb) => { messageHandlers.push(cb); },
			/** Send a raw frame client -> server through the fault-gated channel. */
			sendRaw(payload, isBinary = false) {
				if (!serverWs || openState !== 'open') return false;
				channelSend(payload, (p) => { behavior.message?.(serverWs, toArrayBuffer(p), isBinary); });
				return true;
			},
			/** Send a JSON control/envelope frame. */
			send(obj) { return facade.sendRaw(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
			subscribe(topic, ref) { return facade.send({ type: 'subscribe', topic, ref: ref ?? topic }); },
			unsubscribe(topic) { return facade.send({ type: 'unsubscribe', topic }); },
			/** Abort an in-flight upgrade (models the client disconnecting mid-handshake). */
			abort() {
				if (openState !== 'connecting') return false;
				res.markAborted();
				openState = 'rejected';
				rejection = { status: 'aborted', body: '' };
				return true;
			},
			/** Client-initiated close: fire the server close handler. */
			close(code = 1000, reason = '') {
				if (serverWs && openState === 'open') serverWs.end(code, reason);
				openState = 'closed';
			},
			get serverWs() { return serverWs; }
		};
		return facade;
	}

	// - The uWS app surface ---------------------------------------------------

	const app = {
		ws(path, b) { wsPath = path; behavior = b || {}; return app; },
		get(path, handler) { routes.set('GET ' + path, handler); return app; },
		post(path, handler) { routes.set('POST ' + path, handler); return app; },
		any(path, handler) { routes.set('ANY ' + path, handler); return app; },
		options(path, handler) { routes.set('OPTIONS ' + path, handler); return app; },
		publish(topic, message, isBinary = false, _compress = false) {
			let delivered = false;
			for (const ws of connections) {
				if (ws._topics.has(topic)) { ws.send(message, isBinary, false, topic); delivered = true; }
			}
			return delivered;
		},
		numSubscribers(topic) {
			let n = 0;
			for (const ws of connections) if (ws._topics.has(topic)) n++;
			return n;
		},
		listen(...args) {
			// uWS overloads: listen(port, cb) | listen(host, port, cb). The cb gets
			// a truthy listen socket on success.
			const cb = args[args.length - 1];
			listenSocket = { port: boundPort };
			if (typeof cb === 'function') cb(listenSocket);
			return app;
		},
		// sim-only surface:
		connect,
		_connections: connections,
		_listenSocket: () => listenSocket,
		_port: () => boundPort
	};

	return app;
}

/**
 * The minimal uWS helper bundle createTestServer needs besides the app itself
 * (port lookup + listen-socket close). The in-memory variants are trivial.
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
export function createInMemoryUwsHelpers(app) {
	return {
		App: () => app,
		SSLApp: () => app,
		us_socket_local_port: () => app._port(),
		us_listen_socket_close: () => { /* no real socket to close */ },
		SHARED_COMPRESSOR: 1,
		DISABLED: 0
	};
}
