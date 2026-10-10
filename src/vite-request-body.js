import { PayloadTooLargeError } from './runtime/handler/http-helpers.js';

/**
 * Node owns these chunks beyond its callback, so the Request can consume them
 * directly. Pause between reads; an ignored body must not delay the hook.
 *
 * @param {import('node:http').IncomingMessage | import('node:http2').Http2ServerRequest} req
 * @param {number} limit
 */
export function authRequestBody(req, limit) {
	/** @type {ReadableStreamDefaultController<Uint8Array>} */
	let controller;
	let ended = false;
	let total = 0;
	/** @type {PayloadTooLargeError | undefined} */
	let tooLargeError;
	const detach = () => {
		req.off('data', onData);
		req.off('end', onEnd);
		req.off('aborted', onAborted);
		req.off('error', onError);
	};
	/** @param {Error} [error] */
	const finish = (error) => {
		if (ended) return;
		ended = true;
		detach();
		if (error) controller.error(error);
		else controller.close();
	};
	const onEnd = () => finish();
	const onAborted = () => finish(new Error('Request aborted'));
	/** @param {Error} error */
	const onError = (error) => finish(error);
	/** @param {Buffer} chunk */
	const onData = (chunk) => {
		total += chunk.byteLength;
		if (total > limit) {
			tooLargeError = new PayloadTooLargeError();
			finish(tooLargeError);
			req.resume();
			return;
		}
		controller.enqueue(chunk);
		if ((controller.desiredSize ?? 0) <= 0) req.pause();
	};
	const discard = () => {
		finish();
		// Drain without retaining bytes so an HTTP/2 peer can finish its request
		// after an early answer. Destroying the request would cut that answer off.
		req.resume();
	};
	const body = new ReadableStream({
		start(value) {
			controller = value;
			req.pause();
			req.on('data', onData);
			req.once('end', onEnd);
			req.once('aborted', onAborted);
			req.once('error', onError);
			if (req.aborted) onAborted();
			else if (req.readableEnded) onEnd();
		},
		pull() { if (!ended) req.resume(); },
		cancel() {
			if (!ended) { ended = true; detach(); }
			req.resume();
		}
	}, { highWaterMark: 0 });
	return {
		body,
		discard,
		/** @param {unknown} error */
		isTooLargeError(error) { return tooLargeError !== undefined && error === tooLargeError; }
	};
}
