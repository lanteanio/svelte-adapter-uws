// Simulates the adapter's static file fast path:
// Map lookup + accept-encoding + if-none-match header reads + cork + headers
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');

// Pre-build a static cache entry like the adapter does
const buffer = Buffer.from('<html><body>Hello World</body></html>');
const staticCache = new Map();
for (let i = 0; i < 100; i++) {
	staticCache.set(`/assets/file${i}.html`, {
		buffer,
		contentType: 'text/html',
		etag: `W/"abc123def456"`,
		headers: [['cache-control', 'no-cache'], ['etag', 'W/"abc123def456"']],
	});
}
// The path that will be benchmarked
staticCache.set('/index.html', {
	buffer,
	contentType: 'text/html',
	etag: `W/"abc123def456"`,
	headers: [['cache-control', 'no-cache'], ['etag', 'W/"abc123def456"']],
});

uWS.App().any('/*', (res, req) => {
	const pathname = req.getUrl();
	const entry = staticCache.get(pathname);
	if (entry) {
		const acceptEncoding = req.getHeader('accept-encoding');
		const ifNoneMatch = req.getHeader('if-none-match');

		if (entry.etag && ifNoneMatch === entry.etag) {
			res.cork(() => { res.writeStatus('304 Not Modified').end(); });
			return;
		}

		res.cork(() => {
			let body = entry.buffer;
			// Simulate precompress check (no-op here, but same branching)
			res.writeStatus('200 OK');
			res.writeHeader('content-type', entry.contentType);
			res.writeHeader('content-length', String(body.byteLength));
			for (let i = 0; i < entry.headers.length; i++) {
				res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
			}
			res.end(body);
		});
		return;
	}
	res.cork(() => { res.writeStatus('404 Not Found').end('Not Found'); });
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[static-sim] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
