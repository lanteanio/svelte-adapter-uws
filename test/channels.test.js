import { describe, it, expect } from 'vitest';
import { createChannel } from '../plugins/channels/server.js';

/**
 * Create a mock platform that records publish/send calls.
 */
function mockPlatform() {
	const p = {
		published: [],
		sent: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data });
			return 1;
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
		}
	};
	return p;
}

describe('channels plugin - server', () => {
	describe('createChannel', () => {
		it('returns a channel with the expected API', () => {
			const ch = createChannel('todos', {
				created: (d) => d,
				deleted: (d) => d
			});

			expect(ch.topic).toBe('todos');
			expect(ch.events).toEqual(['created', 'deleted']);
			expect(typeof ch.publish).toBe('function');
			expect(typeof ch.send).toBe('function');
		});

		it('throws on empty topic', () => {
			expect(() => createChannel('', { a: (d) => d })).toThrow('topic must be a non-empty string');
		});

		it('throws on non-string topic', () => {
			expect(() => createChannel(123, { a: (d) => d })).toThrow('topic must be a non-empty string');
		});

		it('throws on missing events', () => {
			expect(() => createChannel('t', null)).toThrow('events must be an object');
		});

		it('throws on array events', () => {
			expect(() => createChannel('t', ['a', 'b'])).toThrow('events must be an object');
		});

		it('throws on empty events object', () => {
			expect(() => createChannel('t', {})).toThrow('at least one event');
		});

		it('throws on invalid validator type', () => {
			expect(() => createChannel('t', { a: 42 })).toThrow('must be a function or have a .parse()');
		});

		it('throws on invalid validator (string)', () => {
			expect(() => createChannel('t', { a: 'not a validator' })).toThrow('must be a function or have a .parse()');
		});
	});

	describe('publish', () => {
		it('calls platform.publish with topic, event, data', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: (d) => d
			});

			ch.publish(platform, 'created', { id: '1', text: 'hello' });

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: 'todos',
				event: 'created',
				data: { id: '1', text: 'hello' }
			});
		});

		it('throws on unknown event name', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: (d) => d,
				deleted: (d) => d
			});

			expect(() => ch.publish(platform, 'updated', {})).toThrow(
				'unknown event "updated"'
			);
			expect(() => ch.publish(platform, 'updated', {})).toThrow(
				'Valid events: created, deleted'
			);

			// Nothing should have been published
			expect(platform.published).toHaveLength(0);
		});

		it('publishes transformed data from validator', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: (d) => ({ id: d.id, text: d.text })
			});

			ch.publish(platform, 'created', { id: '1', text: 'hello', secret: 'token' });

			expect(platform.published[0].data).toEqual({ id: '1', text: 'hello' });
			expect(platform.published[0].data.secret).toBeUndefined();
		});

		it('throws when validator rejects data', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: (d) => {
					if (!d.id) throw new Error('id is required');
					return d;
				}
			});

			expect(() => ch.publish(platform, 'created', { text: 'no id' })).toThrow(
				'validation failed: id is required'
			);
			expect(platform.published).toHaveLength(0);
		});

		it('returns platform.publish result', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: (d) => d });

			const result = ch.publish(platform, 'created', {});
			expect(result).toBe(true); // mockPlatform returns true
		});
	});

	describe('send', () => {
		it('calls platform.send with ws, topic, event, data', () => {
			const platform = mockPlatform();
			const ws = { id: 'ws1' };
			const ch = createChannel('todos', {
				created: (d) => d
			});

			ch.send(platform, ws, 'created', { id: '1' });

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0]).toEqual({
				ws,
				topic: 'todos',
				event: 'created',
				data: { id: '1' }
			});
		});

		it('throws on unknown event name', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: (d) => d });

			expect(() => ch.send(platform, {}, 'typo', {})).toThrow('unknown event "typo"');
			expect(platform.sent).toHaveLength(0);
		});

		it('validates data before sending', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: (d) => {
					if (typeof d.id !== 'string') throw new Error('id must be a string');
					return d;
				}
			});

			expect(() => ch.send(platform, {}, 'created', { id: 123 })).toThrow(
				'validation failed: id must be a string'
			);
			expect(platform.sent).toHaveLength(0);
		});

		it('returns platform.send result', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: (d) => d });

			const result = ch.send(platform, {}, 'created', {});
			expect(result).toBe(1); // mockPlatform returns 1
		});
	});

	describe('Zod-like .parse() validators', () => {
		it('uses .parse() method when present', () => {
			const platform = mockPlatform();
			const zodLike = {
				parse(data) {
					if (!data.id) throw new Error('id required');
					return { id: data.id };
				}
			};

			const ch = createChannel('todos', { created: zodLike });
			ch.publish(platform, 'created', { id: '1', extra: 'stripped' });

			expect(platform.published[0].data).toEqual({ id: '1' });
		});

		it('throws wrapped error on .parse() failure', () => {
			const platform = mockPlatform();
			const zodLike = {
				parse() {
					throw new Error('Expected string, received number');
				}
			};

			const ch = createChannel('todos', { created: zodLike });

			expect(() => ch.publish(platform, 'created', { id: 123 })).toThrow(
				'validation failed: Expected string, received number'
			);
		});

		it('mixes function and .parse() validators', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', {
				created: { parse: (d) => ({ id: d.id }) },
				deleted: (d) => ({ id: d.id })
			});

			ch.publish(platform, 'created', { id: '1', text: 'hello' });
			ch.publish(platform, 'deleted', { id: '1', text: 'hello' });

			expect(platform.published[0].data).toEqual({ id: '1' });
			expect(platform.published[1].data).toEqual({ id: '1' });
		});
	});

	describe('null validators', () => {
		it('passes data through unchanged when validator is null', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: null });

			ch.publish(platform, 'created', { anything: 'goes' });
			expect(platform.published[0].data).toEqual({ anything: 'goes' });
		});

		it('passes data through unchanged when validator is undefined', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: undefined });

			ch.publish(platform, 'created', { anything: 'goes' });
			expect(platform.published[0].data).toEqual({ anything: 'goes' });
		});

		it('still validates event names with null validators', () => {
			const platform = mockPlatform();
			const ch = createChannel('todos', { created: null, deleted: null });

			expect(() => ch.publish(platform, 'updated', {})).toThrow('unknown event "updated"');
		});
	});

	describe('multiple channels', () => {
		it('channels are independent', () => {
			const platform = mockPlatform();
			const todos = createChannel('todos', { created: (d) => d });
			const users = createChannel('users', { joined: (d) => d });

			todos.publish(platform, 'created', { id: '1' });
			users.publish(platform, 'joined', { name: 'Alice' });

			expect(platform.published[0].topic).toBe('todos');
			expect(platform.published[1].topic).toBe('users');

			// Each channel only knows its own events
			expect(() => todos.publish(platform, 'joined', {})).toThrow('unknown event');
			expect(() => users.publish(platform, 'created', {})).toThrow('unknown event');
		});
	});

	describe('error messages', () => {
		it('includes topic name in unknown event error', () => {
			const ch = createChannel('my-topic', { a: (d) => d });
			expect(() => ch.publish(mockPlatform(), 'b', {})).toThrow('channel "my-topic"');
		});

		it('includes topic name in validation error', () => {
			const ch = createChannel('my-topic', {
				a: () => { throw new Error('bad'); }
			});
			expect(() => ch.publish(mockPlatform(), 'a', {})).toThrow('channel "my-topic"');
		});

		it('includes event name in validation error', () => {
			const ch = createChannel('t', {
				save: () => { throw new Error('bad'); }
			});
			expect(() => ch.publish(mockPlatform(), 'save', {})).toThrow('event "save"');
		});

		it('includes original error message in validation error', () => {
			const ch = createChannel('t', {
				save: () => { throw new Error('missing field "name"'); }
			});
			expect(() => ch.publish(mockPlatform(), 'save', {})).toThrow('missing field "name"');
		});
	});
});
