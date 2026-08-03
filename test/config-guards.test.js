// A configured protection must never be disabled in silence.
//
// Both surfaces read their flags out of a plain object, and both have shipped
// the same failure: something the surface does not recognize is dropped without
// a word, so the app runs without a protection it believes it configured. The
// first version of that was an unrecognized KEY. This pins the two remaining
// shapes of it - an unrecognized VALUE on a known key, and an unrecognized key
// on the dev plugin, which had no key checking at all.

import { describe, it, expect, vi } from 'vitest';
import { serializeWsOptions, unknownWebsocketOptionKeys, KNOWN_WEBSOCKET_OPTION_KEYS, KNOWN_NESTED_WEBSOCKET_OPTION_KEYS } from '../src/index.js';
import uws from '../src/vite.js';
import { createTestServer } from '../src/testing.js';

describe('a restrictive flag refuses a misshaped value rather than reading it as off', () => {
	// The reads are `=== true`, which treats every other value as "off". For a
	// PERMISSIVE flag that is harmless, because coercing lands on the safe
	// state. `authorizeWireSubscribe` is the inverted case: coercing lands on
	// "no enforcement", and the unknown-key warning cannot catch it because the
	// key is spelled correctly and only the value is wrong.
	for (const bad of ['1', 'true', 'yes', 1, 0, null, {}]) {
		it(`refuses authorizeWireSubscribe = ${JSON.stringify(bad)}`, () => {
			expect(() => serializeWsOptions({ authorizeWireSubscribe: bad }, false))
				.toThrow(/must be true, false, or 'strict'/);
		});
	}

	it("accepts true, false, 'strict', and absent", () => {
		expect(serializeWsOptions({ authorizeWireSubscribe: true }, false).authorizeWireSubscribe).toBe(true);
		expect(serializeWsOptions({ authorizeWireSubscribe: false }, false).authorizeWireSubscribe).toBe(false);
		expect(serializeWsOptions({ authorizeWireSubscribe: 'strict' }, false).authorizeWireSubscribe).toBe('strict');
		expect(serializeWsOptions({}, false).authorizeWireSubscribe).toBe(false);
	});

	it('points at the env-var spelling that motivates the guard', () => {
		// `process.env.X` is a string when set and undefined when not, so the
		// natural way to write this is off in BOTH cases - which is why the
		// message has to name the fix rather than just refuse.
		expect(() => serializeWsOptions({ authorizeWireSubscribe: 'on' }, false))
			.toThrow(/process\.env/);
	});

	it('refuses the same misshaped flag on the in-process testing surface', async () => {
		// A permissive test double against a restrictive production config is a
		// false-green tenancy test. Close the server if the guard regresses and the
		// call unexpectedly succeeds, so this red case never leaks a listener.
		let server;
		let thrown = null;
		try {
			server = await createTestServer({ authorizeWireSubscribe: /** @type {any} */ ('true') });
		} catch (error) {
			thrown = error;
		} finally {
			await server?.close();
		}
		expect(String(thrown)).toMatch(/must be true, false, or 'strict'/);
	});
});

describe('the dev plugin does not drop its options in silence', () => {
	// This bites harder in dev than in production: a typo leaves the dev server
	// wide open while the developer's own manual testing shows the app working,
	// so the mistake surfaces in production or not at all.

	it('refuses a misshaped authorizeWireSubscribe', () => {
		expect(() => uws({ authorizeWireSubscribe: 'true' })).toThrow(/must be true, false, or 'strict'/);
	});

	it("accepts strict authorization on the dev surface", () => {
		expect(() => uws({ authorizeWireSubscribe: 'strict' })).not.toThrow();
	});

	it('warns on an unrecognized option key', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			uws({ authorizeWireSubcribe: true });
			expect(warn, 'a typo must not be dropped silently').toHaveBeenCalled();
			expect(String(warn.mock.calls[0][0])).toMatch(/authorizeWireSubcribe/);
		} finally {
			warn.mockRestore();
		}
	});

	it('stays quiet for every option the plugin documents', () => {
		// Drift guard in the other direction: if the known-key set falls behind
		// the documented type, a legitimate config starts warning. Keeping this
		// list here means adding an option to one place and not the other fails.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			uws({
				path: '/ws',
				handler: './src/hooks.ws.js',
				authPath: '/__ws/auth',
				allowedOrigins: '*',
				allowSystemTopicSubscribe: true,
				allowNonAsciiTopics: true,
				authPathRequireOrigin: false,
				authorizeWireSubscribe: true,
				devSkipOriginCheck: true,
				timeoutMs: 1000
			});
			expect(warn, 'a fully documented config must not warn').not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

