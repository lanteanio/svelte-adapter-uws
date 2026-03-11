// Simulates the adapter's SSR hot path: full header collection, Request
// construction, async response, writeResponse  - but with a trivial handler
// instead of SvelteKit, so we isolate the adapter overhead only.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const textDecoder = new TextDecoder();
const origin = 'http://localhost:9001';

// Simulated SvelteKit server.respond  - returns a trivial Response
async function respond(request) {
	return new Response('Hello World', {
		status: 200,
		headers: { 'content-type': 'text/plain' }
	});
}

function writeHeaders(res, response) {
	res.writeStatus(String(response.status));
	for (const [key, value] of response.headers) {
		if (key === 'set-cookie') continue;
		res.writeHeader(key, value);
	}
	for (const cookie of response.headers.getSetCookie()) {
		res.writeHeader('set-cookie', cookie);
	}
}

async function writeResponse(res, response, state) {
	if (!response.body) {
		if (state.aborted) return;
		res.cork(() => { writeHeaders(res, response); res.end(); });
		return;
	}

	const reader = response.body.getReader();
	let streaming = false;
	try {
		const first = await reader.read();
		if (first.done || state.aborted) {
			if (!state.aborted) res.cork(() => { writeHeaders(res, response); res.end(); });
			return;
		}
		const second = await reader.read();
		if (second.done || state.aborted) {
			if (!state.aborted) {
				res.cork(() => { writeHeaders(res, response); res.end(first.value); });
			}
			return;
		}
		// Multi-chunk streaming
		if (state.aborted) return;
		streaming = true;
		res.cork(() => {
			writeHeaders(res, response);
			res.write(first.value);
			res.write(second.value);
		});
		for (;;) {
			const { done, value } = await reader.read();
			if (done || state.aborted) break;
			const ok = res.write(value);
			if (!ok) {
				await new Promise((resolve) =>
					res.onWritable(() => { resolve(undefined); return true; })
				);
				if (state.aborted) break;
			}
		}
	} finally {
		if (streaming && !state.aborted) res.cork(() => res.end());
		reader.cancel().catch(() => {});
	}
}

uWS.App().any('/*', (res, req) => {
	// Synchronous phase  - mirror exactly what the adapter does
	const method = req.getMethod();
	const pathname = req.getUrl();
	const query = req.getQuery();
	const METHOD = method.toUpperCase();
	const url = query ? `${pathname}?${query}` : pathname;

	// Full header collection
	const headers = {};
	req.forEach((key, value) => { headers[key] = value; });

	const remoteAddress = textDecoder.decode(res.getRemoteAddressAsText());

	const abortController = new AbortController();
	const state = { aborted: false };
	res.onAborted(() => { state.aborted = true; abortController.abort(); });

	// Async phase  - Request construction + respond + writeResponse
	(async () => {
		try {
			const request = new Request(origin + url, {
				method: METHOD,
				headers: Object.entries(headers),
				duplex: 'half'
			});

			const response = await respond(request);
			if (state.aborted) return;
			await writeResponse(res, response, state);
		} catch (err) {
			if (state.aborted) return;
			console.error('SSR error:', err);
			res.cork(() => {
				res.writeStatus('500 Internal Server Error');
				res.end('Internal Server Error');
			});
		}
	})();
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[ssr-sim] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
