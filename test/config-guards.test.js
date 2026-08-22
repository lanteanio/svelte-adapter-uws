// A configured protection must never be disabled in silence.
//
// Both surfaces read their flags out of a plain object, and both have shipped
// the same failure: something the surface does not recognize is dropped without
// a word, so the app runs without a protection it believes it configured. The
// first version of that was an unrecognized KEY. This pins the two remaining
// shapes of it - an unrecognized VALUE on a known key, and an unrecognized key
// on the dev plugin, which had no key checking at all.

import { describe, it, expect, vi } from 'vitest';
import {
	serializeWsOptions,
	unknownWebsocketOptionKeys,
	unknownAdapterOptionKeys,
	KNOWN_ADAPTER_OPTION_KEYS,
	KNOWN_WEBSOCKET_OPTION_KEYS,
	KNOWN_NESTED_WEBSOCKET_OPTION_KEYS
} from '../src/index.js';
import uws from '../src/vite.js';
import { createTestServer } from '../src/testing.js';
import { createUpgradeAdmission } from '../src/runtime/utils/upgrade-admission.js';
import { FIXTURE_VARIANTS } from './fixture/variants.js';

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

	it('warns on an unrecognized option key, naming the closest documented one', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			uws({ authorizeWireSubcribe: true });
			expect(warn, 'a typo must not be dropped silently').toHaveBeenCalled();
			expect(String(warn.mock.calls[0][0]))
				.toContain("authorizeWireSubcribe (did you mean 'authorizeWireSubscribe'?)");
		} finally {
			warn.mockRestore();
		}
	});

	it('warns on a casing slip with the documented spelling', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			uws({ AllowedOrigins: '*' });
			expect(String(warn.mock.calls[0][0]))
				.toContain("AllowedOrigins (did you mean 'allowedOrigins'?)");
		} finally {
			warn.mockRestore();
		}
	});

	it('offers no suggestion for a key nothing documented is close to', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			uws({ turboMode: true });
			const line = String(warn.mock.calls[0][0]);
			expect(line).toContain('turboMode');
			expect(line, 'a wrong guess in a warning is worse than none').not.toContain('did you mean');
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
				timeoutMs: 1000,
				egress: { windowMs: 1000, topic: { messages: 10 } }
			});
			expect(warn, 'a fully documented config must not warn').not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

// The same inversion in the graduated protection posture: the runtime builds
// the machine for any non-'normal' value but pins only a level it recognizes,
// so a misspelled pin does not fail and does not pin - it silently resolves
// the level from live pressure, which is 'auto' behavior under a config that
// asked for an incident-response freeze.
describe('the protection posture refuses a level the runtime would not pin', () => {
	const REFUSAL = /must be 'normal', 'auto', 'elevated', or 'siege'/;

	for (const bad of ['seige', 'Siege', 'on', '', false, true, 1, {}]) {
		it(`the build refuses protection = ${JSON.stringify(bad)}`, () => {
			expect(() => serializeWsOptions({ protection: bad }, false)).toThrow(REFUSAL);
		});
	}

	it('the build accepts every documented level and absence', () => {
		for (const level of ['normal', 'auto', 'elevated', 'siege']) {
			expect(serializeWsOptions({ protection: level }, false).protection).toBe(level);
		}
		expect(() => serializeWsOptions({}, false)).not.toThrow();
	});

	it('the dev plugin refuses the same misspelled level through the shared guard', () => {
		// The plugin does not honor `protection` (dev never engages admission
		// control), but the VALUE is judged before the unknown-key warning: a
		// level the production build refuses must not ride through `vite dev`.
		expect(() => uws({ protection: 'seige' })).toThrow(REFUSAL);
	});

	it('createTestServer refuses the same misspelled level through the shared guard', async () => {
		// Close the server if the guard regresses and the call unexpectedly
		// succeeds, so this red case never leaks a listener.
		let server;
		let thrown = null;
		try {
			server = await createTestServer({ protection: /** @type {any} */ ('seige') });
		} catch (error) {
			thrown = error;
		} finally {
			await server?.close();
		}
		expect(String(thrown)).toMatch(REFUSAL);
	});
});