// The same silent-disable in a NUMERIC option. The rate limits are read as
// `x ?? default` and then compared with `>` / `>=`, and every comparison
// against a non-number is false - so a misshaped value does not fall back to
// the default, it turns the limiter off and says nothing.
describe('an option that sizes a rate limit refuses a misshaped value', () => {
	const cases = [
		'upgradeRateLimit',
		'upgradeRateLimitWindow',
		'authPathRateLimit',
		'authPathRateLimitWindow',
		// The SIZE and TIMEOUT bounds are protective on the same terms, and
		// unlike the limits they are handed straight to uWS, which never
		// validates them back. The guard used to stop at the rate limits, so
		// these serialized into the build as strings with no warning.
		'maxPayloadLength',
		'maxBackpressure',
		'idleTimeout',
		'upgradeTimeout'
	];

	for (const key of cases) {
		it(`${key} refuses a string`, () => {
			// `authPathRateLimit: process.env.AUTH_LIMIT` is the natural way to
			// write it, and it is a string when set.
			expect(() => serializeWsOptions({ [key]: '30' }, false)).toThrow(/must be a number/);
		});

		it(`${key} refuses NaN`, () => {
			// What `Number(process.env.MISSING)` produces.
			expect(() => serializeWsOptions({ [key]: NaN }, false)).toThrow(/must be a number/);
		});

		it(`${key} refuses a negative number`, () => {
			expect(() => serializeWsOptions({ [key]: -1 }, false)).toThrow(/must be a number/);
		});

		// Zero INVERTS these two rather than disabling them, measured against
		// the real uWS binary: `maxBackpressure: 0` means unlimited buffering
		// (99.75 MB for one slow client against 1.00 MB at the default), and
		// `maxPayloadLength: 0` closes the connection on any message.
		if (key === 'maxBackpressure' || key === 'maxPayloadLength') {
			it(`${key} refuses 0, which inverts the option rather than disabling it`, () => {
				expect(() => serializeWsOptions({ [key]: 0 }, false)).toThrow(/must be greater than 0/);
			});
			it(`${key} accepts a positive number`, () => {
				expect(() => serializeWsOptions({ [key]: 4096 }, false)).not.toThrow();
			});
			if (key === 'maxPayloadLength') {
				// The receiver stores this bound in a fixed-width integer, so a
				// larger or fractional value is truncated there while the
				// configured figure is what gets reported - a ~4-million-fold
				// lie in the measured 2**32 case, the report-versus-enforce
				// split in the opposite direction.
				it(`${key} refuses a value above the 32-bit ceiling`, () => {
					expect(() => serializeWsOptions({ [key]: 2 ** 32 + 1024 }, false))
						.toThrow(/integer no greater than 2147483647/);
				});
				it(`${key} refuses a fractional value`, () => {
					expect(() => serializeWsOptions({ [key]: 1024.5 }, false))
						.toThrow(/integer no greater than 2147483647/);
				});
				it(`${key} accepts the exact ceiling`, () => {
					expect(() => serializeWsOptions({ [key]: 0x7fffffff }, false)).not.toThrow();
				});
			}
		} else if (key.endsWith('Window')) {
			it(`${key} refuses 0, which breaks the limiter rather than disabling it`, () => {
				// A zero window makes every request look like a fresh window, so
				// the sliding estimate evaluates to NaN and `NaN >= limit` is
				// false - everything is admitted. It reads like "off" and does
				// the opposite of what the limit's own 0 does.
				expect(() => serializeWsOptions({ [key]: 0 }, false)).toThrow(/greater than 0/);
			});
		} else {
			it(`${key} accepts 0, which disables it deliberately`, () => {
				expect(() => serializeWsOptions({ [key]: 0 }, false)).not.toThrow();
			});
		}

		it(`${key} accepts a number and absence`, () => {
			expect(() => serializeWsOptions({ [key]: 30 }, false)).not.toThrow();
			expect(() => serializeWsOptions({}, false)).not.toThrow();
		});
	}
});

