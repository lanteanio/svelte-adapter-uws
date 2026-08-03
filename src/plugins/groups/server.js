/**
 * Broadcast groups plugin for svelte-adapter-uws.
 *
 * Named groups with explicit membership, roles, metadata, and lifecycle
 * hooks. Like topics but with access control - you decide who can join,
 * who can publish, and what happens when the group fills up or closes.
 *
 * Zero impact on the adapter core - this module only uses the tracked
 * subscribe/unsubscribe helpers (native membership plus the subscription
 * registry the binary publish walk delivers by), platform.publish(), and
 * platform.send().
 *
 * MULTI-TENANT NOTE
 * Group state is keyed by the group name verbatim. In a single-process
 * deployment with multiple tenants, two tenants creating a group with
 * the same name (`'admins'`, `'staff'`) collide on the SAME state.
 * Apps must namespace group names with a tenant scope:
 *
 *     createGroup('org-' + tenantId + ':admins', { ... })
 *
 * Same recommendation for `presence`, `replay`, and `cursor` plugins.
 *
 * @module svelte-adapter-uws/plugins/groups
 */

import { trackedSubscribe, trackedUnsubscribe, markSideEffectHooks, registerPluginOwnedPrefix } from '../../runtime/utils.js';

const TOPIC_PREFIX = '__group:';

// A group is joined by the client subscribing to `__group:<name>`, and the only
// thing that authorizes that is this plugin's own subscribe hook below. Marking
// that hook a side effect stops it disarming the grant gate for every other
// topic; declaring the prefix is the other half, so the gate does not refuse
// the group's own channel before the hook it defers to has run. The hook still
// decides, and still refuses an admission-denied, full, or closed group. The
// system-topic guard consults the same prefix registry; landing still requires
// join() to have established tracked membership, so other __group:* spellings
// do not inherit access.
registerPluginOwnedPrefix(TOPIC_PREFIX);

/**
 * @typedef {'member' | 'admin' | 'viewer'} GroupRole
 */

/**
 * @typedef {Object} GroupOptions
 * @property {number} [maxMembers=1_000_000] - Maximum members allowed.
 *   When the group is full, `join()` returns `false` and calls `onFull`.
 *   Pass `Infinity` to disable the cap (not recommended at uWS scale).
 * @property {Record<string, any>} [meta] - Initial group metadata (shallow-copied).
 * @property {(ws: any, role: GroupRole) => GroupRole | false | void} [onJoin] -
 *   Synchronous admission hook. Return false to reject, a role to override the
 *   requested role, or undefined to accept it unchanged. Runs before any
 *   membership, broadcast, or roster side effect.
 * @property {(ws: any, role: GroupRole) => void} [onLeave] - Called after a member leaves.
 * @property {(ws: any, role: GroupRole) => void} [onFull] - Called when a join is rejected
 *   because the group is full.
 * @property {() => void} [onClose] - Called when the group is closed.
 */

/**
 * @typedef {Object} GroupMember
 * @property {any} ws - The WebSocket connection.
 * @property {GroupRole} role - The member's role.
 */

/**
 * @typedef {Object} Group
 * @property {string} name - The group name (read-only).
 * @property {number} maxMembers - The resolved member cap (read-only).
 * @property {Record<string, any>} meta - Group metadata (get/set).
 * @property {(ws: any, platform: import('../../index.js').Platform, role?: GroupRole) => boolean} join -
 *   Add a member. Returns `true` on success, `false` if full or closed.
 * @property {(ws: any, platform: import('../../index.js').Platform) => void} leave -
 *   Remove a member.
 * @property {(platform: import('../../index.js').Platform, event: string, data?: any, role?: GroupRole) => void} publish -
 *   Broadcast to all members, or filter by role.
 * @property {(platform: import('../../index.js').Platform, ws: any, event: string, data?: any) => void} send -
 *   Send to a single member (validates membership).
 * @property {() => GroupMember[]} members - List all members with roles.
 * @property {() => number} count - Current member count.
 * @property {(ws: any) => boolean} has - Check if a ws is a member.
 * @property {(platform: import('../../index.js').Platform) => void} close -
 *   Dissolve the group, notify all members, and clean up.
 * @property {{ subscribe: Function, unsubscribe: Function, close: Function }} hooks -
 *   Ready-made WebSocket hooks. subscribe intercepts the internal
 *   __group:{name} topic and calls join() to gate access. unsubscribe
 *   calls leave() when the client unsubscribes. close calls leave().
 */

