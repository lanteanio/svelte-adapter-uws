// Isolates the cost of Request construction + header collection.
// Responds synchronously with res.end() after doing the same work as the adapter's
// synchronous phase + Request construction, but skips the async writeResponse.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const textDecoder = new TextDecoder();
const origin = 'http://localhost:9001';

uWS.App().any('/*', (res, req) => {
	// Synchronous phase — exactly like the adapter
	const method = req.getMethod();
	const pathname = req.getUrl();
	const query = req.getQuery();
	const METHOD = method.toUpperCase();
	const url = query ? `${pathname}?${query}` : pathname;

	// Full header collection
	const headers = {};
	req.forEach((key, value) => { headers[key] = value; });
	const remoteAddress = textDecoder.decode(res.getRemoteAddressAsText());

	// Construct Request (the expensive part we want to measure)
	const request = new Request(origin + url, {
		method: METHOD,
		headers: Object.entries(headers),
		duplex: 'half'
	});

	// Respond immediately — isolates construction cost from async overhead
	res.cork(() => {
		res.writeStatus('200 OK');
		res.writeHeader('content-type', 'text/plain');
		res.end('Hello World');
	});
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[request-only] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
