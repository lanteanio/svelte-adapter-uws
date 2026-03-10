// WebSocket benchmark: adapter WS handler BEFORE optimization.
// Used to measure the improvement from byte-prefix + template optimizations.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9002');

const app = uWS.App();
const wsConnections = new Set();

// OLD: JSON.stringify wrapper object
function publish(topic, event, data) {
	const envelope = JSON.stringify({ topic, event, data });
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
		// OLD: always JSON.parse for sub/unsub check
		if (!isBinary && message.byteLength < 512) {
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
			} catch {}
		}
		try {
			const parsed = JSON.parse(Buffer.from(message).toString());
			if (parsed.topic) {
				publish(parsed.topic, parsed.event, parsed.data);
			}
		} catch {}
	},

	close: (ws) => {
		wsConnections.delete(ws);
	}
});

app.listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[ws-adapter-uws-old] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
