// What the default presence / cursor projections broadcast to every peer.
//
// Two failure directions, and both are real. Letting a credential through is a
// leak; dropping an ordinary display field is a product bug an app debugs from
// the client against a server working as designed. The name rules are biased
// toward dropping, so the second direction is pinned here just as carefully as
// the first, and a drop is reported rather than silent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	isUnsafeProjectionFieldName,
	exceedsDepth,
	MAX_PROJECTION_DEPTH
} from '../src/plugins/_shared/sensitive.js';
import { createPresence } from '../src/plugins/presence/server.js';
import { createCursor } from '../src/plugins/cursor/server.js';
import { mockWs, mockPlatform } from './_helpers.js';

/**
 * The exact question the projections ask. Asking the two underlying predicates
 * instead would test a path the shipped code does not take - and would leave
 * the memo in front of them, which is what actually answers, untested.
 */
const dropped = (name) => isUnsafeProjectionFieldName(name);

describe('flat lowercase spellings', () => {
	// A name with no separator and no camelCase hump is ONE word, so word
	// matching alone found nothing in it. Assuming otherwise reopened a hole the
	// substring rule had closed: `apiKey` and `api_key` were dropped while
	// `apikey` - the same value, a third spelling - was broadcast.
	const flat = [
		'apikey', 'APIKEY', 'secretkey', 'privatekey', 'privkey', 'accesskey',
		'sessionid', 'sessionkey', 'sessiontoken', 'accesstoken', 'refreshtoken',
		'idtoken', 'jwtsecret', 'clientsecret', 'webhooksecret', 'signingsecret',
		'apisecret', 'totpsecret', 'dbpassword', 'passwordhash', 'tokenhash',
		'setcookie', 'cookieheader', 'credentialid', 'passphrase', 'bearer',
		'mnemonic', 'keystore', 'connectionstring'
	];
	for (const name of flat) {
		it(`drops ${name}`, () => expect(dropped(name)).toBe(true));
	}
});

describe('a structural qualifier only counts immediately before the key', () => {
	// Accepting one anywhere let a credential hide behind it.
	const hidden = [
		'userApiKey', 'userAccessKey', 'userPrivateKey', 'nodePrivateKey',
		'groupPrivateKey', 'recordEncryptionKey', 'itemApiKey', 'entitySigningKey'
	];
	for (const name of hidden) {
		it(`drops ${name}`, () => expect(dropped(name)).toBe(true));
	}

	it('still passes the plain subject-qualified identifier', () => {
		// `userKey` is a supported presence dedup key field; an existing suite
		// pins it, so the rule has to keep it while catching `userApiKey`.
		expect(dropped('userKey')).toBe(false);
		expect(dropped('groupKey')).toBe(false);
	});
});

