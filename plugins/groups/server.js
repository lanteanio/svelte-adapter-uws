/**
 * Broadcast groups plugin for svelte-adapter-uws.
 *
 * Named groups with explicit membership, roles, metadata, and lifecycle
 * hooks. Like topics but with access control -- you decide who can join,
 * who can publish, and what happens when the group fills up or closes.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * uses ws.subscribe(), ws.unsubscribe(), platform.publish(), and
 * platform.send().
 *
 * @module svelte-adapter-uws/plugins/groups
 */

/**
 * @typedef {'member' | 'admin' | 'viewer'} GroupRole
 */

/**
 * @typedef {Object} GroupOptions
 * @property {number} [maxMembers=Infinity] - Maximum members allowed.
 *   When the group is full, `join()` returns `false` and calls `onFull`.
 * @property {Record<string, any>} [meta] - Initial group metadata (shallow-copied).
 * @property {(ws: any, role: GroupRole) => void} [onJoin] - Called after a member joins.
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
 * // src/hooks.ws.js - zero-config (just spread hooks)
 * import { lobby } from '$lib/server/lobby';
 *
 * export const { subscribe, unsubscribe, close } = lobby.hooks;
 * ```
 */
export function createGroup(name, options = {}) {
	if (!name || typeof name !== 'string') {
		throw new Error('group: name must be a non-empty string');
	}

	const maxMembers = options.maxMembers ?? Infinity;
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
	const internalTopic = '__group:' + name;

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

			members.set(ws, { role });

			// Publish join BEFORE subscribing so joiner doesn't see own join
			platform.publish(internalTopic, 'join', { role, count: members.size });

			ws.subscribe(internalTopic);

			// Send current member list to the joiner
			platform.send(ws, internalTopic, 'members', membersList());

			if (onJoin) onJoin(ws, role);
			return true;
		},

		leave(ws, platform) {
			const entry = members.get(ws);
			if (!entry) return;

			members.delete(ws);
			try { ws.unsubscribe(internalTopic); } catch (_) {}

			platform.publish(internalTopic, 'leave', { role: entry.role, count: members.size });

			if (onLeave) onLeave(ws, entry.role);
		},

		publish(platform, event, data, role) {
			if (closed) return;

			if (role == null) {
				// Broadcast to all members via the internal topic
				platform.publish(internalTopic, event, data);
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

			platform.publish(internalTopic, 'close', null);

			for (const [ws] of members) {
				try { ws.unsubscribe(internalTopic); } catch (_) {}
			}

			members.clear();
			if (onClose) onClose();
		},

		hooks: {
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
		}
	};

	return grp;
}
