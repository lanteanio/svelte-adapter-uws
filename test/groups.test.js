import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createGroup } from '../src/plugins/groups/server.js';
import { isAuthorizationHook, deniesUngrantedObserve, isPluginOwnedTopic, registerPluginOwnedPrefix } from '../src/runtime/utils/ws-symbols.js';
import { mockWs, mockPlatform } from './_helpers.js';

describe('groups plugin - server', () => {
	let group;
	let platform;

	beforeEach(() => {
		group = createGroup('lobby', { maxMembers: 5 });
		platform = mockPlatform();
	});

	describe('createGroup', () => {
		it('returns a group with the expected API', () => {
			expect(typeof group.join).toBe('function');
			expect(typeof group.leave).toBe('function');
			expect(typeof group.publish).toBe('function');
			expect(typeof group.send).toBe('function');
			expect(typeof group.members).toBe('function');
			expect(typeof group.count).toBe('function');
			expect(typeof group.has).toBe('function');
			expect(typeof group.close).toBe('function');
			expect(group.name).toBe('lobby');
		});

		it('throws on empty/non-string name', () => {
			expect(() => createGroup('')).toThrow('non-empty string');
			expect(() => createGroup(null)).toThrow('non-empty string');
			expect(() => createGroup(42)).toThrow('non-empty string');
		});

		it('default options work', () => {
			const g = createGroup('test');
			expect(g.count()).toBe(0);
		});

		it('throws on invalid maxMembers', () => {
			expect(() => createGroup('x', { maxMembers: 0 })).toThrow('positive number');
			expect(() => createGroup('x', { maxMembers: -1 })).toThrow('positive number');
		});

		it('throws on non-function hooks', () => {
			expect(() => createGroup('x', { onJoin: 'bad' })).toThrow('function');
			expect(() => createGroup('x', { onLeave: 42 })).toThrow('function');
			expect(() => createGroup('x', { onFull: {} })).toThrow('function');
			expect(() => createGroup('x', { onClose: [] })).toThrow('function');
		});

		it('meta is shallow-copied from options', () => {
			const meta = { game: 'chess' };
			const g = createGroup('test', { meta });
			expect(g.meta).toEqual({ game: 'chess' });
			expect(g.meta).not.toBe(meta); // different object
		});
	});

	describe('join', () => {
		it('adds member and subscribes to internal topic', () => {
			const ws = mockWs();
			const result = group.join(ws, platform);

			expect(result).toBe(true);
			expect(ws.isSubscribed('__group:lobby')).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('sends members list to joining ws', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__group:lobby');
			expect(platform.sent[0].event).toBe('members');
			expect(platform.sent[0].data).toEqual([{ role: 'member' }]);
		});

		it('publishes join event before subscribing', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('join');
			expect(platform.published[0].data).toEqual({ role: 'member', count: 1 });
		});

		it('default role is member', () => {
			const ws = mockWs();
			group.join(ws, platform);

			expect(group.members()[0].role).toBe('member');
		});

		it('accepts admin and viewer roles', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			group.join(ws1, platform, 'admin');
			group.join(ws2, platform, 'viewer');

			const roles = group.members().map(m => m.role);
			expect(roles).toContain('admin');
			expect(roles).toContain('viewer');
		});

		it('throws on invalid role', () => {
			const ws = mockWs();
			expect(() => group.join(ws, platform, 'superuser')).toThrow('invalid role');
		});

		it('is idempotent - joining twice returns true, no extra broadcast', () => {
			const ws = mockWs();
			group.join(ws, platform);
			const pubCount = platform.published.length;

			expect(group.join(ws, platform)).toBe(true);
			expect(platform.published.length).toBe(pubCount); // no new publish
			expect(group.count()).toBe(1);
		});

		it('returns false when group is full', () => {
			const g = createGroup('small', { maxMembers: 2 });
			g.join(mockWs(), platform);
			g.join(mockWs(), platform);

			expect(g.join(mockWs(), platform)).toBe(false);
			expect(g.count()).toBe(2);
		});

		it('calls onFull when full', () => {
			const fullCalls = [];
			const g = createGroup('small', {
				maxMembers: 1,
				onFull: (ws, role) => fullCalls.push(role)
			});
			g.join(mockWs(), platform);
			g.join(mockWs(), platform); // rejected

			expect(fullCalls).toEqual(['member']);
		});

		it('calls onJoin hook', () => {
			const joinCalls = [];
			const g = createGroup('test', {
				onJoin: (ws, role) => joinCalls.push(role)
			});
			g.join(mockWs(), platform, 'admin');
			expect(joinCalls).toEqual(['admin']);
		});

		it('uses the role returned by onJoin', () => {
			const g = createGroup('test', { onJoin: () => 'admin' });
			const ws = mockWs();
			expect(g.join(ws, platform, 'member')).toBe(true);
			expect(g.members()[0].role).toBe('admin');
			expect(platform.published[0].data.role).toBe('admin');
		});

		it('onJoin false rejects before any membership or roster side effect', () => {
			const g = createGroup('test', { onJoin: () => false });
			const ws = mockWs();
			expect(g.join(ws, platform)).toBe(false);
			expect(g.count()).toBe(0);
			expect(ws.isSubscribed('__group:test')).toBe(false);
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('onJoin throw fails before any membership or roster side effect', () => {
			const g = createGroup('test', { onJoin: () => { throw new Error('denied'); } });
			const ws = mockWs();
			expect(() => g.join(ws, platform)).toThrow('denied');
			expect(g.count()).toBe(0);
			expect(ws.isSubscribed('__group:test')).toBe(false);
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('rejects an invalid role returned by onJoin before side effects', () => {
			const g = createGroup('test', { onJoin: () => /** @type {any} */ ('owner') });
			const ws = mockWs();
			expect(() => g.join(ws, platform)).toThrow('onJoin returned invalid role');
			expect(g.count()).toBe(0);
			expect(ws.isSubscribed('__group:test')).toBe(false);
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('rejects an async onJoin instead of granting before it resolves', () => {
			const g = createGroup('test', { onJoin: /** @type {any} */ (async () => 'admin') });
			const ws = mockWs();
			expect(() => g.join(ws, platform)).toThrow('onJoin must be synchronous');
			expect(g.count()).toBe(0);
			expect(ws.isSubscribed('__group:test')).toBe(false);
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('contains a later async onJoin rejection after refusing the join', async () => {
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const g = createGroup('test', {
					onJoin: /** @type {any} */ (async () => { throw new Error('late denial'); })
				});
				const ws = mockWs();
				expect(() => g.join(ws, platform)).toThrow('onJoin must be synchronous');
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(logged).toHaveBeenCalledWith(
					'[group test] async onJoin rejected after being refused:',
					expect.objectContaining({ message: 'late denial' })
				);
				expect(g.count()).toBe(0);
				expect(ws.isSubscribed('__group:test')).toBe(false);
			} finally {
				logged.mockRestore();
			}
		});

		it('returns false when group is closed', () => {
			group.close(platform);
			expect(group.join(mockWs(), platform)).toBe(false);
		});
	});

	describe('leave', () => {
		it('removes member and unsubscribes', () => {
			const ws = mockWs();
			group.join(ws, platform);
			group.leave(ws, platform);

			expect(group.count()).toBe(0);
			expect(ws.isSubscribed('__group:lobby')).toBe(false);
		});

		it('publishes leave event with count', () => {
			const ws = mockWs();
			group.join(ws, platform);
			platform.reset();

			group.leave(ws, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('leave');
			expect(platform.published[0].data).toEqual({ role: 'member', count: 0 });
		});

		it('calls onLeave hook', () => {
			const leaveCalls = [];
			const g = createGroup('test', {
				onLeave: (ws, role) => leaveCalls.push(role)
			});
			const ws = mockWs();
			g.join(ws, platform);
			g.leave(ws, platform);

			expect(leaveCalls).toEqual(['member']);
		});

		it('is safe for non-member', () => {
			expect(() => group.leave(mockWs(), platform)).not.toThrow();
			expect(platform.published).toHaveLength(0);
		});
	});

	describe('publish', () => {
		it('broadcasts to all members via internal topic', () => {
			group.join(mockWs(), platform);
			platform.reset();

			group.publish(platform, 'chat', { text: 'hello' });

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].topic).toBe('__group:lobby');
			expect(platform.published[0].event).toBe('chat');
			expect(platform.published[0].data).toEqual({ text: 'hello' });
		});

		it('filtered by role: only matching role members receive', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			const ws3 = mockWs();
			group.join(ws1, platform, 'admin');
			group.join(ws2, platform, 'member');
			group.join(ws3, platform, 'admin');
			platform.reset();

			group.publish(platform, 'admin-msg', { secret: true }, 'admin');

			// Should use send() for each admin, not publish()
			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(2);
			expect(platform.sent[0].ws).toBe(ws1);
			expect(platform.sent[1].ws).toBe(ws3);
		});

		it('is no-op when group is closed', () => {
			group.join(mockWs(), platform);
			group.close(platform);
			platform.reset();

			group.publish(platform, 'chat', {});
			expect(platform.published).toHaveLength(0);
		});
	});

	describe('send', () => {
		it('sends to a single member', () => {
			const ws = mockWs();
			group.join(ws, platform);
			platform.reset();

			group.send(platform, ws, 'whisper', { text: 'hi' });

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].ws).toBe(ws);
			expect(platform.sent[0].event).toBe('whisper');
		});

		it('throws for non-member ws', () => {
			expect(() => group.send(platform, mockWs(), 'msg', {}))
				.toThrow('not a member');
		});
	});

	describe('members / count / has', () => {
		it('members() returns array with ws and role', () => {
			const ws = mockWs();
			group.join(ws, platform, 'admin');

			const m = group.members();
			expect(m).toHaveLength(1);
			expect(m[0].ws).toBe(ws);
			expect(m[0].role).toBe('admin');
		});

		it('count() returns member count', () => {
			expect(group.count()).toBe(0);
			group.join(mockWs(), platform);
			expect(group.count()).toBe(1);
			group.join(mockWs(), platform);
			expect(group.count()).toBe(2);
		});

		it('has() returns true for members, false otherwise', () => {
			const ws = mockWs();
			expect(group.has(ws)).toBe(false);

			group.join(ws, platform);
			expect(group.has(ws)).toBe(true);

			group.leave(ws, platform);
			expect(group.has(ws)).toBe(false);
		});
	});

	describe('meta', () => {
		it('get/set metadata', () => {
			expect(group.meta).toEqual({});

			group.meta = { game: 'chess', round: 1 };
			expect(group.meta).toEqual({ game: 'chess', round: 1 });
		});

		it('initial meta from options is independent', () => {
			const opts = { game: 'chess' };
			const g = createGroup('test', { meta: opts });
			g.meta.game = 'go';
			expect(opts.game).toBe('chess'); // unchanged
		});
	});

	describe('leave (defensive)', () => {
		it('does not throw if ws.unsubscribe throws during leave', () => {
			const ws = mockWs();
			ws.unsubscribe = () => { throw new Error('socket closed'); };
			group.join(ws, platform);
			expect(() => group.leave(ws, platform)).not.toThrow();
		});
	});

	describe('close', () => {
		it('publishes close event', () => {
			group.join(mockWs(), platform);
			platform.reset();

			group.close(platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('close');
		});

		it('unsubscribes all members', () => {
			const ws1 = mockWs();
			const ws2 = mockWs();
			group.join(ws1, platform);
			group.join(ws2, platform);

			group.close(platform);

			expect(ws1.isSubscribed('__group:lobby')).toBe(false);
			expect(ws2.isSubscribed('__group:lobby')).toBe(false);
		});

		it('clears member list', () => {
			group.join(mockWs(), platform);
			group.close(platform);

			expect(group.count()).toBe(0);
			expect(group.members()).toEqual([]);
		});

		it('calls onClose hook', () => {
			let called = false;
			const g = createGroup('test', { onClose: () => { called = true; } });
			g.close(platform);

			expect(called).toBe(true);
		});

		it('subsequent joins return false', () => {
			group.close(platform);
			expect(group.join(mockWs(), platform)).toBe(false);
		});

		it('subsequent publish is no-op', () => {
			group.close(platform);
			platform.reset();
			group.publish(platform, 'chat', {});
			expect(platform.published).toHaveLength(0);
		});

		it('closing twice is safe (idempotent)', () => {
			group.close(platform);
			expect(() => group.close(platform)).not.toThrow();
		});
	});

	describe('hooks', () => {
		it('exposes subscribe, unsubscribe, and close functions', () => {
			expect(typeof group.hooks.subscribe).toBe('function');
			expect(typeof group.hooks.unsubscribe).toBe('function');
			expect(typeof group.hooks.close).toBe('function');
		});

		it('hooks.subscribe calls join for __group:{name} topic', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:lobby', { platform });

			expect(result).not.toBe(false);
			expect(group.has(ws)).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('hooks.subscribe returns false when group is full', () => {
			const g = createGroup('tiny', { maxMembers: 1 });
			g.join(mockWs(), platform);

			const ws = mockWs();
			const result = g.hooks.subscribe(ws, '__group:tiny', { platform });

			expect(result).toBe(false);
			expect(g.has(ws)).toBe(false);
		});

		it('hooks.subscribe returns false when group is closed', () => {
			group.close(platform);

			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:lobby', { platform });

			expect(result).toBe(false);
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.subscribe passes through unrelated topics', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, 'chat', { platform });

			expect(result).toBeUndefined();
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.subscribe passes through other __group: topics', () => {
			const ws = mockWs();
			const result = group.hooks.subscribe(ws, '__group:other', { platform });

			expect(result).toBeUndefined();
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.unsubscribe calls leave for __group:{name}', () => {
			const ws = mockWs();
			group.join(ws, platform);
			expect(group.count()).toBe(1);

			group.hooks.unsubscribe(ws, '__group:lobby', { platform });

			expect(group.count()).toBe(0);
			expect(group.has(ws)).toBe(false);
		});

		it('hooks.unsubscribe ignores unrelated topics', () => {
			const ws = mockWs();
			group.join(ws, platform);

			group.hooks.unsubscribe(ws, 'chat', { platform });

			expect(group.has(ws)).toBe(true);
			expect(group.count()).toBe(1);
		});

		it('hooks.close calls leave', () => {
			const ws = mockWs();
			group.join(ws, platform);
			expect(group.count()).toBe(1);

			group.hooks.close(ws, { platform });

			expect(group.count()).toBe(0);
			expect(group.has(ws)).toBe(false);
		});

		it('destructured hooks work correctly', () => {
			const { subscribe, unsubscribe, close } = group.hooks;
			const ws = mockWs();

			subscribe(ws, '__group:lobby', { platform });
			expect(group.has(ws)).toBe(true);

			unsubscribe(ws, '__group:lobby', { platform });
			expect(group.has(ws)).toBe(false);
		});

		// The server-grant gate stands down for the WHOLE connection as soon as
		// the app exports a subscribe hook, and this plugin's documented wiring
		// re-exports this one. But it decides for exactly one topic - the
		// group's own channel - and returns undefined for every app topic, so
		// counting it as the app taking over authorization meant arming
		// `authorizeWireSubscribe` and following this plugin's README produced
		// no enforcement on any topic at all.
		it('subscribe hook does not count as the app taking over authorization', () => {
			expect(isAuthorizationHook(group.hooks.subscribe)).toBe(false);
		});

		it('the mark survives the documented destructuring', () => {
			// The mark lives on the function, not the container, so re-exporting
			// individual hooks - which is what the README tells apps to do -
			// carries it through.
			const { subscribe } = group.hooks;
			expect(isAuthorizationHook(subscribe)).toBe(false);
		});

		it('an app wrapper is still treated as an authorization hook', () => {
			// Wrapping is app code, which may decide, so the gate steps aside as
			// documented. Losing this would break the escape hatch.
			const wrapped = (ws, topic, ctx) => group.hooks.subscribe(ws, topic, ctx);
			expect(isAuthorizationHook(wrapped)).toBe(true);
		});

		// The mark alone was not enough, and asserting only on the mark could not
		// see it: with the gate armed, a client joins a group by subscribing to
		// `__group:<name>`, the gate refused that before the hook ran, and the
		// hook was the only thing that would ever authorize it - so the group
		// became permanently unjoinable.
		//
		// The deferral belongs to the WIRE-SUBSCRIBE pre-gate, which re-tests
		// real membership when the hook lands. It must NOT extend to
		// deniesUngrantedObserve, which answers for the observer gate and the
		// client-named resume filter - lanes with no landing re-check, where the
		// predicate IS the gate. This suite previously asserted the opposite and
		// so pinned the bypass in place: a client could be refused
		// `__group:private` on the live path and served its buffered history by
		// naming it in a resume frame.
		it('the observer/resume gate refuses an ungranted group channel', () => {
			const armed = true;
			const noAppHook = false;
			const noGrants = new Set();
			expect(deniesUngrantedObserve(armed, noAppHook, noGrants, '__group:lobby')).toBe(true);
		});

		it('and admits the group channel once the plugin has actually joined the socket', () => {
			// The deferral the plugin needs, expressed as membership rather than
			// as a namespace exemption: a client the hook admitted is in the
			// subscription registry, so the ordinary grant test passes for it.
			const granted = new Set(['__group:lobby']);
			expect(deniesUngrantedObserve(true, false, granted, '__group:lobby')).toBe(false);
		});

		it('and still refuses an ordinary topic the server never granted', () => {
			expect(deniesUngrantedObserve(true, false, new Set(), 'private-room')).toBe(true);
		});

		it('claims only its own prefix', () => {
			expect(isPluginOwnedTopic('__group:lobby')).toBe(true);
			expect(isPluginOwnedTopic('private-room')).toBe(false);
			expect(isPluginOwnedTopic('__presence:room')).toBe(false);
		});

		// registerPluginOwnedPrefix punches a hole in the grant gate, so what it
		// ACCEPTS is a security surface. It previously took any non-empty string:
		// `''` was refused but `'__'` was not (making every internal topic
		// plugin-owned), and an ordinary namespace like `'room:'` handed the
		// exemption to a whole class of app topics.
		it('refuses a prefix that would swallow more than one plugin namespace', () => {
			for (const bad of ['', '_', '__', 'a', 'room:', 'chat:', '0', ' ', '__group', 'group:', '__:', '__1bad:']) {
				expect(() => registerPluginOwnedPrefix(bad), `"${bad}" must be refused`).toThrow();
			}
		});

		it('refuses a non-string prefix', () => {
			for (const bad of [undefined, null, 42, {}, ['__x:']]) {
				expect(() => registerPluginOwnedPrefix(/** @type {any} */ (bad))).toThrow(TypeError);
			}
		});

		it('cannot register a namespace that swallows another plugin', () => {
			// The format is what guarantees this: a namespace carries no `:` and
			// the prefix ends with one, so two distinct valid prefixes always
			// diverge at the terminator and neither can be a prefix of the other.
			// `__gro:` shares five characters with `__group:` yet claims none of
			// its topics.
			expect(() => registerPluginOwnedPrefix('__gro:')).not.toThrow();
			expect(isPluginOwnedTopic('__gro:x')).toBe(true);
			expect(isPluginOwnedTopic('__group:lobby')).toBe(true);
			// A nested spelling is refused outright - the namespace rule catches
			// the `:` before anything else can.
			expect(() => registerPluginOwnedPrefix('__group:sub:')).toThrow();
		});

		it('stays idempotent for the identical prefix', () => {
			expect(() => registerPluginOwnedPrefix('__group:')).not.toThrow();
			expect(isPluginOwnedTopic('__group:lobby')).toBe(true);
		});

		it('accepts a well-formed prefix from another plugin', () => {
			expect(() => registerPluginOwnedPrefix('__lobbyx:')).not.toThrow();
			expect(isPluginOwnedTopic('__lobbyx:one')).toBe(true);
			// And that registration did not widen anything else.
			expect(isPluginOwnedTopic('lobbyx:one')).toBe(false);
		});

		it('still denies its own topic while marked', () => {
			// Marking changes only the arming decision - a `false` return is
			// still honoured as a denial by the hook runner.
			const g = createGroup('tiny', { maxMembers: 1 });
			g.hooks.subscribe(mockWs(), '__group:tiny', { platform });
			expect(g.hooks.subscribe(mockWs(), '__group:tiny', { platform })).toBe(false);
		});
	});
});