/**
 * Create a broadcast group.
 *
 * @param {string} name - Unique group name.
 * @param {GroupOptions} [options]
 * @returns {Group}
 *
 * @example
 * ```js
 * // src/lib/server/lobby.js
 * import { createGroup } from 'svelte-adapter-uws/plugins/groups';
 *
 * export const lobby = createGroup('lobby', {
 *   maxMembers: 50,
 *   meta: { game: 'chess' },
 *   onFull: (ws) => {
 *     // send "lobby full" message to rejected client
 *   }
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - ready-made admission + membership wiring
 * import { lobby } from '$lib/server/lobby';
 *
 * export const { subscribe, unsubscribe, close } = lobby.hooks;
 * ```
 */
export function createGroup(name, options = {}) {
	if (!name || typeof name !== 'string') {
		throw new Error('group: name must be a non-empty string');
	}

	// Membership is a Map keyed by the socket, and every join broadcasts to
	// everyone already in it, so an unbounded group is both a memory site and a
	// fan-out multiplier. The default matches the rest of the plugin caps:
	// 1,000,000 is the connection ceiling of the process, so it cannot bite a
	// real group, but it still stops entries piling up past it when an app wires
	// `subscribe` without `close` and departed sockets never leave. `Infinity`
	// stays available as an explicit opt-out.
	const maxMembers = options.maxMembers ?? 1_000_000;
	const onJoin = options.onJoin ?? null;
	const onLeave = options.onLeave ?? null;
	const onFull = options.onFull ?? null;
	const onClose = options.onClose ?? null;

	if (typeof maxMembers !== 'number' || (!Number.isFinite(maxMembers) && maxMembers !== Infinity) || maxMembers < 1) {
		throw new Error('group: maxMembers must be a positive number or Infinity');
	}
	if (onJoin != null && typeof onJoin !== 'function') {
		throw new Error('group: onJoin must be a function');
	}
	if (onLeave != null && typeof onLeave !== 'function') {
		throw new Error('group: onLeave must be a function');
	}
	if (onFull != null && typeof onFull !== 'function') {
		throw new Error('group: onFull must be a function');
	}
	if (onClose != null && typeof onClose !== 'function') {
		throw new Error('group: onClose must be a function');
	}

	const VALID_ROLES = new Set(['member', 'admin', 'viewer']);
	const internalTopic = TOPIC_PREFIX + name;

	/** @type {Map<any, { role: GroupRole }>} */
	const members = new Map();

	let metadata = options.meta ? { ...options.meta } : {};
	let closed = false;

	/** Build a members list for broadcasting. */
	function membersList() {
		const list = [];
		for (const [, entry] of members) {
			list.push({ role: entry.role });
		}
		return list;
	}

	/** @type {Group} */
	const grp = {
		get name() { return name; },

		get maxMembers() { return maxMembers; },

		get meta() { return metadata; },
		set meta(val) { metadata = val; },

		join(ws, platform, role = 'member') {
			if (closed) return false;
			if (members.has(ws)) return true; // idempotent

			if (!VALID_ROLES.has(role)) {
				throw new Error(`group "${name}": invalid role "${role}"`);
			}

			if (members.size >= maxMembers) {
				if (onFull) onFull(ws, role);
				return false;
			}

			// Admission comes before EVERY membership side effect. The README has
			// always documented onJoin as the policy decision, but it used to run
			// after members.set(), the join broadcast, trackedSubscribe(), and the
			// full roster send. A thrown authorization error therefore told the
			// client INTERNAL_ERROR while leaving it subscribed with the roster it
			// was meant to be denied. Undefined preserves the historical callback
			// style (accept the requested role); false rejects cleanly; a returned
			// role lets the policy assign privileges.
			if (onJoin) {
				const decision = onJoin(ws, role);
				if (decision === false) return false;
				if (VALID_ROLES.has(decision)) {
					role = decision;
				} else if (typeof decision === 'string') {
					// Strings are unambiguously attempts to select a role, so a typo
					// must be loud rather than silently granting the requested role.
					throw new Error(`group ${name}: onJoin returned invalid role ${decision}`);
				} else if (decision && typeof decision.then === 'function') {
					// join() is synchronous. Treating a Promise as an incidental return
					// would install membership before async authorization resolved. The
					// callback has already created the Promise, so observe a later reject
					// rather than turning this fail-closed configuration error into an
					// unhandled rejection that can terminate the worker.
					void Promise.resolve(decision).catch((err) => {
						console.error(`[group ${name}] async onJoin rejected after being refused:`, err);
					});
					throw new Error(`group ${name}: onJoin must be synchronous`);
				}
				// Preserve existing lifecycle callbacks such as
				// `onJoin: () => calls.push(...)`, whose incidental numeric return was
				// historically ignored. Only false and role strings are decisions.
			}

			members.set(ws, { role });

			// Publish join BEFORE subscribing so joiner doesn't see own join
			// `seq: false`: membership notifications are per-worker roster events with
			// no monotonic promise; see the cluster sequence guard.
			platform.publish(internalTopic, 'join', { role, count: members.size }, { seq: false });

			// Callers reach `join` after their own async auth chain; the
			// socket may have closed in the meantime. Roll back the
			// member entry instead of letting uWS's "Invalid access"
			// crash the worker. Tracked: membership joins the subscription
			// registry so a future binary wire path delivers to members.
			if (!trackedSubscribe(ws, internalTopic)) {
				members.delete(ws);
				return false;
			}

			// Send current member list to the joiner
			platform.send(ws, internalTopic, 'members', membersList());

			return true;
		},

		leave(ws, platform) {
			const entry = members.get(ws);
			if (!entry) return;

			members.delete(ws);
			trackedUnsubscribe(ws, internalTopic);

			platform.publish(internalTopic, 'leave', { role: entry.role, count: members.size }, { seq: false });

			if (onLeave) onLeave(ws, entry.role);
		},

		publish(platform, event, data, role) {
			if (closed) return;

			if (role == null) {
				// Broadcast to all members via the internal topic
				platform.publish(internalTopic, event, data, { seq: false });
				return;
			}

			// Filtered by role: send individually
			for (const [ws, entry] of members) {
				if (entry.role === role) {
					platform.send(ws, internalTopic, event, data);
				}
			}
		},

		send(platform, ws, event, data) {
			if (!members.has(ws)) {
				throw new Error(`group "${name}": ws is not a member`);
			}
			platform.send(ws, internalTopic, event, data);
		},

		members() {
			const result = [];
			for (const [ws, entry] of members) {
				result.push({ ws, role: entry.role });
			}
			return result;
		},

		count() {
			return members.size;
		},

		has(ws) {
			return members.has(ws);
		},

		close(platform) {
			if (closed) return;
			closed = true;

			platform.publish(internalTopic, 'close', null, { seq: false });

			for (const [ws] of members) {
				trackedUnsubscribe(ws, internalTopic);
			}

			members.clear();
			if (onClose) onClose();
		},

		// This subscribe hook decides for exactly one topic - the group's own
		// `__group:` channel - and returns undefined for every other topic an
		// app has. The server-grant gate, though, steps aside for the WHOLE
		// connection as soon as an app exports a subscribe hook, and the
		// documented wiring re-exports this one. So arming
		// `authorizeWireSubscribe` and following this plugin's README used to
		// produce no enforcement on any app topic: a client could name any
		// topic and be subscribed. Marking it keeps the gate armed while the
		// hook still runs and its `false` still denies - the mark is read only
		// when deciding whether the APP took over authorization, never when
		// honouring a denial. An app that wraps this hook in its own function
		// is not marked, and the gate steps aside as documented.
		hooks: markSideEffectHooks({
			subscribe(ws, topic, { platform }) {
				if (topic === internalTopic) {
					return grp.join(ws, platform) ? undefined : false;
				}
			},
			unsubscribe(ws, topic, { platform }) {
				if (topic === internalTopic) {
					grp.leave(ws, platform);
				}
			},
			close(ws, { platform }) {
				grp.leave(ws, platform);
			}
		}, ['subscribe'])
	};

	return grp;
}
