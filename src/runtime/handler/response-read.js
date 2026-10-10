import { setImmediateTimer } from '../runtime.js';

/**
 * Preserve ready finite bodies without holding output on a later I/O read.
 * The microtask fast path covers an already-fulfilled read. Transform chains
 * may need more microtasks, so unresolved reads get the rest of this turn;
 * the next check phase ends that allowance. The pending read is handed to
 * the streaming owner exactly once, never replaced by another reader.read().
 * @param {ReadableStreamDefaultReader<unknown>} reader
 * @param {{ spent: boolean }} [allowance] one allowance for a buffered prefix
 */
export async function readReady(reader, allowance) {
	let settled = false;
	let failed = false;
	let result;
	let failure;
	const pending = reader.read();
	pending.then(value => { result = value; settled = true; }, error => { failure = error; failed = true; settled = true; });
	await Promise.resolve();
	if (!settled && !allowance?.spent) {
		if (allowance) allowance.spent = true;
		await new Promise(resolve => setImmediateTimer(resolve));
	}
	if (failed) throw failure;
	return settled ? result : { pending };
}
