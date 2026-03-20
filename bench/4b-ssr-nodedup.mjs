// SSR baseline: no deduplication. Every concurrent request calls respond() independently.
// Uses a 5ms artificial render delay so concurrent requests pile up.
// Exposes GET /stats to report render call count for benchmarking.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const textDecoder = new TextDecoder();
const origin = `http://localhost:${PORT}`;

let renderCalls = 0;

async function respond(_request) {
	renderCalls++;
	await new Promise((r) => setTimeout(r, 5)); // simulate 5ms render cost
	return new Response('Hello World', {
		status: 200,
		headers: { 'content-type': 'text/plain' },
	});
}

uWS.App().any('/*', (res, req) => {
	const pathname = req.getUrl();

	if (pathname === '/stats') {
		res.cork(() => {
			res.writeStatus('200 OK');
			res.writeHeader('content-type', 'application/json');
			res.end(JSON.stringify({ renderCalls }));
		});
		return;
	}
	if (pathname === '/reset') {
		renderCalls = 0;
		res.cork(() => { res.writeStatus('200 OK').end('ok'); });
		return;
	}

	const method = req.getMethod();
	const query = req.getQuery();
	const METHOD = method.toUpperCase();
	const url = query ? `${pathname}?${query}` : pathname;
	const headers = {};
	req.forEach((key, value) => { headers[key] = value; });
	textDecoder.decode(res.getRemoteAddressAsText());

	const state = { aborted: false };
	res.onAborted(() => { state.aborted = true; });

	(async () => {
		try {
			const request = new Request(origin + url, {
				method: METHOD,
				headers: Object.entries(headers),
				duplex: 'half',
			});
			const response = await respond(request);
			if (state.aborted) return;
			res.cork(() => {
				res.writeStatus(String(response.status));
				res.writeHeader('content-type', 'text/plain');
				res.end('Hello World');
			});
		} catch {
			if (!state.aborted) {
				res.cork(() => { res.writeStatus('500 Internal Server Error').end(); });
			}
		}
	})();
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[ssr-nodedup] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