describe('credential-shaped key names', () => {
	// The previous rule listed the qualifiers that make a key secret and let
	// every unlisted one through, so all of these rode the roster - while their
	// snake_case twins were correctly dropped. Same value, two spellings,
	// opposite verdicts.
	const credentials = [
		'key', 'KEY', 'api_key', 'x-api-key', 'apiKey', 'accessKey', 'privateKey',
		'signingKey', 'licenseKey', 'masterKey',
		'streamKey', 'serverKey', 'hmacKey', 'deviceKey', 'webhookKey', 'signKey',
		'cryptoKey', 'symmetricKey', 'recoveryKey', 'pairingKey', 'seedKey', 'vapidKey',
		'idempotencyKey'
	];

	// `authorKey` is NOT here. It used to be, because the rule dropped every
	// qualifier it did not recognize, so listing it recorded a side effect
	// rather than a judgement. It is the author's identity key - the same shape
	// as `userKey`, which this plugin documents as a supported dedup field - and
	// the `author` family is deliberately kept riding a roster.
	it('keeps authorKey, which is identity rather than a credential', () => {
		expect(dropped('authorKey')).toBe(false);
		expect(dropped('userKey')).toBe(false);
	});

	for (const name of credentials) {
		it(`drops ${name}`, () => {
			expect(dropped(name)).toBe(true);
		});
	}

	it('drops the camelCase and snake_case spellings alike', () => {
		for (const camel of ['streamKey', 'hmacKey', 'deviceKey', 'serverKey']) {
			const snake = camel.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
			expect(dropped(camel), camel).toBe(dropped(snake));
			expect(dropped(camel), camel).toBe(true);
		}
	});

	// THE FLAT SPELLING, which is the one that actually leaked. The parity test
	// above was written to the shape of the fix rather than the shape of the
	// threat: a lowercase name with no separator and no hump is a SINGLE word,
	// so the word rule never saw `key` inside it and `streamkey` rode the roster
	// while `streamKey` and `stream_key` were dropped. A database column, a SQL
	// row and plenty of JSON payloads give you exactly that spelling.
	it('drops the flat and SCREAMING spellings too', () => {
		const qualifiers = [
			'stream', 'server', 'hmac', 'device', 'webhook', 'sign', 'crypto',
			'recovery', 'pairing', 'vapid', 'idempotency', 'license', 'master',
			'root', 'deploy', 'api', 'private', 'access', 'signing', 'encryption'
		];
		for (const q of qualifiers) {
			for (const spelling of [`${q}key`, `${q}keys`, `${q}KEY`.toUpperCase()]) {
				expect(dropped(spelling), spelling).toBe(true);
			}
		}
	});

	it('keeps English words that merely end in key', () => {
		// The flat rule has to treat an unrecognized `<x>key` as a credential,
		// because the space of credential qualifiers is open. The space of
		// ordinary words ending in "key" is closed, so it is an allowlist.
		for (const word of ['monkey', 'monkeys', 'donkey', 'turnkey', 'whiskey', 'jockey', 'hockey', 'lackey', 'malarkey', 'hotkey', 'hotkeys']) {
			expect(dropped(word), word).toBe(false);
		}
	});

	it('keeps the flat structural identities', () => {
		for (const word of ['userkey', 'primarykey', 'foreignkey', 'sortkey', 'partitionkey', 'rowkey', 'cachekey', 'publickey']) {
			expect(dropped(word), word).toBe(false);
		}
	});

	// The input-word exception has to work from BOTH sides. Leading-only missed
	// the trailing half, so `heldKeys` - the natural spelling of the held-key
	// state the exception exists to save - was still dropped.
	it('keeps the keyboard and game input family on either side of key', () => {
		for (const word of [
			'keyCode', 'keyDown', 'keyUp', 'keyPress', 'keyMap', 'keyBinding', 'keyFrame',
			'keyState', 'heldKeys', 'pressedKeys', 'arrowKeys', 'modifierKeys', 'keysDown',
			'keysHeld', 'onKeyDown', 'handleKeyDown', 'keyMapping', 'keyPresses', 'keyName'
		]) {
			expect(dropped(word), word).toBe(false);
		}
	});

	it('still drops a credential that merely sits next to an input word', () => {
		for (const word of ['keyMaterial', 'keyData', 'keyVault', 'keyMapToken', 'keyPressSecret']) {
			expect(dropped(word), word).toBe(true);
		}
	});

	// Removed once on the argument that the word pass already covered it. Counted,
	// that was wrong by a factor of fifty, on financial PII.
	it('drops the flat iban spellings', () => {
		for (const word of ['useriban', 'customeriban', 'payeeiban', 'accountiban', 'ibannumber', 'ibanaccount', 'ibanlast4', 'primaryiban']) {
			expect(dropped(word), word).toBe(true);
		}
	});
});

describe('structural key names keep riding a roster', () => {
	const identifiers = [
		'primaryKey', 'foreignKey', 'sortKey', 'partitionKey', 'rowKey', 'cacheKey',
		'publicKey', 'userKey', 'groupKey', 'compositeKey'
	];
	for (const name of identifiers) {
		it(`passes ${name}`, () => expect(dropped(name)).toBe(false));
	}

	it('never reaches the key rule for a word that merely contains "key"', () => {
		for (const name of ['monkey', 'keyboard', 'turnkey', 'donkey']) {
			expect(dropped(name), name).toBe(false);
		}
	});
});

