// WebSocket benchmark: ws library (lightweight, most popular raw WS library).
// Same semantics: N clients, manual pub/sub broadcast.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '9002');

const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
	ws.on('message', (data) => {
		// Broadcast to ALL connected clients (simulates pub/sub to one topic)
		for (const client of wss.clients) {
			if (client.readyState === 1) {
				client.send(data);
			}
		}
	});
});

httpServer.listen(PORT, '0.0.0.0', () => {
	console.log(`[ws-ws] listening on :${PORT}`);
});
