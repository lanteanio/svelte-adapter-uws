// The batch surface refuses a numeric `seq`, and it has to refuse it on ALL
// THREE surfaces - production, the published `createTestServer` harness, and the
// Vite dev plugin.
//
// WHY THIS EXISTS. The refusal shipped on all three, but only production was
// pinned: `cluster-sequence-policy-real.test.js` drives the built fixture, and
// nothing anywhere passed a numeric seq to a batch on either mirror. Deleting
// the refusal from `src/testing.js` or from `src/vite.js` left the entire suite
// green. That is the exact drift this repo maintains two cross-surface oracles
// for, and neither of them covers the publish sequence lane - `surface-policy-
// parity` and `surface-differential` cover subscribe, grant and recover only.
//
// A permissive mirror is worse than a missing one: an application suite written
// against `createTestServer` would certify a batch call that stamps every entry
// with one caller-supplied seq, then production throws on the first tick. The
// mirror's own comment says it exists to stop exactly that, so it is worth a
// test that goes red when the line is removed.
//
// THE EMPTY BATCH IS PART OF THE CONTRACT, not an edge case: the refusal is a
// property of the SURFACE, so it must run before the entries are inspected. A
// mirror that checked the options after an `entries.length === 0` early return
// would accept, for an empty tick, options it rejects for a full one - and the
// contract would change shape with the data, which is the arity dependence the
// rule was rewritten to make unreachable.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { BATCH_SEQUENCE_ERROR } from '../src/runtime/handler/cluster-sequence-policy.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const itUWS = uWS ? it : it.skip;

/** Teardown registered by whichever surface a test booted. */
let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
});

const WIRE = { capability: 'fixture.mirror-parity:1', schemaVersion: 1, encode: () => null };
const ENTRIES = [{ data: { n: 1 } }, { data: { n: 2 } }];

/**
 * The same four assertions against whichever surface's platform is handed in,
 * so a mirror cannot pass by refusing in a different shape than production.
 */
function assertRefusesNumericSeq(platform, label) {
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: 14, relay: false }),
		`${label}: a numeric seq must be refused`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// One entry is the shape the bounced arity rule allowed. It must refuse too,
	// or the contract depends on the runtime length of an array again.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', [{ data: { n: 1 } }], WIRE, { seq: 14, relay: false }),
		`${label}: a single-entry batch must refuse it as well`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// Before the entries are inspected - an empty batch refuses what a full one refuses.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', [], WIRE, { seq: 14, relay: false }),
		`${label}: the refusal must precede the entry inspection`
	).toThrow(BATCH_SEQUENCE_ERROR);

	// Vacuity guard: the surface must still ACCEPT the supported shape, or a
	// mirror that threw on everything would satisfy the three assertions above.
	expect(
		() => platform.publishWireBatch('mirror-room', 'update', ENTRIES, WIRE, { seq: false }),
		`${label}: refused the supported shape`
	).not.toThrow();
}

async function bootDevPlatform() {
	const mod = await import('../src/vite.js');
	let platform = null;
	const handler = { open(ws, ctx) { platform = ctx.platform; } };
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

	const httpServer = createServer();
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	const port = httpServer.address().port;
	teardown.push(() => new Promise((r) => httpServer.close(() => r(undefined))));

	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: handler, ...handler }; }
	});

	// The dev platform is handed to the hooks, so a real connection is what
	// surfaces it - which also proves the plugin wired the handler at all.
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	teardown.push(() => { try { ws.terminate(); } catch { /* gone */ } });
	for (let i = 0; i < 200 && platform === null; i++) await new Promise((r) => setTimeout(r, 10));
	expect(platform, 'the dev plugin never handed its platform to the handler').not.toBeNull();
	return platform;
}

describe('the batch numeric-seq refusal holds on every surface, not just production', () => {
	itUWS('refuses it on the published createTestServer harness', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer();
		teardown.push(() => server.close());

		assertRefusesNumericSeq(server.platform, 'createTestServer');
	}, 30000);

	it('refuses it on the Vite dev plugin', async () => {
		const platform = await bootDevPlatform();

		assertRefusesNumericSeq(platform, 'vite dev');
	}, 30000);
});
