// WebSocket benchmark: socket.io (the standard adapter-node companion).
// Same semantics: N clients, pub/sub to a room, echo + broadcast.
import http from 'node:http';
import { Server } from 'socket.io';

const PORT = parseInt(process.env.PORT || '9002');

const httpServer = http.createServer();
const io = new Server(httpServer, {
	// Optimize for throughput -- disable polling transport
	transports: ['websocket'],
	// Disable per-message compression for fair comparison (uWS bench has none)
	perMessageDeflate: false,
});

io.on('connection', (socket) => {
	socket.join('bench');

	socket.on('message', (data) => {
		// Broadcast to all in room (including sender, like uWS publish)
		io.to('bench').emit('message', data);
	});
});

httpServer.listen(PORT, '0.0.0.0', () => {
	console.log(`[ws-socketio] listening on :${PORT}`);
});
