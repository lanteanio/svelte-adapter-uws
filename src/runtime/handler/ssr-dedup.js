import { responseChunkBytes } from './response-body.js';
import { readReady } from './response-read.js';

/**
 * Whether an SSR response may be buffered whole for cross-waiter dedup.
 *
 * The one response that must never be buffered is a Server-Sent-Events stream
 * (`text/event-stream`): it never ends, so `arrayBuffer()` on it would await
 * forever - parking the leader and every concurrent anonymous waiter on the
 * same in-flight promise until the connection drops. Those must stream.
 *
 * Other bodies may be shared if they finish without a pending I/O read and
 * remain within the byte cap. A deferred body falls back to streaming even
 * without a content-length; ready dynamic pages still share their render.
 *
 * Kept separate so it is unit-testable without pulling
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
 * Read a body until it ends, passes `cap`, or a subsequent read needs I/O.
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
 * @param {ReadableStream<unknown>} body
 * @param {number} cap
 * @param {{ cancelResponse?: (() => void) | null }} [state]
 * @returns {Promise<{ complete: true, bytes: Uint8Array } | { complete: false, stream: ReadableStream<Uint8Array> }>}
 */
export async function readBodyUpTo(body, cap, state) {
	const reader = body.getReader();
	const cancel = () => { reader.cancel().catch(() => {}); };
	if (state) state.cancelResponse = cancel;
	/** @type {Uint8Array[]} */
	const chunks = [];
	let total = 0;
	let pending;
	const allowance = { spent: false };
	try {
		for (;;) {
			const next = chunks.length ? await readReady(reader, allowance) : await reader.read();
			if (next.pending) { pending = next.pending; break; }
			const { done, value } = next;
			if (done) {
				reader.releaseLock();
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
				return { complete: true, bytes };
			}
			const bytes = responseChunkBytes(value);
			chunks.push(bytes);
			total += bytes.byteLength;
			if (total > cap) break;
		}
	} catch (error) {
		reader.cancel(error).catch(() => {});
		reader.releaseLock();
		throw error;
	} finally {
		if (state?.cancelResponse === cancel) state.cancelResponse = null;
	}
	// Replay the held prefix, then consume the exact read that was pending
	// when buffering stopped. The wrapper's owner now owns cancellation too.
	let replay = 0;
	let released = false;
	const release = () => { if (!released) { released = true; reader.releaseLock(); } };
	const stream = new ReadableStream({
		async pull(controller) {
			if (replay < chunks.length) {
				const chunk = chunks[replay];
				chunks[replay++] = /** @type {any} */ (null);
				controller.enqueue(chunk);
				return;
			}
			try {
				const next = pending || reader.read();
				pending = null;
				const { done, value } = await next;
				if (released) return;
				if (done) { release(); controller.close(); }
				else controller.enqueue(responseChunkBytes(value));
			} catch (error) {
				if (released) return;
				reader.cancel(error).catch(() => {});
				release();
				throw error;
			}
		},
		cancel(reason) {
			chunks.length = 0;
			const cancelled = reader.cancel(reason);
			release();
			return cancelled;
		}
	});
	return { complete: false, stream };
}