// The origin policy has exactly three recognized forms; anything else falls
// through every branch of the runtime check and returns false - deny-all,
// reported by the build as a configured policy.
describe('the origin policy refuses a shape the runtime check cannot match', () => {
	const REFUSAL = /must be '\*', 'same-origin', or an array of origin strings/;

	for (const bad of ['same-orgin', 'any', '', true, 1, { origin: '*' }]) {
		it(`the build refuses allowedOrigins = ${JSON.stringify(bad)}`, () => {
			expect(() => serializeWsOptions({ allowedOrigins: bad }, false)).toThrow(REFUSAL);
		});
	}

	it('the build refuses a non-string allowlist entry, which can never match a header', () => {
		expect(() => serializeWsOptions({ allowedOrigins: ['https://example.com', /example/] }, false))
			.toThrow(/entries must be non-empty origin strings/);
		expect(() => serializeWsOptions({ allowedOrigins: [''] }, false))
			.toThrow(/entries must be non-empty origin strings/);
	});

	it('the build accepts the three documented forms and absence', () => {
		expect(() => serializeWsOptions({ allowedOrigins: '*' }, false)).not.toThrow();
		expect(() => serializeWsOptions({ allowedOrigins: 'same-origin' }, false)).not.toThrow();
		expect(() => serializeWsOptions({ allowedOrigins: ['https://example.com', 'null'] }, false)).not.toThrow();
		expect(serializeWsOptions({}, false).allowedOrigins).toBe('same-origin');
	});

	it('the dev plugin refuses the same misspelled policy through the shared guard', () => {
		expect(() => uws({ allowedOrigins: 'same-orgin' })).toThrow(REFUSAL);
	});

	it('names the falsy case for what it did: silently run the default, not deny', () => {
		// '' / false / 0 never reached the origin check - the runtime reads
		// the policy with a same-origin fallback - so the refusal must not
		// claim deny-all for them. They are refused for expressing no policy.
		for (const falsy of ['', false, 0]) {
			expect(() => serializeWsOptions({ allowedOrigins: falsy }, false))
				.toThrow(/silently runs the 'same-origin' default/);
		}
		expect(() => serializeWsOptions({ allowedOrigins: 'same-orgin' }, false))
			.toThrow(/refuse every origin-bearing connection/);
	});

	it('createTestServer refuses the same misspelled policy through the shared guard', async () => {
		// The harness does not honor allowedOrigins, but a value the build
		// refuses must not be certified green by a test suite.
		let server;
		let thrown = null;
		try {
			server = await createTestServer(/** @type {any} */ ({ allowedOrigins: 'same-orgin' }));
		} catch (error) {
			thrown = error;
		} finally {
			await server?.close();
		}
		expect(String(thrown)).toMatch(REFUSAL);
	});
});

// Compression coerces every truthy non-number to SHARED_COMPRESSOR, so the
// natural env spelling INVERTS: '0' and 'false' are truthy strings that turn
// compression ON.
describe('compression refuses a value the runtime would coerce to ON', () => {
	const REFUSAL = /must be a boolean or a uWS compression constant/;

	for (const bad of ['0', 'false', 'shared', 1.5, -1, NaN]) {
		it(`refuses compression = ${JSON.stringify(bad) ?? String(bad)}`, () => {
			expect(() => serializeWsOptions({ compression: bad }, false)).toThrow(REFUSAL);
		});
	}

	it('accepts booleans, uWS constants, and absence', () => {
		expect(serializeWsOptions({ compression: true }, false).compression).toBe(true);
		expect(serializeWsOptions({ compression: false }, false).compression).toBe(false);
		// uWS constants are non-negative integer bit sets; 0 is DISABLED.
		expect(serializeWsOptions({ compression: 0 }, false).compression).toBe(0);
		expect(serializeWsOptions({ compression: 2 }, false).compression).toBe(2);
		expect(serializeWsOptions({}, false).compression).toBe(false);
	});

	it('the dev plugin refuses the same inverted value through the shared guard', () => {
		// Dev delegates compression to the ws library and never honors the
		// key, but the value must not ride through `vite dev` and fail the
		// first production build.
		expect(() => uws({ compression: '0' })).toThrow(REFUSAL);
	});

	it('createTestServer refuses the same inverted value through the shared guard', async () => {
		let server;
		let thrown = null;
		try {
			server = await createTestServer(/** @type {any} */ ({ compression: '0' }));
		} catch (error) {
			thrown = error;
		} finally {
			await server?.close();
		}
		expect(String(thrown)).toMatch(REFUSAL);
	});
});

