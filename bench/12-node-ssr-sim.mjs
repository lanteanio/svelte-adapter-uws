// Simulates adapter-node's SSR path: Node http + Polka + getRequest + setResponse.
// Uses the same trivial handler as bench 4 to isolate framework overhead.
import http from 'node:http';
import polka from 'polka';

const PORT = parseInt(process.env.PORT || '9001');
const origin = 'http://localhost:9001';

// Simulated SvelteKit server.respond -- same trivial handler as bench 4
async function respond(request) {
	return new Response('Hello World', {
		status: 200,
		headers: { 'content-type': 'text/plain' }
	});
}

// Mirrors adapter-node's getRequest() from @sveltejs/kit/node
function getRequest(req) {
	const headers = /** @type {Record<string, string>} */ ({});
	for (let i = 0; i < req.rawHeaders.length; i += 2) {
		const key = req.rawHeaders[i].toLowerCase();
		// Skip HTTP/2 pseudo-headers
		if (key.startsWith(':')) continue;
		const val = req.rawHeaders[i + 1];
		if (key in headers) {
			headers[key] += ', ' + val;
		} else {
			headers[key] = val;
		}
	}

	const controller = new AbortController();
	req.on('error', () => controller.abort());

	return new Request(origin + req.url, {
		method: req.method,
		headers: Object.entries(headers),
		signal: controller.signal,
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
		duplex: 'half'
	});
}

// Mirrors adapter-node's setResponse()
async function setResponse(res, response) {
	const headers = Object.fromEntries(response.headers);
	// Handle Set-Cookie specially (same as adapter-node)
	const setCookie = response.headers.getSetCookie();
	if (setCookie.length) {
		headers['set-cookie'] = setCookie;
	}

	res.writeHead(response.status, headers);

	if (!response.body) {
		res.end();
		return;
	}

	if (response.body.locked) {
		res.end('Fatal error: Response body is locked.');
		return;
	}

	const reader = response.body.getReader();

	if (res.destroyed) {
		reader.cancel();
		return;
	}

	const cancel = (/** @type {Error} */ error) => {
		res.off('close', cancel);
		res.off('error', cancel);
		reader.cancel(error).catch(() => {});
		if (error) res.destroy(error);
	};

	res.on('close', cancel);
	res.on('error', cancel);

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;

		if (!res.write(value)) {
			// Backpressure -- wait for drain
			await new Promise((resolve) => res.once('drain', resolve));
		}
	}

	res.end();
}

const httpServer = http.createServer();
polka({ server: httpServer })
	.all('/*', async (req, res) => {
		try {
			const request = getRequest(req);
			const response = await respond(request);
			await setResponse(res, response);
		} catch (err) {
			console.error('SSR error:', err);
			res.writeHead(500);
			res.end('Internal Server Error');
		}
	})
	.listen(PORT, '0.0.0.0', () => {
		console.log(`[node-ssr-sim] listening on :${PORT}`);
	});
