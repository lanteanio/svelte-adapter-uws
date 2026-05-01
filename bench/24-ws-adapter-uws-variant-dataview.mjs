// Variant of 24-ws-adapter-uws.mjs for A/B-benching the per-message
// byte-prefix gate. The ONLY difference vs the baseline is the read of
// byte 3 of an incoming text frame:
//
//   baseline: (new Uint8Array(message))[3]  (allocates a typed-array view)
//   variant : new DataView(message).getUint8(3)  (allocates a DataView)
//
// Both forms read the same byte from the same ArrayBuffer; the question
// is whether DataView's allocation + method dispatch is lighter than the
// typed-array view + indexed read on this hot path.
//
// Run via bench/run-ws-ab.mjs (alternates server processes between
// baseline and variant, drives the same client load against each).
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9002');

const app = uWS.App();
const wsConnections = new Set();

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

function publish(topic, event, data) {
	const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
	app.publish(topic, envelope, false, false);
}

app.ws('/*', {
	upgrade: (res, req, context) => {
		const secKey = req.getHeader('sec-websocket-key');
		const secProtocol = req.getHeader('sec-websocket-protocol');
		const secExtensions = req.getHeader('sec-websocket-extensions');
		const headers = {};
		req.forEach((key, value) => { headers[key] = value; });
		res.cork(() => {
			res.upgrade({}, secKey, secProtocol, secExtensions, context);
		});
	},

	open: (ws) => {
		wsConnections.add(ws);
	},

	message: (ws, message, isBinary) => {
		// VARIANT: DataView for byte-3 read instead of Uint8Array view.
		if (!isBinary && message.byteLength < 512 &&
			new DataView(message).getUint8(3) === 0x79 /* 'y' in {"type" */) {
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
	if (sock) console.log(`[ws-adapter-uws-variant-dataview] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
