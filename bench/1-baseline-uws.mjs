// Barebones uWS — absolute minimum: just respond with a fixed string.
// This is the theoretical ceiling for uWS performance.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const body = 'Hello World';

uWS.App().any('/*', (res) => {
	res.end(body);
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[baseline] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