// The pressure thresholds fire on `sample >= threshold`, so a misshaped
// threshold never fires and the signal is silently gone; `false` is the
// documented deliberate disable and stays legal. The sample interval degrades
// differently - the runtime replaces anything under 100 or misshaped with the
// 1000 ms default - so a configured cadence would be silently ignored.
describe('a pressure threshold refuses a value that would silently stand the signal down', () => {
	it('refuses a string threshold', () => {
		expect(() => serializeWsOptions({ pressure: { memoryHeapUsedRatio: '0.9' } }, false))
			.toThrow(/websocket\.pressure\.memoryHeapUsedRatio must be false \(disable the signal\) or a number >= 0/);
	});

	it('refuses a negative threshold, which would fire permanently', () => {
		expect(() => serializeWsOptions({ pressure: { publishRatePerSec: -1 } }, false))
			.toThrow(/must be false \(disable the signal\) or a number >= 0/);
	});

	it('keeps the documented false disable and numeric tuning legal', () => {
		expect(() => serializeWsOptions({
			pressure: { memoryHeapUsedRatio: 0.9, subscriberRatio: false, psiCpuSome: 60 }
		}, false)).not.toThrow();
	});

	it('refuses a sample interval the runtime would silently replace with the default', () => {
		expect(() => serializeWsOptions({ pressure: { sampleIntervalMs: 50 } }, false))
			.toThrow(/sampleIntervalMs must be a number >= 100/);
		expect(() => serializeWsOptions({ pressure: { sampleIntervalMs: '1000' } }, false))
			.toThrow(/sampleIntervalMs must be a number >= 100/);
		expect(() => serializeWsOptions({ pressure: { sampleIntervalMs: 1000 } }, false)).not.toThrow();
	});

	it('refuses a sample interval above the 32-bit timer ceiling, which would overflow to 1 ms', () => {
		// A finite value above 2^31-1 passes a `>= 100` check and then
		// overflows Node's setInterval into the exact tight loop the floor
		// exists to prevent.
		expect(() => serializeWsOptions({ pressure: { sampleIntervalMs: 2 ** 31 } }, false))
			.toThrow(/no greater than 2147483647 milliseconds/);
		// Fractional milliseconds below the ceiling are a working setInterval
		// delay and must stay legal.
		expect(() => serializeWsOptions({ pressure: { sampleIntervalMs: 1000.5 } }, false)).not.toThrow();
	});

	it('refuses a pressure section that is not an object of thresholds', () => {
		expect(() => serializeWsOptions({ pressure: 'high' }, false))
			.toThrow(/websocket\.pressure must be an object of thresholds/);
		// `false` is spread away by the runtime (`false || {}`) and replaced by
		// the FULL default thresholds - sampling at complete default tuning
		// under a config that plainly meant "no pressure monitoring". Every
		// sub-threshold spells disable as `false`, so the section-level `false`
		// is exactly the silent degradation this guard exists for.
		expect(() => serializeWsOptions({ pressure: false }, false))
			.toThrow(/websocket\.pressure must be an object of thresholds/);
	});

	it('leaves an unknown pressure key to the unknown-key warning', () => {
		// A typo'd KEY is the warning's job; the value guard must not turn it
		// into a confusing value error.
		expect(() => serializeWsOptions({ pressure: { memoryHeapUsedRatioo: '0.9' } }, false)).not.toThrow();
		expect(unknownWebsocketOptionKeys({ pressure: { memoryHeapUsedRatioo: 0.9 } }))
			.toEqual(['pressure.memoryHeapUsedRatioo']);
	});

	it('the dev plugin refuses the same misshaped section through the shared guard', () => {
		// `pressure` is not a dev-plugin option; the key warns as unknown, but
		// the VALUE is judged by the same aggregate the build runs.
		expect(() => uws({ pressure: { sampleIntervalMs: 50 } }))
			.toThrow(/sampleIntervalMs must be a number >= 100/);
		expect(() => uws({ pressure: 'high' }))
			.toThrow(/must be an object of thresholds/);
	});
});

