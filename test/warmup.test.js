// Readiness-gated boot warmup.
//
// A cold SSR first render is ~20x a warm one (measured, recorded in
// source/shipped-log.md), the whole penalty is the render path warming up, and
// it lands on the first real client after every deploy. These tests pin the
// behavior that removes it: the option parses to a path list, the warmup
// renders the real SSR path in-process, and - the load-bearing guarantee - a
// booting process warms before its readiness probe ever reports ready.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import adapter from '../src/index.js';
import { hasUWS, freePort } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const describeUWS = hasUWS ? describe : describe.skip;

describe('the warmup option', () => {
	it('rejects a shape that is not false, true, or { paths: [...] }', () => {
		expect(() => adapter({ warmup: 'yes' })).toThrow(/warmup must be true, false/);
		expect(() => adapter({ warmup: 0 })).toThrow(/warmup must be true, false/);
	});

	it('rejects a paths entry that is not an absolute pathname', () => {
		expect(() => adapter({ warmup: { paths: ['no-slash'] } })).toThrow(/warmup\.paths/);
		expect(() => adapter({ warmup: { paths: [42] } })).toThrow(/warmup\.paths/);
	});

	it('accepts false, true, and a valid paths array without throwing at parse time', () => {
		// The adapter object is constructed lazily; building is what these would
		// trigger, so only the synchronous option parse is exercised here by
		// constructing the adapter (no adapt() call).
		expect(() => adapter({ warmup: false })).not.toThrow();
		expect(() => adapter({ warmup: true })).not.toThrow();
		expect(() => adapter({ warmup: { paths: ['/', '/dashboard'] } })).not.toThrow();
	});
});

describeUWS('the warmup render against the built runtime', () => {
	it('renders each configured path once and tags only its own requests', async () => {
		expect(buildFixtureOnce('default')).toBe(true);
		const handlerUrl = pathToFileURL(path.join(fixtureDir, variantOut('default'), 'handler.js')).href;
		const handler = await import(handlerUrl);

		// A real SSR render through the built server; the fixture '/' returns a
		// 200 page, so a successful warm counts it.
		const warmed = await handler.warmSSR(['/'], {});
		expect(warmed).toBe(1);

		// The tag is by object identity: a request the warmup did not construct
		// is never seen as synthetic, so a real client cannot forge one.
		expect(handler.isWarmupRequest(new Request('http://localhost/'))).toBe(false);
	}, 400000);

	it('a warmup path that never responds in time cannot hang readiness', async () => {
		expect(buildFixtureOnce('default')).toBe(true);
		const handlerUrl = pathToFileURL(path.join(fixtureDir, variantOut('default'), 'handler.js')).href;
		const handler = await import(handlerUrl);

		// The fixture's /slow-hold route holds its response open for 60s - far
		// past every warmup bound, and (as it happens) longer than SvelteKit
		// will interrupt for the request's abort signal. runWarmup is what
		// lifecycle awaits before the readiness flip, and its total-budget race
		// guarantees it resolves regardless: a build that names a slow route in
		// its warmup set does not brick its own readiness. (A never-ending SSE
		// body is covered more cheaply still - its response returns at once and
		// is cancelled, never buffered.)
		const t0 = Date.now();
		await handler.runWarmup({ paths: ['/slow-hold?ms=60000'], platform: {} });
		const elapsed = Date.now() - t0;
		// It returned on the total-budget backstop, well under the 60s hold.
		expect(elapsed).toBeLessThan(20000);
		expect(elapsed).toBeGreaterThan(1000);
		// 400000 like the sibling boots: the ~15s warmup fits with room, and a
		// cold fixture build in isolation does not straddle the budget.
	}, 400000);
});

describeUWS('a booting process warms before readiness reports ready', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	afterEach(() => {
		if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
		child = null;
	});

	it('logs the warmup during starting, ahead of the ready line', async () => {
		expect(buildFixtureOnce('default')).toBe(true);
		const builtEntry = path.join(fixtureDir, variantOut('default'), 'index.js');
		const port = await freePort();
		const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port) };
		for (const k of ['CLUSTER_WORKERS', 'CLUSTER_MODE', 'ORIGIN', 'SSL_CERT', 'SSL_KEY', 'SSL_WATCH']) delete env[k];

		const proc = spawn(process.execPath, [builtEntry], { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'], env });
		child = proc;
		let out = '';
		const waitFor = (needle, ms) => new Promise((resolve) => {
			if (out.includes(needle)) return resolve(true);
			const done = (hit) => { clearTimeout(t); proc.stdout.off('data', scan); proc.stderr.off('data', scan); proc.off('exit', onExit); resolve(hit); };
			const t = setTimeout(() => done(false), ms);
			const scan = (c) => { out += c.toString(); if (out.includes(needle)) done(true); };
			const onExit = () => done(false);
			proc.stdout.on('data', scan); proc.stderr.on('data', scan); proc.on('exit', onExit);
		});

		const ready = await waitFor('Ready for traffic', 30000);
		expect(ready, `server must report ready.\n--- output ---\n${out}`).toBe(true);

		// The warmup ran, and it ran BEFORE the ready line - so readiness cannot
		// have turned green on a cold render path.
		const warmedIdx = out.indexOf('Warmed 1 SSR path(s) before readiness');
		const readyIdx = out.indexOf('Ready for traffic');
		expect(warmedIdx, `warmup line must appear.\n--- output ---\n${out}`).toBeGreaterThanOrEqual(0);
		expect(warmedIdx).toBeLessThan(readyIdx);

		// And the readiness probe agrees: 200 once ready, and the first SSR
		// render a client now gets is the warm one.
		const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
		expect(readyz.status).toBe(200);
		expect(await readyz.text()).toBe('ready');
		const page = await fetch(`http://127.0.0.1:${port}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('hello from ssr');
	}, 400000);
});
