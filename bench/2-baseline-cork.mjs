// Barebones uWS with cork + headers  - simulates writing a real response.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const body = 'Hello World';

uWS.App().any('/*', (res) => {
	res.cork(() => {
		res.writeStatus('200 OK');
		res.writeHeader('content-type', 'text/plain');
		res.writeHeader('content-length', '11');
		res.end(body);
	});
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[baseline-cork] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