describe('a sensitive token inside a longer word is not a match', () => {
	// The substring rule dropped every one of these. On a huddle or voice
	// surface the mic-state field is exactly what a presence roster carries.
	const ordinary = [
		'microphone', 'microphoneOn', 'microphoneEnabled', 'headphones',
		'phonetic', 'phoneticName', 'spinner', 'pinned', 'account', 'success',
		'accuracy', 'zip', 'zipCode', 'description', 'recipient', 'cardId', 'agentId'
	];
	for (const name of ordinary) {
		it(`passes ${name}`, () => expect(dropped(name)).toBe(false));
	}

	it('still drops the token when it IS the word', () => {
		for (const name of ['phone', 'phoneNumber', 'userPhone', 'token', 'sessionToken', 'pin', 'cc', 'ssn', 'dob']) {
			expect(dropped(name), name).toBe(true);
		}
	});
});

describe('the author family', () => {
	it('passes ordinary display identity', () => {
		for (const name of ['author', 'authorId', 'authorName', 'authoredAt', 'authors']) {
			expect(dropped(name), name).toBe(false);
		}
	});

	it('still drops real auth names', () => {
		for (const name of ['authorization', 'oauth', 'authToken', 'authentic', 'AUTH']) {
			expect(dropped(name), name).toBe(true);
		}
	});
});

describe('transport identity', () => {
	// Matching only the bare spellings left the IP crossing under every
	// qualified one.
	const transport = [
		'ip', 'clientIp', 'ipAddress', 'remoteIp', 'peerIp', 'ip_address', 'ipv4', 'ipv6',
		'address', 'clientAddress', 'remoteAddr', 'remote_addr', 'remoteAddress',
		'x-forwarded-for', 'xForwardedFor', 'forwardedFor',
		'x-original-forwarded-for', 'x-vercel-forwarded-for', 'x-envoy-external-address',
		'x-azure-clientip', 'x-forwarded-host',
		'userAgent', 'user-agent', 'referer', 'referrer', 'headers', 'url', 'requestId'
	];
	for (const name of transport) {
		it(`drops ${name}`, () => expect(dropped(name)).toBe(true));
	}

	it('does not eat the display fields that share those words', () => {
		// Matched whole rather than per word, because their words are ordinary:
		// `url` as a WORD takes avatarUrl and imageUrl, which is what a roster is
		// for; `address` takes shippingAddress and walletAddress; `header` takes
		// columnHeader. `host` is not matched at all - on a meeting surface
		// `host: true` is first-class identity, and the Host header is the
		// server's own name rather than anything about the client.
		for (const name of [
			'avatarUrl', 'imageUrl', 'profileUrl', 'hostId', 'host', 'hostName',
			'shippingAddress', 'walletAddress', 'addressBook', 'columnHeader',
			'sectionHeader', 'headerColor'
		]) {
			expect(dropped(name), name).toBe(false);
		}
	});

	it('drops qualified IP and addr fields in the flat spelling too', () => {
		// A flat database/JSON field has no word boundary: the word rule saw
		// `remoteIp`, `remote_ip` and `remote-ip`, but not `remoteip`.
		const families = [
			['remote', 'ip'], ['client', 'ip'], ['peer', 'ip'], ['socket', 'ip'],
			['source', 'ip'], ['local', 'ip'], ['public', 'ip'], ['private', 'ip'],
			['server', 'ip'], ['proxy', 'ip'], ['upstream', 'ip'],
			['downstream', 'ip'], ['cf', 'connecting', 'ip'],
			['true', 'client', 'ip'], ['fastly', 'client', 'ip'],
			['fly', 'client', 'ip'], ['x', 'client', 'ip'],
			['remote', 'addr'], ['client', 'addr'], ['peer', 'addr'],
			['socket', 'addr'], ['remote', 'ip', 'hash'], ['ip', 'last4'],
			['addr', 'family']
		];
		const cap = (word) => word[0].toUpperCase() + word.slice(1);
		for (const parts of families) {
			const spellings = [
				parts.join(''),
				parts[0] + parts.slice(1).map(cap).join(''),
				parts.join('_'),
				parts.join('-'),
				parts.join('_').toUpperCase()
			];
			for (const spelling of spellings) {
				expect(dropped(spelling), spelling).toBe(true);
			}
		}
	});

	it('does not mistake ordinary flat words containing ip for transport data', () => {
		// The flat repair must recover a high-signal boundary, not turn `ip`
		// into a substring rule.
		for (const name of [
			'zip', 'shipping', 'relationship', 'ownership', 'leadership',
			'snippet', 'iphone', 'ipad', 'ipod', 'ipfs', 'clientiphone'
		]) {
			expect(dropped(name), name).toBe(false);
		}
	});

	it('still drops the bare transport spellings those rules exist for', () => {
		for (const name of ['address', 'addresses', 'remoteAddress', 'ipAddress', 'headers', 'header']) {
			expect(dropped(name), name).toBe(true);
		}
	});
});

