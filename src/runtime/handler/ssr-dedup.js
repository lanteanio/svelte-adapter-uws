/**
 * Whether an SSR response may be buffered whole for cross-waiter dedup.
 *
 * The one response that must never be buffered is a Server-Sent-Events stream
 * (`text/event-stream`): it never ends, so `arrayBuffer()` on it would await
 * forever - parking the leader and every concurrent anonymous waiter on the
 * same in-flight promise until the connection drops. Those must stream.
 *
 * Everything else is a finite render we buffer and share. Note we deliberately
 * do NOT require a `content-length`: SvelteKit's dynamically-rendered pages
 * carry none, so gating on that header would silently disable dedup for the
 * exact thundering-herd workload it exists to protect. The never-ending
 * content-type is the only reliable signal, and `writeResponse` already
 * chunk-streams the excluded case without buffering it.
 *
 * Kept in its own dependency-free module so it is unit-testable without pulling
 * in the build-time runtime init chain that `ssr.js` depends on.
 *
 * @param {Response} response
 * @returns {boolean}
 */
export function isDedupBufferable(response) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	return !contentType.startsWith('text/event-stream');
}

/**
 * Whether a response's declared length already rules sharing out, so the
 * leader can go straight to streaming without reading a byte. `null` means
 * the length is unknown or within the cap and the body has to be read to
 * decide.
 *
 * @param {Response} response
 * @param {number} cap
 * @returns {boolean}
 */
export function declaresBodyPastCap(response, cap) {
	const declared = response.headers.get('content-length');
	if (declared === null) return false;
	const length = Number(declared);
	return Number.isFinite(length) && length > cap;
}

/**
 * Read a body until it ends or its bytes pass `cap`, whichever comes first.
 *
 * The cap is a ceiling on what is HELD, not a check made after the whole
 * body has been materialised: a leader that reads a response to its end and
 * only then asks whether it was small enough has already spent the memory
 * the cap exists to bound - once per concurrent request, for as large a body
 * as the route serves. So the read stops the moment the bytes read pass the
 * cap, and what was read is handed back as a stream that replays those
 * chunks and then continues from the reader, so the leader streams the body
 * it decided not to share without re-rendering or losing a byte.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {number} cap
 * @returns {Promise<{ complete: true, bytes: Uint8Array } | { complete: false, stream: ReadableStream<Uint8Array> }>}
 */
export async function readBodyUpTo(body, cap) {
	const reader = body.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			reader.releaseLock();
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			return { complete: true, bytes };
		}
		chunks.push(value);
		total += value.byteLength;
		if (total > cap) break;
	}
	// Past the cap: replay what is held, then continue from the source. The
	// held chunks are released as they are replayed, so the prefix is not
	// kept for the life of the stream.
	let replay = 0;
	const stream = new ReadableStream({
		async pull(controller) {
			if (replay < chunks.length) {
				const chunk = chunks[replay];
				chunks[replay] = /** @type {any} */ (null);
				replay += 1;
				controller.enqueue(chunk);
				return;
			}
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { complete: false, stream };
}