// The three observability timers ride the same interval guard: misshaped
// values were already refused on protective-number terms; the timer ceiling is
// the second half, because a finite value above 2^31-1 passes `> 0` and then
// overflows Node's setInterval into a 1 ms cadence - the auditor it was meant
// to slow down instead runs in the tightest loop the event loop allows.
describe('an observability interval refuses a delay the timer cannot hold', () => {
	for (const key of ['stateHashIntervalMs', 'consistencyAuditIntervalMs', 'resourceGrowthAuditIntervalMs']) {
		it(`refuses ${key} above the 32-bit timer ceiling`, () => {
			expect(() => serializeWsOptions({ [key]: 2 ** 31 }, false))
				.toThrow(/no greater than 2147483647 milliseconds/);
		});

		it(`keeps a fractional ${key} below the ceiling legal`, () => {
			// setInterval accepts fractional milliseconds; refusing them would
			// break a config that ran fine before the guard.
			expect(() => serializeWsOptions({ [key]: 30000.5 }, false)).not.toThrow();
		});
	}
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
		'upgradeTimeout',
		// The observability timers are read as `value > 0` at runtime, so a
		// misshaped interval silently disables the auditor or reporter it
		// configures; 0 stays the documented deliberate disable.
		'stateHashIntervalMs',
		'consistencyAuditIntervalMs',
		'resourceGrowthAuditIntervalMs'
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
		'refuses upgradeAdmission.maxConcurrent = %p before serializing the build',
		(value) => {
			// The gate reads `maxConcurrent > 0`, so a misshaped value does not
			// fall back - it leaves the handshake ceiling open in silence.
			expect(() => serializeWsOptions({
				upgradeAdmission: { maxConcurrent: value }
			}, false)).toThrow(/maxConcurrent must be a non-negative safe integer/);
		}
	);

	it('accepts a finite maxConcurrent ceiling and the explicit disabled value', () => {
		expect(serializeWsOptions({
			upgradeAdmission: { maxConcurrent: 500 }
		}, false).upgradeAdmission.maxConcurrent).toBe(500);
		expect(() => serializeWsOptions({
			upgradeAdmission: { maxConcurrent: 0 }
		}, false)).not.toThrow();
	});

	it.each([-1, 1.5, Number.POSITIVE_INFINITY, '64', null])(
		'refuses upgradeAdmission.perTickBudget = %p before serializing the build',
		(value) => {
			expect(() => serializeWsOptions({
				upgradeAdmission: { perTickBudget: value }
			}, false)).toThrow(/perTickBudget must be a non-negative safe integer/);
		}
	);

	it('accepts a finite perTickBudget and the explicit disabled value', () => {
		expect(serializeWsOptions({
			upgradeAdmission: { perTickBudget: 64 }
		}, false).upgradeAdmission.perTickBudget).toBe(64);
		expect(() => serializeWsOptions({
			upgradeAdmission: { perTickBudget: 0 }
		}, false)).not.toThrow();
	});

	it.each([true, false, 500, 'strict', ['maxConcurrent']])(
		'refuses an upgradeAdmission section of %p, off which no ceiling can be read',
		(value) => {
			// The gate reads its ceilings off the section object, so a bare
			// number or `true` configured nothing at all, in silence - and a
			// section of `false` crashed the worker at start, because the
			// runtime admission factory refuses `false` as a misshaped
			// ceiling. The build now refuses the section shape up front.
			expect(() => serializeWsOptions({
				upgradeAdmission: value
			}, false)).toThrow(/upgradeAdmission must be an object of admission ceilings/);
		}
	);

	it('reads a null upgradeAdmission section as absent on every layer', () => {
		// A JSON round trip or a config spread writes an unconfigured section
		// as null, and every config guard reads null as absent - so the build
		// must pass it AND the runtime admission factory must boot with it,
		// not refuse null as a misshaped ceiling and crash the worker at
		// start under a config the build passed.
		expect(() => serializeWsOptions({ upgradeAdmission: null }, false)).not.toThrow();
		// And the gate it builds is genuinely the disabled gate, not a
		// zero-ceiling one: acquisition always succeeds.
		const gate = createUpgradeAdmission(null);
		expect(gate.tryAcquire()).toBe(true);
		expect(gate.tryAcquireConnection()).toBe(true);
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

// The fourth shape of the silent drop: a key spelled wrong at the TOP level of
// the adapter options. Warned like the websocket.* keys - refusing would break
// an app pinning an older adapter under a config carrying a newer version's
// key - and each warning names the closest documented key, because the usual
// mistake is a casing slip or one transposed letter.
describe('an unknown top-level adapter option is reported with the closest documented key', () => {
	it('suggests the documented key for a one-letter slip', () => {
		expect(unknownAdapterOptionKeys({ precompres: true }))
			.toEqual(["precompres (did you mean 'precompress'?)"]);
	});

	it('suggests the documented key for a casing slip', () => {
		expect(unknownAdapterOptionKeys({ HealthCheckPath: '/healthz' }))
			.toEqual(["HealthCheckPath (did you mean 'healthCheckPath'?)"]);
	});

	it('points a websocket option typed at the top level to its nested home', () => {
		expect(unknownAdapterOptionKeys({ allowedOrigins: '*' }))
			.toEqual(["allowedOrigins (did you mean 'websocket.allowedOrigins'?)"]);
	});

	it('offers no suggestion for a key nothing documented is close to', () => {
		expect(unknownAdapterOptionKeys({ turboMode: true })).toEqual(['turboMode']);
	});

	it('stays quiet for every documented top-level option', () => {
		expect(unknownAdapterOptionKeys({
			out: 'build',
			precompress: true,
			envPrefix: '',
			healthCheckPath: '/healthz',
			readinessCheckPath: '/readyz',
			tracing: './src/lib/server/tracing.js',
			staticHeaders: {},
			staticCacheControl: [],
			staticDotfiles: false,
			websocket: true
		})).toEqual([]);
		expect(unknownAdapterOptionKeys(null)).toEqual([]);
		expect(unknownAdapterOptionKeys(undefined)).toEqual([]);
	});

	it('pins the known-key set literal so an edit to it is a conscious act', () => {
		// This pin only catches an accidental edit of the set itself - both
		// sides of the comparison are hand-written copies. The binding to the
		// factory's real intake is the AdapterOptions contract test
		// (test/websocket-option-contract.test.js), which parses the published
		// declaration and holds the set equal to it.
		expect([...KNOWN_ADAPTER_OPTION_KEYS].sort()).toEqual([
			'envPrefix', 'healthCheckPath', 'out', 'precompress', 'readinessCheckPath',
			'staticCacheControl', 'staticDotfiles', 'staticHeaders', 'tracing', 'websocket'
		]);
	});
});

// The control: a configuration that is valid today stays exactly as quiet as
// it was. Every new value guard has to coexist with the options the shipped
// examples and the fixture app already use.
describe('a config valid before the value guards stays silent', () => {
	it('serializes the fixture default variant untouched', () => {
		// Bound to the real variant object, not a hand copy, so a fixture
		// edit cannot silently unbind this control from the options the
		// booted suites actually build with.
		const serialized = serializeWsOptions(FIXTURE_VARIANTS.default.websocket, false);
		expect(serialized.allowedOrigins).toBe('*');
		expect(serialized.upgradeRateLimit).toBe(100);
	});

	it('serializes a fully tuned config without a warning-shaped key report', () => {
		const websocket = {
			allowedOrigins: ['https://example.com'],
			compression: true,
			protection: 'auto',
			stateHashIntervalMs: 30000,
			consistencyAuditIntervalMs: 5000,
			resourceGrowthAuditIntervalMs: 30000,
			pressure: { memoryHeapUsedRatio: 0.9, subscriberRatio: false, sampleIntervalMs: 1000 },
			upgradeAdmission: { maxConcurrent: 500, perTickBudget: 64, maxConnections: 5000 },
			egress: { windowMs: 1000, topic: { messages: 5000, bytes: 10_000_000, deliveries: 500_000 }, tenant: { messages: 2000 } }
		};
		expect(() => serializeWsOptions(websocket, false)).not.toThrow();
		expect(unknownWebsocketOptionKeys(websocket)).toEqual([]);
	});
});

// The egress ceilings are read as `value > 0` at runtime, so a misshaped
// ceiling does not fall back to a default - it leaves that ceiling silently
// open while the operator believes it is enforced. Same inversion as every
// guard above, on a new section; the guard is shared, so all three intake
// surfaces must refuse the same values.
describe('the egress section refuses values that would silently disable a ceiling', () => {
	it('refuses a non-object section on the build surface', () => {
		expect(() => serializeWsOptions({ egress: true }, false))
			.toThrow(/egress must be an object of publish-egress ceilings/);
	});

	for (const bad of ['5', -1, 1.5, NaN, Infinity, true]) {
		it(`refuses topic.messages = ${JSON.stringify(bad) ?? String(bad)}`, () => {
			expect(() => serializeWsOptions({ egress: { topic: { messages: bad } } }, false))
				.toThrow(/egress\.topic\.messages must be a non-negative safe integer/);
		});
	}

	it('refuses a tenant ceiling of the same shapes', () => {
		expect(() => serializeWsOptions({ egress: { tenant: { deliveries: '100' } } }, false))
			.toThrow(/egress\.tenant\.deliveries must be a non-negative safe integer/);
	});

	it('refuses a window below the floor and above the timer ceiling', () => {
		expect(() => serializeWsOptions({ egress: { windowMs: 50 } }, false))
			.toThrow(/egress\.windowMs must be a number >= 100/);
		expect(() => serializeWsOptions({ egress: { windowMs: 2 ** 31 } }, false))
			.toThrow(/no greater than 2147483647/);
	});

	it('refuses a tenantOf key in the section, naming the handler export', () => {
		// A function cannot survive the JSON round trip into the build, so a
		// resolver configured here would silently stand every tenant ceiling
		// down. The refusal points at the carrier that works.
		expect(() => serializeWsOptions({ egress: { tenantOf: () => 'acme' } }, false))
			.toThrow(/egressTenantOf/);
	});

	it('accepts 0 as the documented deliberate disable', () => {
		expect(() => serializeWsOptions({ egress: { windowMs: 1000, topic: { messages: 0, bytes: 0, deliveries: 0 } } }, false))
			.not.toThrow();
	});

	it('refuses the same misshaped section on the dev plugin surface', () => {
		expect(() => uws({ egress: { topic: { messages: '5' } } }))
			.toThrow(/egress\.topic\.messages must be a non-negative safe integer/);
	});

	it('refuses the same misshaped section on the testing surface', async () => {
		let server;
		let thrown = null;
		try {
			server = await createTestServer({ egress: /** @type {any} */ ({ topic: { bytes: -1 } }) });
		} catch (error) {
			thrown = error;
		} finally {
			if (server) server.close();
		}
		expect(String(thrown)).toMatch(/egress\.topic\.bytes must be a non-negative safe integer/);
	});

	it('reports an unknown nested egress key as its dotted path', () => {
		// Nested keys are reported by path (the top-level walk owns the
		// closest-match suggestion); the point is that a typo'd ceiling is
		// LOUD instead of a silently open ceiling.
		expect(unknownWebsocketOptionKeys({ egress: { topic: { deliverys: 10 } } }))
			.toEqual(['egress.topic.deliverys']);
	});
});
