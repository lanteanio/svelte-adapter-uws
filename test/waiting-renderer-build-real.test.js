// The production waiting-room localization pipeline, driven end to end from
// the REAL build: waitingRoom.renderer is a module PATH (production refuses a
// live function), so only a built fixture exercises the build-side
// validation, the isolated esbuild renderer entry, the default/renderWaitingRoom
// pick, and the bridge artifact the runtime imports. Every prior renderer test
// injected a live function, which meant this whole chain could be deleted with
// the suite green.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { resolveWaitingRoom } from '../src/runtime/utils/upgrade-admission.js';

const out = fileURLToPath(new URL('./fixture/build-waiting-renderer', import.meta.url));

function requestWith(language) {
	return {
		method: 'GET',
		url: '/ws',
		headers: { get: (name) => (name.toLowerCase() === 'accept-language' ? language : null) }
	};
}

describe('built waiting-room renderer pipeline', () => {
	beforeAll(() => {
		expect(buildFixtureOnce('waitingrenderer'), 'waiting-renderer fixture failed to build').toBe(true);
	}, 400000);

	it('bundles the configured module into a real renderer artifact, not the null stub', async () => {
		const url = pathToFileURL(join(out, 'server', 'waiting-room-renderer.js'));
		url.searchParams.set('test', String(Date.now()));
		const artifact = await import(url.href);
		expect(typeof artifact.default, 'renderer artifact still exports the unused-feature stub').toBe('function');
	});

	it('serves localized documents through resolveWaitingRoom exactly as the runtime wires it', async () => {
		const url = pathToFileURL(join(out, 'server', 'waiting-room-renderer.js'));
		url.searchParams.set('test', 'localized-' + Date.now());
		const artifact = await import(url.href);
		const room = resolveWaitingRoom(
			{ maxConcurrent: 4, waitingRoom: {} },
			artifact.default
		);
		expect(room).not.toBeNull();

		const english = room.renderResponse(3, requestWith('en-US,en;q=0.9'));
		expect(english.lang).toBe('en');
		expect(english.varyAcceptLanguage).toBe(true);
		expect(english.body).toContain('You are in the queue');

		const french = room.renderResponse(3, requestWith('fr-CH,fr;q=0.9'));
		expect(french.lang).toBe('fr');
		expect(french.body).toContain('Vous êtes dans la file');
	});

	it('keeps the runtime bridge bound to the built artifact', () => {
		// The bridge is the ONLY route the bundled renderer reaches the
		// handler through; assert the BUILT bridge (not the repo source)
		// still imports the artifact, so deleting the wiring turns this red.
		const bridge = readFileSync(join(out, 'waiting-room-renderer-bridge.js'), 'utf8');
		expect(bridge).toContain('./server/waiting-room-renderer.js');
	});

	it('feeds the bridge value into resolveWaitingRoom in the built handler', () => {
		// The last hop: handler.js must pass the bridge import as the second
		// argument. Replacing it with null breaks production localization
		// while every renderer unit test stays green, so the BUILT handler is
		// asserted to carry the feed - not the repo source, which a build
		// could be configured to ignore.
		const handler = readFileSync(join(out, 'handler.js'), 'utf8');
		const feed = /resolveWaitingRoom\(\s*([A-Za-z_$][\w$]*)\??\.?[\w$]*\.?upgradeAdmission\s*,\s*([A-Za-z_$][\w$]*)\s*\)/
			.exec(handler);
		expect(feed, 'built handler does not call resolveWaitingRoom with two arguments').not.toBeNull();
		const rendererBinding = feed[2];
		expect(rendererBinding).not.toBe('null');
		expect(rendererBinding).not.toBe('undefined');
		// That binding must be the value imported from the bridge, not a
		// local placeholder that happens to be named something plausible.
		expect(handler).toMatch(
			new RegExp('import\\s*\\{[^}]*\\b' + rendererBinding + '\\b[^}]*\\}\\s*from\\s*["\'][^"\']*waiting-room-renderer-bridge')
		);
	});
});
