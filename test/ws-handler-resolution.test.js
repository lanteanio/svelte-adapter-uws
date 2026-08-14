// Which module becomes the WebSocket handler, and who gets to decide.
//
// The Vite plugin and the adapter both resolve a handler, and the plugin
// resolves FIRST: it emits `ws-handler.js` into the SSR output and the adapter
// then takes that file as it stands. So `websocket.handler` used to be dropped
// in silence whenever the plugin was installed - which is the setup the adapter
// itself recommends - and the app silently ran whatever auto-discovery found.
//
// That is not a configuration nicety. The module that wins decides which hooks
// the app has, and an app-supplied `subscribe` hook stands the server-grant
// model down (see src/runtime/handler/subscribe-hooks.js), so a substitution
// can disarm a gate the operator explicitly armed.
//
// The artifact test below therefore asserts on the BUILT BUNDLE, not on the
// adapter's normalized options: the option object was always correct: it was
// simply never read, so an options-level assertion stays green against the bug.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import adapter, { assertBundledHandlerMatches, readHandlerOrigin, assertBundledMetricsMatches, readMetricsOrigin } from '../src/index.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS } from './helpers/real-runtime.js';
import { variantOut, FIXTURE_VARIANTS } from './fixture/variants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(ROOT, 'test/fixture');

describe('adapter exposes websocket.handler to the Vite plugin', () => {
	it('publishes the configured handler on the adapter object', () => {
		// The plugin reads this off `config.kit.adapter` because it resolves
		// before the adapter runs and has no other way to see the option.
		expect(adapter({ websocket: { handler: './src/ws.js' } }).websocketHandler).toBe('./src/ws.js');
	});

	it('is null when no handler is configured', () => {
		expect(adapter({ websocket: true }).websocketHandler).toBeNull();
		expect(adapter({}).websocketHandler).toBeNull();
	});

	it('rejects a non-string handler at factory time', () => {
		// Reaches the plugin as config, so a misshaped value has to fail here
		// rather than as an opaque bundler resolve error later.
		expect(() => adapter({ websocket: { handler: 123 } })).toThrow(/must be a path string/);
	});
});

describe('assertBundledHandlerMatches', () => {
	const log = () => {
		const warnings = [];
		return { warn: (m) => warnings.push(m), warnings };
	};

	it('accepts agreement, including a differing relative spelling', () => {
		const l = log();
		expect(() =>
			assertBundledHandlerMatches('./src/hooks.ws.grant.js', { source: 'src/hooks.ws.grant.js', from: 'x' }, l)
		).not.toThrow();
		expect(l.warnings).toHaveLength(0);
	});

	it('throws when the bundled module is not the configured one', () => {
		// The exact defect: the option names one module, the build contains
		// another, and the old build log positively reported success.
		expect(() =>
			assertBundledHandlerMatches('./src/hooks.ws.grant.js', { source: 'src/hooks.ws.js', from: 'auto-discovered src/hooks.ws.js' }, log())
		).toThrow(/names a different module than the one that was built/);
	});

	it('names both modules in the error, so the fix is obvious from the message', () => {
		let message = '';
		try {
			assertBundledHandlerMatches('./a.js', { source: 'b.js', from: 'auto-discovered b.js' }, log());
		} catch (err) {
			message = err.message;
		}
		expect(message).toContain('./a.js');
		expect(message).toContain('b.js');
	});

	it('warns rather than throws when the plugin left no record', () => {
		// An app can write its own ws-handler.js, and a mismatched install
		// writes no marker. Unverifiable is not the same as wrong.
		const l = log();
		expect(() => assertBundledHandlerMatches('./src/ws.js', null, l)).not.toThrow();
		expect(l.warnings.join('\n')).toMatch(/cannot confirm/);
	});

	it('stays silent when no handler is configured', () => {
		const l = log();
		expect(() => assertBundledHandlerMatches(null, null, l)).not.toThrow();
		expect(l.warnings).toHaveLength(0);
	});
});

describe('readHandlerOrigin', () => {
	it('returns null for a directory with no marker', () => {
		expect(readHandlerOrigin(path.join(ROOT, 'test'))).toBeNull();
	});
});

describe('readMetricsOrigin', () => {
	it('returns null for a directory with no marker', () => {
		// A missing marker downgrades the origin check to a warning instead of
		// a refusal, so the reader pointing at the right filename is what keeps
		// the refusal path reachable at all.
		expect(readMetricsOrigin(path.join(ROOT, 'test'))).toBeNull();
	});
});