// The third shape: a key that is spelled wrong one level DOWN. The top-level
// walk could not see it, and for upgradeAdmission that is not cosmetic - every
// gate reads `maxConcurrent > 0`, so one transposed letter leaves the
// concurrency ceiling, the cursor lane and the waiting room all switched off.
describe('an unknown key nested inside an option object is reported', () => {
	it('reports a typo in upgradeAdmission by its full path', () => {
		expect(unknownWebsocketOptionKeys({ upgradeAdmission: { maxConcurent: 500 } }))
			.toEqual(['upgradeAdmission.maxConcurent']);
	});

	it('reports a typo two levels down, in the waiting room', () => {
		expect(unknownWebsocketOptionKeys({ upgradeAdmission: { waitingRoom: { pth: '/q' } } }))
			.toEqual(['upgradeAdmission.waitingRoom.pth']);
	});

	it('reports a typo in a pressure threshold', () => {
		expect(unknownWebsocketOptionKeys({ pressure: { psiCpuSum: 60 } }))
			.toEqual(['pressure.psiCpuSum']);
	});

	it('stays quiet for a fully correct nested config', () => {
		expect(unknownWebsocketOptionKeys({
			upgradeAdmission: {
				maxConcurrent: 500,
				maxConnections: 5000,
				perTickBudget: 50,
				maxDeferred: 1024,
				cursorLane: { fraction: 0.25 },
				waitingRoom: {
					path: '/q',
					admitCheckPath: '/a',
					pollIntervalMs: 2000,
					retryAfterSeconds: 2,
					renderer: './src/lib/server/waiting-room.js',
					appName: 'Example App',
					statusUrl: '/status',
					supportUrl: '/help',
					incidentId: 'INC-42'
				}
			},
			pressure: { memoryHeapUsedRatio: 0.9, psiCpuSome: 60 }
		})).toEqual([]);
	});

	it.each([-1, 1.5, Number.POSITIVE_INFINITY, '500', null])(
		'refuses upgradeAdmission.maxConnections = %p before serializing the build',
		(value) => {
			expect(() => serializeWsOptions({
				upgradeAdmission: { maxConnections: value }
			}, false)).toThrow(/maxConnections must be a non-negative safe integer/);
		}
	);

	it('accepts a finite maxConnections ceiling and the explicit disabled value', () => {
		expect(serializeWsOptions({
			upgradeAdmission: { maxConnections: 5000 }
		}, false).upgradeAdmission.maxConnections).toBe(5000);
		expect(() => serializeWsOptions({
			upgradeAdmission: { maxConnections: 0 }
		}, false)).not.toThrow();
	});

	it.each([-1, 1.5, Number.POSITIVE_INFINITY, '1024', null])(
		'refuses upgradeAdmission.maxDeferred = %p before serializing the build',
		(value) => {
			expect(() => serializeWsOptions({
				upgradeAdmission: { perTickBudget: 64, maxDeferred: value }
			}, false)).toThrow(/maxDeferred must be a non-negative safe integer/);
		}
	);

	it('accepts a finite maxDeferred ceiling and explicit no-queue value', () => {
		expect(serializeWsOptions({
			upgradeAdmission: { perTickBudget: 64, maxDeferred: 1024 }
		}, false).upgradeAdmission.maxDeferred).toBe(1024);
		expect(() => serializeWsOptions({
			upgradeAdmission: { perTickBudget: 64, maxDeferred: 0 }
		}, false)).not.toThrow();
	});

	it('does not walk a section that was disabled outright', () => {
		expect(unknownWebsocketOptionKeys({ upgradeAdmission: { maxConcurrent: 5, waitingRoom: false } }))
			.toEqual([]);
	});

	it('still reports an unknown top-level key by its bare name', () => {
		expect(unknownWebsocketOptionKeys({ bogus: 1 })).toEqual(['bogus']);
	});

	it('reports a typo in workers, which would silently run zero compute workers', () => {
		expect(unknownWebsocketOptionKeys({ workers: { comptue: 2 } })).toEqual(['workers.comptue']);
		expect(unknownWebsocketOptionKeys({ workers: { compute: 2 } })).toEqual([]);
	});

	it('reports a typo in postureExport without touching its string form', () => {
		expect(unknownWebsocketOptionKeys({ postureExport: { pth: '/x' } })).toEqual(['postureExport.pth']);
		expect(unknownWebsocketOptionKeys({ postureExport: '/x' })).toEqual([]);
		expect(unknownWebsocketOptionKeys({ postureExport: { path: '/x' } })).toEqual([]);
	});

	it('covers every nested section named in the table', () => {
		// Guards the table itself: a section listed as walkable but spelled
		// differently from the option would silently stop being checked.
		for (const path of Object.keys(KNOWN_NESTED_WEBSOCKET_OPTION_KEYS)) {
			const [top] = path.split('.');
			expect(KNOWN_WEBSOCKET_OPTION_KEYS.has(top), `${top} is not a known websocket option`).toBe(true);
		}
	});
});

