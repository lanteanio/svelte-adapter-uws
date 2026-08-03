import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describe('current sv consolidated configuration guidance', () => {
	it('makes vite.config.ts primary and warns that a sidecar config is ignored', () => {
		const start = README.indexOf('## Quick start: HTTP');
		const end = README.indexOf('## Quick start: HTTPS', start);
		const quickStart = README.slice(start, end);

		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		expect(quickStart).toContain('**vite.config.ts**');
		expect(quickStart).toContain('sveltekit({');
		expect(quickStart).toContain('adapter: adapter()');
		expect(quickStart).toMatch(/ignores?\s+a\s+separate `svelte\.config\.js`/i);
		expect(quickStart).toContain('SvelteKit 2.61 and earlier');
	});
});

const describeRuntime = hasUWS ? describe : describe.skip;

describeRuntime('current sv consolidated configuration canary', () => {
	let server;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'consolidated' });
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('produces runnable adapter output and serves the first HTTP request', async () => {
		expect(existsSync(path.join(fixtureDir, 'build-consolidated', 'index.js'))).toBe(true);
		const response = await fetch(server.httpUrl + '/');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('hello from ssr');
	});
});
