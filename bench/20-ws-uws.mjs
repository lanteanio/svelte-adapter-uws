// WebSocket benchmark: uWS native pub/sub.
// Measures message throughput with N connected clients subscribing to a topic.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9002');

const app = uWS.App();

app.ws('/*', {
	open: (ws) => {
		ws.subscribe('bench');
	},
	message: (ws, message, isBinary) => {
		// Echo back to sender + broadcast to topic
		app.publish('bench', message, isBinary, false);
	},
	close: () => {}
});

app.listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[ws-uws] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
