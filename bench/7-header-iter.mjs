// Measures the cost of req.forEach header collection + remoteAddress decode.
// Compares against baseline-cork to isolate header collection overhead.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const textDecoder = new TextDecoder();

uWS.App().any('/*', (res, req) => {
	// Collect all headers (same as adapter)
	const headers = {};
	req.forEach((key, value) => { headers[key] = value; });
	const remoteAddress = textDecoder.decode(res.getRemoteAddressAsText());

	res.cork(() => {
		res.writeStatus('200 OK');
		res.writeHeader('content-type', 'text/plain');
		res.writeHeader('content-length', '11');
		res.end('Hello World');
	});
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[header-iter] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
