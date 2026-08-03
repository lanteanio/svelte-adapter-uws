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

	it('never presents the sidecar as the only config, anywhere', () => {
		// The HTTP quick start led with the consolidated form while the WSS
		// quick start, the full worked example and the WebSocket-path answer
		// still showed `**svelte.config.js**` as the sole config - so a reader
		// who reached them created the file this same README forbids and got a
		// green build with no runnable output. Every remaining mention has to
		// carry its version scope.
		const headings = [...README.matchAll(/^\*\*svelte\.config\.js\*\*$/gm)];
		expect(
			headings.map((match) => README.slice(0, match.index).split('\n').length),
			'a section presents svelte.config.js as its own config block'
		).toEqual([]);

		// Prose that EXPLAINS the sidecar is fine and often necessary. What is
		// not fine is a code comment naming it as the place to put the snippet
		// below, because that is an instruction a current `sv` user will follow
		// into an ignored file. Those must carry their scope inline.
		for (const line of README.split('\n')) {
			if (!/^\s*\/\/.*svelte\.config\.js/.test(line)) continue;
			expect(
				/legacy|2\.61|or the adapter call/i.test(line),
				`this comment sends a reader to the sidecar without scoping it: ${line.trim()}`
			).toBe(true);
		}
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