// The metrics registry rides the same plugin-emits-adapter-verifies mechanism
// as the handler, with a different stake: the module that wins is the registry
// INSTANCE every adapter counter lands on, so a silent substitution presents
// as counters frozen at zero on the scrape route rather than as an error.
describe('adapter exposes websocket.metrics to the Vite plugin', () => {
	it('publishes the configured module path on the adapter object', () => {
		expect(adapter({ websocket: { metrics: './src/m.js' } }).websocketMetrics).toBe('./src/m.js');
	});

	it('is null when no metrics module is configured', () => {
		expect(adapter({ websocket: true }).websocketMetrics).toBeNull();
		expect(adapter({}).websocketMetrics).toBeNull();
	});
});

describe('assertBundledMetricsMatches', () => {
	const log = () => {
		const warnings = [];
		return { warn: (m) => warnings.push(m), warnings };
	};

	it('accepts agreement, including a differing relative spelling', () => {
		const l = log();
		expect(() =>
			assertBundledMetricsMatches('./src/metrics.js', { source: 'src/metrics.js', from: 'x' }, l)
		).not.toThrow();
		expect(l.warnings).toHaveLength(0);
	});

	it('throws when the bundled module is not the configured one, naming both', () => {
		let message = '';
		try {
			assertBundledMetricsMatches('./a.js', { source: 'b.js', from: 'websocket.metrics in SvelteKit config' }, log());
		} catch (err) {
			message = err.message;
		}
		expect(message).toMatch(/names a different module than the one that was built/);
		expect(message).toContain('./a.js');
		expect(message).toContain('b.js');
	});

	it('warns rather than throws when the plugin left no record', () => {
		const l = log();
		expect(() => assertBundledMetricsMatches('./src/m.js', null, l)).not.toThrow();
		expect(l.warnings.join('\n')).toMatch(/cannot confirm/);
	});

	it('stays silent when no metrics module is configured', () => {
		const l = log();
		expect(() => assertBundledMetricsMatches(null, null, l)).not.toThrow();
		expect(l.warnings).toHaveLength(0);
	});
});

// The real proof. Everything above tests the guard; this tests that the option
// actually reaches the build, which is what was broken.
const describeBuild = hasUWS ? describe : describe.skip;

describeBuild('the built artifact honours websocket.handler through the Vite plugin', () => {
	it('bundles the module named on the adapter, not the auto-discovered one', () => {
		// The `grant` variant names its handler ONLY through the adapter's
		// `websocket.handler` (test/fixture/svelte.config.js); the fixture's
		// vite.config.js passes the plugin nothing. So if the plugin stops
		// honouring the adapter's option, auto-discovery picks up
		// src/hooks.ws.js and every assertion below flips.
		expect(FIXTURE_VARIANTS.grant.handler).toBe('./src/hooks.ws.grant.js');

		const built = buildFixtureOnce('grant');
		expect(built, 'grant fixture variant failed to build').toBe(true);

		const bundle = readFileSync(
			path.join(fixtureDir, variantOut('grant'), 'server/ws-handler.js'),
			'utf8'
		);

		// A marker unique to the named module...
		expect(bundle).toContain('resume-topics');
		// ...and one unique to the module auto-discovery would have picked.
		expect(bundle).not.toContain('cork-test');
	});

	it('carries the named handler plugin hook, not the auto-discovered authorization hook', () => {
		// The named handler now wraps a real groups-plugin side-effect hook and
		// preserves its marker. Its export is expected and does not disarm the
		// grant model; the differential suite proves that behavior. These bundle
		// markers distinguish it from src/hooks.ws.js, whose app authorization
		// hook would stand the armed gate down.
		expect(buildFixtureOnce('grant')).toBe(true);

		const bundle = readFileSync(
			path.join(fixtureDir, variantOut('grant'), 'server/ws-handler.js'),
			'utf8'
		);
		const exportList = /\bexport\s*\{([^}]*)\}/.exec(bundle);
		expect(exportList, 'bundled handler has no export statement to inspect').not.toBeNull();

		const names = exportList[1]
			.split(',')
			.map((entry) => entry.trim().split(/\s+as\s+/).pop().trim())
			.filter(Boolean);

		expect(names).toContain('upgrade');
		expect(names).toContain('subscribe');
		expect(bundle).toContain('policy-lobby');
		expect(bundle).toContain('hook-entered');
	});
});
