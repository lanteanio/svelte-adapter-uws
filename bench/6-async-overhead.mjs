// Measures the pure async overhead: onAborted + AbortController + promise-based
// response flow, but with NO Request construction and NO header collection.
// Compares against baseline-cork to isolate async scheduling cost.
import uWS from 'uWebSockets.js';

const PORT = parseInt(process.env.PORT || '9001');
const body = Buffer.from('Hello World');

uWS.App().any('/*', (res) => {
	const state = { aborted: false };
	const abortController = new AbortController();
	res.onAborted(() => { state.aborted = true; abortController.abort(); });

	// Simulate the async path with a resolved promise (microtask)
	Promise.resolve().then(() => {
		if (state.aborted) return;
		res.cork(() => {
			res.writeStatus('200 OK');
			res.writeHeader('content-type', 'text/plain');
			res.writeHeader('content-length', '11');
			res.end(body);
		});
	});
}).listen('0.0.0.0', PORT, (sock) => {
	if (sock) console.log(`[async-overhead] listening on :${PORT}`);
	else { console.error('failed'); process.exit(1); }
});