describe('the payload ceiling is one guard, not three copies of it', () => {
	// All three surfaces hand the receiver limit to something that stores it in
	// a signed 32-bit integer, so a larger or fractional value is truncated
	// there while the configured figure is what gets reported back. Each surface
	// used to carry its own spelling of the check: production called the shared
	// guard, the dev plugin called it WITHOUT a ceiling and then repeated the
	// bound by hand afterwards, and createTestServer had a third hand-rolled
	// copy. Three copies is three chances for the bound to drift, so the refusal
	// message is asserted here too - a surface that stops routing through the
	// shared guard can still refuse, but not in these words.
	const SHARED_REFUSAL = /must be an integer no greater than 2147483647, because the receiver stores this bound in a fixed-width integer/;

	for (const value of [2 ** 32 + 1024, 1024.5]) {
		it(`production refuses ${value} through the shared guard`, () => {
			expect(() => serializeWsOptions({ maxPayloadLength: value }, false)).toThrow(SHARED_REFUSAL);
		});

		it(`the dev plugin refuses ${value} through the shared guard`, () => {
			expect(() => uws({ maxPayloadLength: value })).toThrow(SHARED_REFUSAL);
		});

		it(`createTestServer refuses ${value} through the shared guard`, async () => {
			await expect(createTestServer({ maxPayloadLength: value })).rejects.toThrow(SHARED_REFUSAL);
		});
	}

	// The boundary itself is admitted everywhere, so the guard is a ceiling and
	// not a blanket refusal that would pass the cases above for the wrong reason.
	it('every surface admits the exact ceiling', async () => {
		expect(() => serializeWsOptions({ maxPayloadLength: 0x7fffffff }, false)).not.toThrow();
		expect(() => uws({ maxPayloadLength: 0x7fffffff })).not.toThrow();
		const server = await createTestServer({ maxPayloadLength: 0x7fffffff });
		try {
			expect(server.platform.maxPayloadLength).toBe(0x7fffffff);
		} finally {
			await server.close();
		}
	});
});
