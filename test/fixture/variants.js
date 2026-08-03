// Build-time adapter configurations for the fixture app.
//
// Options like `authorizeWireSubscribe` are baked into the generated handler at
// build time, so a suite that needs one cannot reuse a build made without it.
// Each variant therefore builds the same app with a different adapter config
// into its OWN output directory, so the variants coexist instead of
// overwriting each other and switching between them costs no rebuild.
//
// Shared by svelte.config.js (which config to build) and the test harness
// (where the output lands), so the two cannot drift apart.

export const FIXTURE_VARIANTS = {
	// The long-standing default. Several suites already boot `build/`, so this
	// entry must keep both its output directory and its options unchanged.
	default: {
		out: 'build',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// Wire-subscribe authorization ARMED.
	//
	// Pointed at a handler whose `subscribe` export wraps a real groups-plugin
	// side-effect hook and preserves its marker. Unlike an app authorization
	// hook, that export does not take the topic decision back from the
	// server-grant model, so the armed gate remains decisive while the fixture
	// can exercise a plugin-owned namespace.
	//
	// The handler is named only through the adapter's `websocket.handler` (see
	// svelte.config.js), which is what an app would do. That also makes this
	// variant the regression test for the option surviving the Vite plugin: if
	// the plugin stops honoring it, auto-discovery builds src/hooks.ws.js, its
	// authorization hook stands the armed gate down, and the grant suites fail.
	grant: {
		out: 'build-grant',
		handler: './src/hooks.ws.grant.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			authorizeWireSubscribe: true
		}
	},

	// A configured tracing module with the wrong export shape. The build itself
	// succeeds, then importing the generated server runtime must fail loudly
	// instead of silently disabling tracing.
	badtracing: {
		out: 'build-bad-tracing',
		handler: null,
		tracing: './src/tracing.invalid.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// Linux external-respawner drill: a dedicated handler can wedge exactly one
	// clustered I/O worker on an authenticated test token. Its separate output
	// keeps the fault-injection hook out of every ordinary fixture build.
	respawner: {
		out: 'build-respawner',
		handler: './src/hooks.ws.respawner.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 0
		}
	},

	// Strict wire authorization with an ordinary application subscribe hook.
	// The hook allows every topic, so only the server-grant half can refuse a
	// cross-tenant raw subscribe - the hybrid permissive-hook bypass.
	strictgrant: {
		out: 'build-strict-grant',
		handler: './src/hooks.ws.strict-grant.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			authorizeWireSubscribe: 'strict'
		}
	},

	// Handshake header injection: the handler echoes a client-supplied value
	// into a response header on the 101, using the duck-typed shape that skips
	// the helper's construction-time validation, so the runtime's own pre-write
	// check is what decides.
	crlf: {
		out: 'build-crlf',
		handler: './src/hooks.ws.crlf.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// A `subscribeBatch` hook that PARKS on demand, so a revocation can be landed
	// inside the batch path's begin/settle window - the window the tombstone
	// exists for. See src/hooks.ws.park.js for why a real suspension is required.
	park: {
		out: 'build-park',
		handler: './src/hooks.ws.park.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// A parking `subscribe` hook that releases INTO a group join - so the
	// revoked attempt's own hook installs tracked membership inside the
	// begin/settle window, and the landing finds the topic held. The
	// provenance read (settleHeldSubscribe) is what must still honor the
	// revocation. See src/hooks.ws.parkjoin.js.
	parkjoin: {
		out: 'build-parkjoin',
		handler: './src/hooks.ws.parkjoin.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// A parking `subscribeBatch` PLUS a `resume` hook, so the recover lane is
	// open and its decision is observable. Separate from `park` because the
	// mere existence of a `resume` export opens that lane for every suite built
	// against the variant, which would change what `park` is testing.
	recover: {
		out: 'build-recover',
		handler: './src/hooks.ws.recover.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// Wire-subscribe authorization ARMED, with the documented presence wiring on
	// top. Presence's subscribe hook is marked a side effect, so unlike an app's
	// own hook it does NOT stand the gate down - which is what makes the batch
	// path's hook ordering observable: a denied topic must not reach the hook,
	// because the hook joins a roster and opens an observer tap.
	batchleak: {
		out: 'build-batchleak',
		handler: './src/hooks.ws.batchleak.js',
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			authorizeWireSubscribe: true
		}
	},

	// Also byte-identical to `default`, and for the same reason as `tls` below:
	// its own OUTPUT DIRECTORY, so its own module.
	//
	// The suites using this one boot with `ADDRESS_HEADER` set, which the runtime
	// reads at module eval. Sharing `default` with the suites that need it ABSENT
	// meant whichever ran first in a worker decided for both - silently, since a
	// suite testing per-address rate limiting against a server that ignores the
	// header still produces plausible-looking numbers. Two of them were made to
	// fail that way, and the reverse order passed while testing the wrong server,
	// which is the worse outcome.
	addrhdr: {
		out: 'build-addrhdr',
		handler: null,
		websocket: {
			allowedOrigins: 'same-origin',
			upgradeRateLimit: 100,
			// Keep the wire-level key-bound assertions inside one window even on
			// slow shared CI runners.
			upgradeRateLimitWindow: 60
		}
	},

	// Byte-identical to `default`, and that is the point: this variant exists for
	// its OUTPUT DIRECTORY, not for its options.
	//
	// TLS is configured through the ENVIRONMENT, which the runtime reads once at
	// module eval - and Node's ESM cache is keyed by module URL PER PROCESS,
	// while vitest reuses a worker process across test files. So a suite that
	// boots TLS in-process by importing `build/handler.js` leaves that module
	// evaluated as an SSLApp for every later suite in the same worker: they call
	// `startRealRuntime` with no SSL env, get the cached HTTPS runtime anyway,
	// and their `ws://` client dies with a bare `socket hang up`. That is a
	// failure that only reproduces under full parallelism and reads as a real
	// defect in the code under test.
	//
	// Module identity is the only isolation Node's cache respects, so the
	// in-process TLS suite gets its own. Its sibling `tls-watch` needs no variant
	// because it spawns a child process with a scrubbed env.
	tls: {
		out: 'build-tls',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// Metrics registry wired, so counters that are otherwise no-ops become
	// observable over the /metrics route. Without this, a counter-based
	// assertion reads zero whether or not the code under test ever fired.
	metrics: {
		out: 'build-metrics',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			metrics: './src/metrics.js'
		}
	},

	// Cross-worker state-hash reporting armed on a tight interval, so a real
	// clustered runtime can prove the aggregate detector, the primary's
	// bounded detail collection, and the replicated diagnostic store - the
	// production wiring the pure divergence-diagnostics unit tests cannot
	// reach.
	divergence: {
		out: 'build-divergence',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			stateHashIntervalMs: 50
		}
	},

	// Current `sv create` projects pass SvelteKit configuration directly to
	// `sveltekit(...)` in Vite config. This is deliberately the same runtime
	// posture as default but has its own output/module identity and exercises
	// that consolidated configuration path end to end.
	consolidated: {
		out: 'build-consolidated',
		configStyle: 'consolidated',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100
		}
	},

	// Two total workers with one compute worker leave exactly one socket-owning
	// I/O worker. This is the supported clustered topology for the adapter's
	// single-home game sequencer and provides the positive control for the
	// multi-I/O rejection test.
	gamehome: {
		out: 'build-gamehome',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			workers: { compute: 1 }
		}
	},

	// A configured waitingRoom.renderer module path drives the whole
	// production pipeline: build-side validation, the isolated esbuild
	// renderer entry, the pick(default/renderWaitingRoom) selection, and the
	// bridge the runtime imports. Live-function renderer tests cannot reach
	// any of that - production refuses functions.
	waitingrenderer: {
		out: 'build-waiting-renderer',
		handler: null,
		websocket: {
			allowedOrigins: '*',
			upgradeRateLimit: 100,
			upgradeAdmission: {
				maxConcurrent: 4,
				waitingRoom: { renderer: './src/waiting-room.renderer.js' }
			}
		}
	}
};

/**
 * Output directory for a variant, relative to the fixture root.
 * @param {string} name
 * @returns {string}
 */
export function variantOut(name) {
	const variant = FIXTURE_VARIANTS[name];
	if (!variant) {
		throw new Error(`unknown fixture variant "${name}" (have: ${Object.keys(FIXTURE_VARIANTS).join(', ')})`);
	}
	return variant.out;
}
