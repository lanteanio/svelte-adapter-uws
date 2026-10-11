import { clearImmediateTimer, setImmediateTimer } from '../runtime.js';

/**
 * @typedef {{ spent: boolean, turn?: Promise<void>, timer?: any }} ReadAllowance
 */

/** Stop the one check-phase deadline when its buffered prefix is released. */
export function releaseReadAllowance(allowance) {
	if (allowance.timer !== undefined) clearImmediateTimer(allowance.timer);
	allowance.timer = undefined;
	allowance.turn = undefined;
	allowance.spent = true;
}

/**
 * Preserve ready finite bodies without holding output on a later I/O read.
 * The microtask fast path covers an already-fulfilled read. Later settlement
 * races one shared check-phase deadline for the whole buffered prefix, so a
 * chain of ready transforms can finish in this turn without renewing it.
 * The pending read is handed to the streaming owner exactly once.
 * @param {ReadableStreamDefaultReader<unknown>} reader
 * @param {ReadAllowance} [allowance]
 */
export async function readReady(reader, allowance) {
	let settled = false;
	let failed = false;
	let result;
	let failure;
	let owned = false;
	const pending = reader.read();
	pending.then(value => { result = value; settled = true; }, error => { failure = error; failed = true; settled = true; });
	try {
		await Promise.resolve();
		if (!settled && !allowance?.spent) {
			if (!allowance) { allowance = { spent: false }; owned = true; }
			const budget = allowance;
			budget.turn ??= new Promise(resolve => {
				budget.timer = setImmediateTimer(() => {
					budget.timer = undefined;
					budget.spent = true;
					resolve();
				});
			});
			await Promise.race([pending, budget.turn]);
		}
		if (failed) throw failure;
		return settled ? result : { pending };
	} finally {
		if (owned) releaseReadAllowance(allowance);
	}
}
