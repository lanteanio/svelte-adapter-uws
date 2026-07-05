// A complete Core-class client for the Lantean protocol (see ../PROTOCOL.md,
// section 13: Conformance classes). Dependency-free: connect, subscribe,
// dispatch data events, and resume-on-subscribe across reconnects - the whole
// Core class, and proof that a JSON-only client is a complete, correct client.
//
// Usage:
//   import { createLanteanClient } from './minimal-client.mjs';
//   const client = createLanteanClient('ws://localhost:3000/', {
//     onEvent: (topic, event, data) => console.log(topic, event, data),
//   });
//   client.subscribe('chat');
//
// In a browser, globalThis.WebSocket is used automatically. In Node, pass a
// WebSocket implementation: createLanteanClient(url, { WebSocket, onEvent }).

export function createLanteanClient(url, { WebSocket = globalThis.WebSocket, onEvent = () => {} } = {}) {
	const topics = new Map(); // topic -> { lastSeq, epoch }
	let ws, sessionId, ref = 0;

	function sendSubscribe(topic) {
		const t = topics.get(topic);
		const frame = { type: 'subscribe', topic, ref: ++ref }; // compact, "type" first (section 1.1)
		if (t.lastSeq >= 0) {
			frame.recover = { offset: t.lastSeq };              // resume-on-subscribe (section 7)
			if (t.epoch != null) frame.recover.epoch = t.epoch;
		}
		ws.send(JSON.stringify(frame));
	}

	function connect() {
		ws = new WebSocket(url);
		ws.onmessage = (e) => {
			if (typeof e.data !== 'string') return;             // Core is JSON-only; ignore binary
			let msg;
			try { msg = JSON.parse(e.data); } catch { return; }
			if (msg.topic && msg.event !== undefined) {         // data-event envelope (section 4)
				const t = topics.get(msg.topic);
				if (t && typeof msg.seq === 'number') t.lastSeq = msg.seq;
				onEvent(msg.topic, msg.event, msg.data);
				return;
			}
			if (msg.type === 'welcome') {                       // (re)subscribe with recovery
				sessionId = msg.sessionId;
				for (const topic of topics.keys()) sendSubscribe(topic);
				return;
			}
			if (msg.type === 'subscribed' && typeof msg.epoch === 'number') {
				const t = topics.get(msg.topic);
				if (t) t.epoch = msg.epoch;                     // track the epoch to report on resume
			}
			// Every other control frame (subscribe-denied, error, lease, ...) is
			// ignored by a Core client (section 1.4).
		};
		ws.onclose = () => setTimeout(connect, 500);            // reconnect; welcome triggers resume
	}

	connect();
	return {
		get sessionId() { return sessionId; },
		subscribe(topic) {
			if (!topics.has(topic)) topics.set(topic, { lastSeq: -1, epoch: null });
			if (ws.readyState === 1) sendSubscribe(topic);
		},
	};
}
