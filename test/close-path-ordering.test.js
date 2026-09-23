// A closing connection leaves the live set before anything else is released.
//
// The close callback's `finally` runs a sequence of releases - the admission
// permit, the logical subscription accounting, the capability counts, the wire
// states, the shared wire-id refs, the send-gate slot. None of them is wrapped
// individually, so one throw anywhere in that sequence skips whatever follows
// it. While the removal from `wsConnections` sat at the END, "whatever follows"
// included the removal.
//
// A stranded connection is not a leak that sits still. Every publish walk keeps
// visiting a socket whose native handle is gone, and its subscription registry
// keeps contributing to the consistency auditor's summed bookkeeping while the
// cap accountant has already released those memberships - which surfaces as a
// subscription-ledger mismatch that no double charge explains, permanently,
// because nothing ever removes the entry.
//
// The production module cannot be imported here: it is built with
// rollup-injected globals, so importing it fails on a `SHIMS` specifier. The
// ordering is therefore pinned against the source, the way this repository pins
// every other guard in that module - as a statement that must be its own line,
// so wrapping or neutralizing it fails rather than matching as a substring.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expectStatement } from './helpers/source-pins.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const handler = readFileSync(path.join(ROOT, 'src/runtime/handler.js'), 'utf8');

/**
 * The close callback's `finally` block: from the `} finally {` that follows the
 * app close hook to the end of that block.
 */
function closeFinally() {
	const hookCall = handler.indexOf("if (userData[WS_SESSION_ID] !== undefined) runCloseHook(wsModule, ws, ctx);");
	expect(hookCall, 'the app close-hook call moved; this slice is anchored on it').toBeGreaterThan(-1);
	const start = handler.indexOf('} finally {', hookCall);
	expect(start, 'no finally follows the close hook').toBeGreaterThan(hookCall);
	const end = handler.indexOf("\n\t\t\t}", start);
	expect(end, 'the finally block does not close').toBeGreaterThan(start);
	return handler.slice(start, end);
}

describe('the close path leaves the live set before it releases anything else', () => {
	it('removes the connection as its own statement', () => {
		expectStatement(closeFinally(), 'wsConnections.delete(ws);', 'the close path removes the connection');
	});

	it('removes it before every release that could throw first', () => {
		// The point of the ordering, and the only thing that makes the removal
		// unskippable: each of these is unguarded, and each used to sit ahead of
		// the removal.
		const slice = closeFinally();
		const removal = slice.indexOf('wsConnections.delete(ws);');
		for (const release of [
			'admission.releaseConnection();',
			'accountClosedLogicalSubscriptions(subscriptions);',
			'capCounts.adjust(userData[WS_CAPS], null);',
			'detachWireStates(ws, userData);'
		]) {
			const at = slice.indexOf(release);
			expect(at, `${release} is no longer in the close finally`).toBeGreaterThan(-1);
			expect(removal, `${release} runs before the connection leaves the live set`).toBeLessThan(at);
		}
	});

	it('removes it exactly once', () => {
		// Two removals would read as belt-and-braces and would hide a later edit
		// that moved the real one back down.
		const slice = closeFinally();
		const count = slice.split('wsConnections.delete(ws)').length - 1;
		expect(count).toBe(1);
	});
});
