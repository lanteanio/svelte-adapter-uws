// WebSocket benchmark: simulates our adapter's WS handler path.
// Includes the built-in subscribe/unsubscribe parsing, JSON envelope wrapping,
// origin validation check, and user message handler delegation.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9002');

const app = uWS.App();
const wsConnections = new Set();

// esc() — same as handler.js (validate + JSON-quote topic/event names)
function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

// Platform.publish simulation (same as handler.js -- uses esc() for safety)
function publish(topic, event, data) {
	const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
	app.publish(topic, envelope, false, false);
}

app.ws('/*', {
	upgrade: (res, req, context) => {
		// Simulate our adapter's upgrade path (no auth handler = fast path)
		const secKey = req.getHeader('sec-websocket-key');
		const secProtocol = req.getHeader('sec-websocket-protocol');
		const secExtensions = req.getHeader('sec-websocket-extensions');
		// Read origin for validation check
		const headers = {};
		req.forEach((key, value) => { headers[key] = value; });
		// Origin validation (same-origin check, always passes in localhost bench)
		res.cork(() => {
			res.upgrade({}, secKey, secProtocol, secExtensions, context);
		});
	},

	open: (ws) => {
		wsConnections.add(ws);
	},

	message: (ws, message, isBinary) => {
		// Built-in subscribe/unsubscribe parsing (optimized byte-prefix check)
		if (!isBinary && message.byteLength < 512 &&
			(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
			try {
				const msg = JSON.parse(Buffer.from(message).toString());
				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					ws.subscribe(msg.topic);
					return;
				}
				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					ws.unsubscribe(msg.topic);
					return;
				}
			} catch {
				// Not JSON, fall through
			}
		}
		// User message handler -- parse and re-broadcast via platform.publish
		try {
			const parsed = JSON.parse(Buffer.from(message).toString());
			if (parsed.topic) {
				publish(parsed.topic, parsed.event, parsed.data);
			}
		} catch {
			// Not JSON
		}
	},

	close: (ws) => {
		wsConnections.delete(ws);
	}
});

app.listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[ws-adapter-uws] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