describe('the default projections', () => {
	let platform;
	beforeEach(() => { platform = mockPlatform(); });

	it('does not let an own toJSON replace the projected subtree', () => {
		// `typeof fn === 'object'` is false, so a function value used to be
		// copied verbatim - and JSON.stringify then calls toJSON and returns
		// whatever it likes, defeating every name check at serialize time.
		const p = createPresence({ heartbeat: 0 });
		const hostile = {
			id: 'u1',
			profile: {
				name: 'Bob',
				toJSON() { return { email: 'victim@example.com', sessionToken: 'sk_live_deadbeef' }; }
			}
		};
		p.join(mockWs(hostile), 'room', platform);

		const wire = JSON.stringify(platform.published) + JSON.stringify(platform.sent) + JSON.stringify(p.list('room'));
		expect(wire).not.toContain('victim@example.com');
		expect(wire).not.toContain('sk_live_deadbeef');
	});

	it('does not let an own toJSON replace a cursor catalog subtree', () => {
		// Cursor carries the same projected userData on its catalog lane, so the
		// presence-only regression did not prove the second implementation.
		const cursors = createCursor({ throttle: 0, topicThrottle: 0 });
		const hostile = {
			id: 'u1',
			profile: {
				name: 'Bob',
				toJSON() { return { email: 'victim@example.com', sessionToken: 'sk_live_deadbeef' }; }
			}
		};
		cursors.update(mockWs(hostile), 'board', { x: 1, y: 2 }, platform);

		const wire = JSON.stringify(platform.published) + JSON.stringify(platform.sent) + JSON.stringify(cursors.list('board'));
		expect(wire).not.toContain('victim@example.com');
		expect(wire).not.toContain('sk_live_deadbeef');
	});

	it('does not let Array Symbol.species manufacture a toJSON bypass', () => {
		class HostileResult extends Array {
			toJSON() {
				return { email: 'victim@example.com', sessionToken: 'sk_live_deadbeef' };
			}
		}
		class HostileInput extends Array {
			static get [Symbol.species]() { return HostileResult; }
		}
		const items = new HostileInput();
		items.push({ label: 'safe' });

		const p = createPresence({ heartbeat: 0 });
		p.join(mockWs({ id: 'p1', items }), 'room', platform);

		const cursors = createCursor({ throttle: 0, topicThrottle: 0 });
		cursors.update(
			mockWs({ id: 'c1', items }),
			'board',
			{ x: 1, y: 2 },
			platform
		);

		const wire =
			JSON.stringify(p.list('room')) +
			JSON.stringify(cursors.list('board')) +
			JSON.stringify(platform.published) +
			JSON.stringify(platform.sent);
		expect(wire).not.toContain('victim@example.com');
		expect(wire).not.toContain('sk_live_deadbeef');
		expect(wire).toContain('safe');
	});

	it('contains hostile object-introspection traps on both projection paths', () => {
		const traps = [
			() => {
				const value = { label: 'hidden' };
				Object.defineProperty(value, Symbol.toStringTag, {
					get() { throw new Error('tag trap'); }
				});
				return value;
			},
			() => new Proxy({ label: 'hidden' }, {
				ownKeys() { throw new Error('ownKeys trap'); }
			}),
			() => {
				const value = [];
				Object.defineProperty(value, '0', {
					enumerable: true,
					get() { throw new Error('array getter trap'); }
				});
				value.length = 1;
				return value;
			}
		];

		for (let i = 0; i < traps.length; i++) {
			const p = createPresence({ heartbeat: 0 });
			const presencePlatform = mockPlatform();
			expect(() => {
				p.join(mockWs({ id: `p${i}`, nested: traps[i]() }), `room${i}`, presencePlatform);
			}).not.toThrow();
			expect(p.list(`room${i}`)[0].id).toBe(`p${i}`);

			const cursors = createCursor({ throttle: 0, topicThrottle: 0 });
			const cursorPlatform = mockPlatform();
			expect(() => {
				cursors.update(
					mockWs({ id: `c${i}`, nested: traps[i]() }),
					`board${i}`,
					{ x: i },
					cursorPlatform
				);
			}).not.toThrow();
			expect(cursors.list(`board${i}`)[0].user.id).toBe(`c${i}`);
		}
	});

	it('sends a Date as an ISO string rather than an empty object', () => {
		// The previous passthrough default produced an ISO string; the recursive
		// walk saw no enumerable own keys and produced `{}`.
		const p = createPresence({ heartbeat: 0 });
		p.join(mockWs({ id: 'u1', joinedAt: new Date('2026-07-27T10:00:00.000Z') }), 'room', platform);
		expect(p.list('room')[0].joinedAt).toBe('2026-07-27T10:00:00.000Z');
	});

	it('drops a Map or Set rather than misrepresenting it as {}', () => {
		const p = createPresence({ heartbeat: 0 });
		p.join(mockWs({ id: 'u1', tags: new Set(['a']), meta: new Map([['k', 'v']]) }), 'room', platform);
		const entry = p.list('room')[0];
		expect(entry.tags).toBeUndefined();
		expect(entry.meta).toBeUndefined();
	});

	it('reports a dropped field once instead of dropping it in silence', () => {
		// The warn-once latch is deliberately PROCESS-global and capped at 32
		// distinct names - correct for a server, where the point is to say it
		// once and never let a client-influenced name drive an unbounded log.
		// That makes it shared state across test FILES: vitest reuses a worker
		// process, so a suite that ran earlier and dropped 32 names of its own
		// leaves this one observing silence. It passed alone and failed in a
		// full serial run, which is the worst shape a failure can have. Clearing
		// it here asserts against a known starting point rather than against
		// whatever ran first.
		delete (/** @type {any} */ (globalThis))[Symbol.for('adapter-uws.projection.dropped-field-warnings')];
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const p = createPresence({ heartbeat: 0 });
			// A name the rules drop conservatively - nothing secret in it, which
			// is exactly why an app needs to be told.
			p.join(mockWs({ id: 'u1', tokenCount: 12 }), 'room', platform);
			p.join(mockWs({ id: 'u2', tokenCount: 13 }), 'room', platform);
			const mentions = warn.mock.calls.filter((c) => String(c[0]).includes('tokenCount'));
			expect(mentions.length, 'expected exactly one warning for the dropped field').toBe(1);
			expect(String(mentions[0][0])).toContain('select');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('cursor bounds client data by depth as well as size', () => {
	it('rejects a deeply nested payload that is comfortably under the byte cap', () => {
		// Nesting costs about two bytes a level, so 8 KB of client JSON reaches
		// thousands of levels while structuredClone - the cluster relay's
		// serializer - overflows around 1834 and takes the worker with it.
		let deep = [];
		for (let i = 0; i < 4000; i++) deep = [deep];
		expect(Buffer.byteLength(JSON.stringify(deep))).toBeLessThan(8192);
		expect(exceedsDepth(deep, MAX_PROJECTION_DEPTH)).toBe(true);

		const platform = mockPlatform();
		const cursors = createCursor({ throttle: 0 });
		const ws = mockWs({ id: 'u1' });
		cursors.update(ws, 'board', deep, platform);

		const stored = JSON.stringify(cursors.list('board'));
		expect(stored).not.toContain('[[[[');
	});

	it('still accepts an ordinary cursor payload', () => {
		const platform = mockPlatform();
		const cursors = createCursor({ throttle: 0 });
		cursors.update(mockWs({ id: 'u1' }), 'board', { x: 10, y: 20 }, platform);
		expect(cursors.list('board').length).toBe(1);
	});
});
