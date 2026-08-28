// Presence wired the documented way, with the periodic full-roster heartbeat OFF.
//
// The heartbeat is what REPAIRS a dropped diff: it rebroadcasts the whole roster
// on an interval, so a delivery suite running against the default 30 s heartbeat
// can pass on the repair rather than on the frame it meant to assert. With it
// off, every roster change reaches a peer as exactly one diff or not at all,
// which is the property nothing else in the suite can see - presence publishes
// `{ seq: false }`, so a dropped diff carries no sequence gap, no retry and no
// detection of any kind.
//
// The constructor warns once per process that `heartbeat: 0` is half an opt-out
// whose other half is the client's `maxAge`. That warning is expected here and
// does not apply: these connections live for the length of one case, far inside
// any sweep window, and the suite asserts frames as they arrive rather than
// reading a decayed roster.
import { createPresence } from 'svelte-adapter-uws/plugins/presence';
import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

// Both lanes on one server, the way an app installs them. They share the
// fan-out path, and neither had an end-to-end case; wiring them together also
// puts the cursor hook in front of every frame, which is where it sits in
// production.
//
// Cursor keeps its SHIPPED coalescing (topicThrottle 16, i.e. a 60 Hz tick).
// Intermediate positions are meant to collapse, so the suite asserts where the
// lane CONVERGES rather than counting frames - the opposite of presence, whose
// diffs promise delivery and are asserted one by one.
const cursors = createCursor({
	select: (userData) => ({ name: userData.token || 'anon' })
});

const presence = createPresence({
	heartbeat: 0,
	// Identity comes from the `token` cookie, so the suite can give each real
	// client its own presence key over a plain header.
	select: (userData) => ({ id: userData.token || 'anon' }),
	// Client-sent field updates are dropped unless the field is named here, so
	// without this the suite's update step would be a silent no-op and the case
	// would assert delivery of frames the server never published.
	clientUpdateFields: ['status']
});

export function upgrade({ cookies }) {
	const token = cookies?.token;
	return token ? { token } : {};
}

// Re-exported by reference, NOT wrapped. The plugin marks its subscribe hook as
// a side effect rather than a decision; wrapping it in a local function drops
// that marker and stands the server-grant gate down, which is the documented
// difference between plugin wiring and app authorization.
export const subscribe = presence.hooks.subscribe;
export const unsubscribe = presence.hooks.unsubscribe;

export function close(ws, ctx) {
	cursors.hooks.close(ws, ctx);
	presence.hooks.close(ws, ctx);
}

export function message(ws, ctx) {
	// Cursor first, as the documented chaining order: it claims its own frames
	// and returns true, so presence never sees them.
	if (cursors.hooks.message(ws, ctx)) return;
	if (presence.hooks.message(ws, ctx)) return;
	// A plain fan-out lane the delivery suite floods to put the worker under
	// load. It publishes on the topic it is told, which is never the room under
	// assertion, so the load competes for the same send path without touching
	// the roster being measured.
	const { data, msg, platform } = ctx;
	let env = msg;
	if (!env) { try { env = JSON.parse(Buffer.from(data).toString()); } catch { return; } }
	if (env && env.type === 'broadcast' && typeof env.topic === 'string') {
		platform.publish(env.topic, env.event || 'tick', env.payload, { seq: false });
	}
}
