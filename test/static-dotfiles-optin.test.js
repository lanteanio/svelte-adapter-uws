// staticDotfiles: true - the opt-out from the default dotfile exclusion.
//
// Its own fixture variant (build-dotfiles) because the option is baked at
// build time, and its own file because one variant per test file is the
// harness rule. The value under test is the whole path: fixture config ->
// adapter factory validation -> placeholder substitution -> the index-time
// walk -> the bytes a client receives. A re-wired unit could pass all of
// this with the production plumbing dead.
//
// This suite is also the oracle for the premise that the build output
// CONTAINS dotfiles at all: if the toolchain stopped copying them out of
// static/, the 200s here would turn 404 and say so.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeMaybe = hasUWS ? describe : describe.skip;

const MARKER = 'leaked-if-served';

describeMaybe('staticDotfiles: true (real runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>>} */
	let server;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'dotfiles' });
	}, 240000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('serves a top-level dotfile', async () => {
		const res = await fetch(`${server.httpUrl}/.htpasswd`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(MARKER);
	});

	it('serves a nested dotfile', async () => {
		const res = await fetch(`${server.httpUrl}/deep/.hidden.txt`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(MARKER);
	});

	it('serves a dotfile inside .well-known', async () => {
		const res = await fetch(`${server.httpUrl}/.well-known/.nested-secret`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(MARKER);
	});

	it('still serves ordinary files (control)', async () => {
		const res = await fetch(`${server.httpUrl}/test.txt`);
		expect(res.status).toBe(200);
	});
});

describeMaybe('staticDotfiles: true (index-time walk)', () => {
	let tmp = '';

	afterAll(() => {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('indexes dot-segment paths when the option is baked in', async () => {
		expect(buildFixtureOnce('dotfiles'), 'fixture build must succeed for this integration test').toBe(true);

		// The dotfiles build's own module: STATIC_DOTFILES was substituted true
		// at build time, so an indexed dotfile here proves the option reached
		// the walk - not merely the factory.
		const { cacheDir } = await import('./fixture/build-dotfiles/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build-dotfiles/handler/state.js');

		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-dot-optin-'));
		fs.writeFileSync(path.join(tmp, '.secret'), MARKER);
		fs.mkdirSync(path.join(tmp, 'nested'));
		fs.writeFileSync(path.join(tmp, 'nested', '.hidden'), MARKER);

		cacheDir(tmp, '/dot-optin-probe', false);

		expect(staticCache.get('/dot-optin-probe/.secret')).toBeTruthy();
		expect(staticCache.get('/dot-optin-probe/nested/.hidden')).toBeTruthy();
	}, 240000);
});
