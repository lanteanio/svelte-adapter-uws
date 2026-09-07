// The one way a server-generated frame reaches a client OUTSIDE a publish.
//
// Everything sent here shares a property that ordinary fan-out does not have:
// the client asked for it. A subscribe buys an ack, a bad frame buys a refusal,
// an oversized batch buys a denial per topic past the cap. That makes the whole
// channel an AMPLIFIER - a few inbound bytes name a topic and are answered with
// a whole frame - so it is bounded per connection, in bytes over time, and a
// connection that blows the bound is cut rather than served.
//
// MEASURED, on this runtime, at the worst legal shape: one 8,121-byte
// `subscribe-batch` carrying 1,344 shortest-legal topics is answered with
// 97,484 bytes across 1,345 frames. Twelve times what it cost to ask, and
// repeatable - the frame is legal, so nothing refuses the next one.
//
// WHY THE EXISTING DEFENCES MISS IT. The control-frame limit (wire.js,
// 8 KiB) bounds one frame, which bounds the frame COUNT per inbound frame but
// not the rate. Inbound message admission would bound the rate, but every one
// of its limits is zero-by-default, so out of the box there is none. The
// publish-egress ceilings bound application publishes and never see an ack.
// And `maxBackpressure` bounds the queue in MEMORY, which is why this is a CPU
// and bandwidth problem rather than an out-of-memory one.
//
// WHY NOT SHED INSTEAD OF CUT. An ack the client never receives is a
// subscription it believes did not take - the exact failure the loud per-topic
// denial exists to prevent. Dropping acks silently would trade an amplifier for
// a correctness bug, so a connection over its budget is told and closed.

import { counters } from './state.js';
import { monotonicNow } from '../runtime.js';
import { createByteBudget, controlFrameBytes, MAX_CONTROL_EGRESS_BYTES, CONTROL_EGRESS_WINDOW_MS, CONTROL_FLOOD_CLOSE_CODE } from '../utils/byte-budget.js';
import { WS_CONTROL_BUDGET, WS_PLATFORM } from '../utils/ws-symbols.js';
import { bumpOut } from './pressure-metrics.js';
import { emitOperationalEvent } from '../diagnostic.js';

/**
 * Charge control-frame bytes to a connection's budget.
 *
 * The window arithmetic is pure (utils/byte-budget.js); this owns only the
 * per-connection slot, which is declared at open with every other slot.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {number} bytes
 * @returns {boolean} false when this connection has exhausted its window
 */
export function chargeControlEgress(ws, bytes) {
	let userData;
	try { userData = ws.getUserData(); }
	catch {
		// No connection left to charge; the caller's own send fails anyway.
		return true;
	}
	let budget = userData[WS_CONTROL_BUDGET];
	// A null slot is the cut signal, not an empty one: this connection has
	// already blown its budget and been told so. Refusing here rather than
	// building a fresh budget is what stops the window from resetting under a
	// connection that is on its way out.
	if (budget === null) return false;
	if (budget === undefined) {
		budget = createByteBudget(MAX_CONTROL_EGRESS_BYTES, CONTROL_EGRESS_WINDOW_MS, monotonicNow);
		userData[WS_CONTROL_BUDGET] = budget;
	}
	return budget(bytes);
}

/** The control frame reached the socket - written, or queued behind backpressure. */
export const CONTROL_DELIVERED = 0;

/** The socket refused it past its backpressure limit; the connection is still open. */
export const CONTROL_REFUSED = 1;

/** There is no connection left to answer, or it was just cut. Nothing more may be sent on it. */
export const CONTROL_GONE = 2;

/**
 * Send a control frame against this connection's budget.
 *
 * Control frames are never compressed: they are short, and deflating them costs
 * more than it saves.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {string} payload
 * @returns {0 | 1 | 2} CONTROL_DELIVERED, CONTROL_REFUSED or CONTROL_GONE
 */
export function sendControl(ws, payload) {
	if (!chargeControlEgress(ws, controlFrameBytes(payload))) {
		refuseControlFlood(ws);
		return CONTROL_GONE;
	}
	let result;
	try { result = ws.send(payload, false, false); }
	catch {
		counters.closedWsAborts++;
		return CONTROL_GONE;
	}
	// Only bytes that reached the wire are counted out, matching platform.send:
	// a frame refused past the backpressure limit never went anywhere.
	if (result === 2) return CONTROL_REFUSED;
	bumpOut(ws, payload);
	return CONTROL_DELIVERED;
}

/**
 * Cut a connection that has blown its control-frame budget.
 *
 * NOTHING IS WRITTEN TO THE WIRE except the close. The protocol is frozen at
 * revision 1, and an explanatory `error` frame would mean a new `code` value
 * and a field the documented error shape does not carry - a wire change, not an
 * additive one. It is not needed either: 4429 is already the bundled client's
 * THROTTLE class, so the client reconnects on the accelerated curve without
 * being told anything more, and the party who needs the detail is the operator,
 * who gets it on the diagnostic channel with a cause and a next action.
 *
 * Guarded, because several senders can discover the same exhausted budget
 * inside one batch and the second must not close a closing connection or report
 * a second time.
 *
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 */
function refuseControlFlood(ws) {
	try {
		const userData = ws.getUserData();
		if (userData[WS_CONTROL_BUDGET] === null) return;
		// The slot doubles as the signal: a null budget means this connection has
		// already been cut, and nothing further is charged to it.
		userData[WS_CONTROL_BUDGET] = null;
		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.control-egress',
			event: 'control-egress.exhausted',
			severity: 'warn',
			dataClass: 'pseudonymous',
			message: 'A connection exhausted its control-frame egress budget and was closed.',
			// The connection's upgrade request id is what an operator joins against
			// the access log to find the client; the event is pseudonymous because
			// that id is on it, and useless without it.
			attributes: { requestId: userData[WS_PLATFORM]?.requestId ?? null, limit: MAX_CONTROL_EGRESS_BYTES, windowMs: CONTROL_EGRESS_WINDOW_MS }
		});
		ws.end(CONTROL_FLOOD_CLOSE_CODE, 'control frame budget exhausted');
	} catch {
		counters.closedWsAborts++;
	}
}
