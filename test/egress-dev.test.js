// Publish-egress ceilings on the dev plugin (src/vite.js), driven through the
// real plugin against a real http.Server and a real `ws` client. Dev must
// REFUSE exactly as production does - the messageAdmission dev-live precedent
// - or a budget the app relies on is discovered in production or not at all.
// Reporting stays inert (dev pressure carries zeros); the refusal itself is
// the dev-live contract asserted here, through what a publish CALLER and a
// subscribed client observe.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';

/** @type {any} */
let httpServer = null;
/** @type {any[]} */
const sockets = [];

afterEach(async () => {
	for (const ws of sockets.splice(0)) { try { ws.terminate(); } catch { /* gone */ } }
	if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
	httpServer = null;
});

/**
 * Boot the Vite plugin with an egress config and a handler whose message hook
 * exposes the platform publish results back over the wire, then connect one
 * real subscribed client. Shaped after test/attribution-dev.test.js.
 *
 * @param {any} pluginOptions
 * @param {any} handler
 */
async function bootDev(pluginOptions, handler) {
	const mod = await import('../src/vite.js');
	const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler', ...pluginOptions });

	httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const port = httpServer.address().port;

	// The module the plugin loads, swappable so an HMR update serves an
	// edited handler exactly as a saved file would.
	let currentHandler = handler;
	const viteServer = {
		httpServer,
		middlewares: { use() {} },
		config: {
			root: process.cwd(),
			logger: { warn() {}, info() {}, error() {} },
			server: {}
		},
		async ssrLoadModule() {
			return { default: currentHandler, ...currentHandler };
		}
	};
	await plugin.configureServer(viteServer);

	const wsMod = await import('ws');
	const WebSocket = wsMod.WebSocket ?? wsMod.default;

	/**
	 * One real subscribed client, with its own frame log.
	 * @param {string[]} topics
	 */
	async function openClient(topics) {
		const client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
		sockets.push(client);
		/** @type {any[]} */
		const frames = [];
		client.on('message', (raw) => {
			try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ }
		});
		await new Promise((resolve, reject) => { client.on('open', resolve); client.on('error', reject); });
		for (const topic of topics) client.send(JSON.stringify({ type: 'subscribe', topic }));
		await new Promise((r) => setTimeout(r, 80));
		return {
			frames,
			/** @param {any} obj */
			send: (obj) => client.send(JSON.stringify(obj)),
			/**
			 * @param {(f: any) => boolean} predicate
			 * @param {number} [ms]
			 */
			async waitFor(predicate, ms = 2000) {
				const deadline = Date.now() + ms;
				for (;;) {
					const hit = frames.find(predicate);
					if (hit) return hit;
					if (Date.now() >= deadline) return null;
					await new Promise((r) => setTimeout(r, 10));
				}
			}
		};
	}

	const first = await openClient(['feed']);
	return {
		...first,
		openClient,
		/**
		 * Save an edited handler module and let the plugin's HMR hook decide
		 * what to install. Returns after the reload settles.
		 * @param {any} next
		 */
		async hotUpdate(next) {
			currentHandler = next;
			plugin.handleHotUpdate({ server: viteServer });
			await new Promise((r) => setTimeout(r, 150));
		}
	};
}

// The probe handler: each publish-probe drives the dev platform's REAL
// publish and echoes the caller-observed result.
const probeHandler = {
	message(ws, { data, platform }) {
		let msg;
		try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
		if (msg?.type !== 'publish-probe') return;
		const result = platform.publish(msg.topic, 'probe-event', { nonce: msg.nonce });
		platform.send(ws, 'probe', 'publish-probe-result', { nonce: msg.nonce, result });
	},
	egressTenantOf(topic) {
		return topic.startsWith('acme/') ? 'acme' : null;
	}
};

describe('the dev plugin enforces the egress ceilings live', () => {
	it('refuses the crossing publish with the same pre-hoc semantics as production', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, topic: { messages: 2 } } }, probeHandler);

		dev.send({ type: 'publish-probe', topic: 'feed', nonce: 'a' });
		dev.send({ type: 'publish-probe', topic: 'feed', nonce: 'b' });
		dev.send({ type: 'publish-probe', topic: 'feed', nonce: 'c' });

		const a = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'a');
		const b = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'b');
		const c = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'c');
		expect(a?.data.result).toBe(true);
		expect(b?.data.result).toBe(true);
		expect(c?.data.result, 'the third publish must be refused in dev exactly as in production').toBe(false);

		// The refused publish delivered nothing: only the two admitted
		// envelopes reached the subscriber.
		const delivered = dev.frames.filter((f) => f.topic === 'feed' && f.event === 'probe-event');
		expect(delivered.map((f) => f.data.nonce)).toEqual(['a', 'b']);
	});

	it('tenant ceilings pool the resolver namespace in dev', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, tenant: { messages: 2 } } }, probeHandler);
		// Hold both namespaced topics so an ADMITTED publish reads true and a
		// refusal is unambiguous.
		dev.send({ type: 'subscribe', topic: 'acme/feed' });
		dev.send({ type: 'subscribe', topic: 'free/feed' });
		await new Promise((r) => setTimeout(r, 80));

		dev.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'a' });
		const a = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'a');
		dev.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'b' });
		const b = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'b');
		dev.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'c' });
		const c = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'c');
		expect(a?.data.result).toBe(true);
		expect(b?.data.result).toBe(true);
		expect(c?.data.result, 'acme is over its tenant window').toBe(false);

		// The unattributed namespace sits outside the tenant window entirely.
		dev.send({ type: 'publish-probe', topic: 'free/feed', nonce: 'd' });
		const d = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'd');
		expect(d?.data.result).toBe(true);
	});

	it('reporting stays inert while enforcement is live', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, topic: { messages: 1 } } }, {
			message(ws, { data, platform }) {
				let msg;
				try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
				if (msg?.type !== 'pressure-probe') return;
				platform.publish('feed', 'noise', null);
				platform.publish('feed', 'noise', null);
				platform.send(ws, 'probe', 'pressure-probe-result', {
					nonce: msg.nonce,
					egress: platform.pressure.egress
				});
			}
		});
		dev.send({ type: 'pressure-probe', nonce: 'p' });
		const p = await dev.waitFor((f) => f.event === 'pressure-probe-result' && f.data?.nonce === 'p');
		// The second publish was refused (enforcement live), yet the dev
		// pressure slice reports placeholder zeros (reporting inert).
		expect(p?.data.egress).toEqual({ deliveries: 0, bytes: 0, refusedTopic: 0, refusedTenant: 0 });
	});
});

// Dev is where an operator validates a budget, so a batch must be as atomic
// here as in production. Every dev batch lane delegates to publish() one entry
// at a time, so each one needs its own whole-batch decision before the first
// delegation: without it the entries decide individually and deliver a prefix.
describe('the dev plugin admits a batch whole or not at all', () => {
	const batchHandler = {
		message(ws, { data, platform }) {
			let msg;
			try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
			if (msg?.type !== 'batch-probe') return;
			platform.publishBatched(msg.messages);
			platform.send(ws, 'probe', 'batch-probe-result', { nonce: msg.nonce });
		},
		egressTenantOf() { return 'acme'; }
	};

	it('pools one tenant share across the topics a batch spans', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, tenant: { messages: 6 } } }, batchHandler);
		// Subscribe the one client to BOTH batch topics, so every subscriber
		// sees every topic and the batch takes the all-see-all fast path.
		dev.send({ type: 'subscribe', topic: 'a' });
		dev.send({ type: 'subscribe', topic: 'b' });
		await new Promise((r) => setTimeout(r, 80));

		const messages = [];
		for (let i = 0; i < 5; i++) messages.push({ topic: 'a', event: 'e', data: { i } });
		for (let i = 0; i < 5; i++) messages.push({ topic: 'b', event: 'e', data: { i } });
		dev.send({ type: 'batch-probe', nonce: 'pool', messages });
		await dev.waitFor((f) => f.event === 'batch-probe-result' && f.data?.nonce === 'pool');

		// Ten messages of one tenant against a six-message ceiling: refused
		// whole. Admitting per topic would pass both topics against an
		// untouched window and deliver all ten.
		expect(dev.frames.filter((f) => f.event === 'e')).toEqual([]);
	});

	it('refuses a disjoint batch whole rather than delivering a prefix', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, topic: { messages: 2 } } }, batchHandler);
		// One client on 'a' only: the batch spans a topic it does not hold,
		// so the plugin takes the per-event slow path.
		dev.send({ type: 'subscribe', topic: 'a' });
		await new Promise((r) => setTimeout(r, 80));

		const messages = [];
		for (let i = 0; i < 3; i++) messages.push({ topic: 'a', event: 'e', data: { i } });
		for (let i = 0; i < 3; i++) messages.push({ topic: 'b', event: 'e', data: { i } });
		dev.send({ type: 'batch-probe', nonce: 'slow', messages });
		await dev.waitFor((f) => f.event === 'batch-probe-result' && f.data?.nonce === 'slow');

		// Three messages on 'a' against a two-message ceiling: the whole
		// batch is refused. Per-event admission would deliver the first two
		// and shed the rest.
		expect(dev.frames.filter((f) => f.event === 'e')).toEqual([]);
	});

	it('refuses a wire batch whole, the lane that reaches publish() one entry at a time', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, topic: { messages: 3 } } }, {
			message(ws, { data, platform }) {
				let msg;
				try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
				if (msg?.type !== 'wire-batch-probe') return;
				const entries = [1, 2, 3, 4, 5].map((n) => ({ data: { n } }));
				const ok = platform.publishWireBatch('feed', 'e', entries, { capability: 'json' }, { seq: false });
				platform.send(ws, 'probe', 'wire-batch-probe-result', { nonce: msg.nonce, ok });
			}
		});

		dev.send({ type: 'wire-batch-probe', nonce: 'w' });
		const r = await dev.waitFor((f) => f.event === 'wire-batch-probe-result' && f.data?.nonce === 'w');

		// Five entries against a three-message ceiling: refused whole, exactly
		// as production and createTestServer refuse it. Delegating straight to
		// publish() lets each entry decide for itself, which returns true and
		// delivers a prefix of three.
		expect(r?.data.ok, 'the whole wire batch must be refused').toBe(false);
		expect(dev.frames.filter((f) => f.event === 'e')).toEqual([]);
	});

	it('delivers an admitted disjoint batch whole rather than shedding mid-batch on bytes', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, tenant: { bytes: 100 } } }, batchHandler);
		// One client on 'a' only, so the batch spans a topic no subscriber
		// holds and the plugin takes the per-event slow path.
		dev.send({ type: 'subscribe', topic: 'a' });
		await new Promise((r) => setTimeout(r, 80));

		const messages = [];
		for (let i = 0; i < 4; i++) messages.push({ topic: 'a', event: 'e', data: { i } });
		for (let i = 0; i < 4; i++) messages.push({ topic: 'b', event: 'e', data: { i } });
		dev.send({ type: 'batch-probe', nonce: 'bytes', messages });
		await dev.waitFor((f) => f.event === 'batch-probe-result' && f.data?.nonce === 'bytes');

		// A bytes ceiling refuses on usage ALREADY BOOKED, so the batch is
		// admitted at zero usage and every event it carries must be
		// delivered. Re-deciding per event crosses the 100-byte ceiling on
		// the fourth 40-byte envelope and delivers a prefix of three - the
		// shed the whole-batch admission exists to prevent, and one neither
		// production nor createTestServer produces.
		const delivered = dev.frames.filter((f) => f.event === 'e');
		expect(delivered.map((f) => f.data.i)).toEqual([0, 1, 2, 3]);
	});
});

// An edited handler that changes ONLY the egress resolver still has to reach
// the running server: the resolver is what binds a publish to a tenant, so a
// stale one stands every tenant ceiling down while dev looks healthy.
// Dev runs its own copy of the marker check, so it needs its own proof that
// the marker is unforgeable. The forgeries are built inside the handler: no
// shape of them survives the JSON wire, which is half of why the real marker
// is a Symbol.
describe('the dev plugin refuses a forged batch-admission marker', () => {
	const forgeryHandler = {
		message(ws, { data, platform }) {
			let msg;
			try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
			if (msg?.type !== 'forge-probe') return;
			const warm = platform.publish('feed', 'warm', { n: 0 });
			const results = [
				{ _egressAdmitted: true },
				{ EGRESS_ADMITTED: true },
				{ egressAdmitted: true },
				{ [Symbol.for('adapter-uws.egress-admitted')]: true },
				{ [Symbol('adapter-uws.egress-admitted')]: true }
			].map((options) => platform.publish('feed', 'forged', { n: 1 }, options));
			platform.send(ws, 'probe', 'forge-probe-result', { nonce: msg.nonce, warm, results });
		}
	};

	it('lets no options shape past a ceiling the real marker would inherit', async () => {
		const dev = await bootDev({ egress: { windowMs: 60000, topic: { messages: 1 } } }, forgeryHandler);
		dev.send({ type: 'forge-probe', nonce: 'f' });
		const f = await dev.waitFor((x) => x.event === 'forge-probe-result' && x.data?.nonce === 'f');
		expect(f?.data.warm).toBe(true);
		expect(f?.data.results).toEqual([false, false, false, false, false]);
		expect(dev.frames.filter((x) => x.event === 'forged')).toEqual([]);
	});
});

describe('the dev plugin installs an edited egress tenant resolver', () => {
	it('serves an egressTenantOf added by an edit rather than the stale module', async () => {
		const message = probeHandler.message;
		// A tenant ceiling armed with no resolver present: every topic is
		// unattributed, so nothing pools and both publishes pass.
		const dev = await bootDev({ egress: { windowMs: 60000, tenant: { messages: 1 } } }, { message });
		// Hold the topic, so an admitted publish reads true and a refusal is
		// unambiguous rather than "nobody was listening".
		dev.send({ type: 'subscribe', topic: 'acme/feed' });
		await new Promise((r) => setTimeout(r, 80));
		dev.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'a' });
		dev.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'b' });
		const a = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'a');
		const b = await dev.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'b');
		expect(a?.data.result).toBe(true);
		expect(b?.data.result).toBe(true);

		// The operator adds the resolver and saves the file. Only that export
		// changed - every other handler reference is identical - so a
		// comparison list that omits it reloads nothing at all.
		await dev.hotUpdate({
			message,
			egressTenantOf: (topic) => (topic.startsWith('acme/') ? 'acme' : null)
		});

		const after = await dev.openClient(['acme/feed']);
		after.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'c' });
		const c = await after.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'c');
		expect(c?.data.result).toBe(true);
		after.send({ type: 'publish-probe', topic: 'acme/feed', nonce: 'd' });
		const d = await after.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === 'd');
		expect(d?.data.result, 'the added resolver must pool acme under its tenant ceiling').toBe(false);
	});

	it('says so when the ledger evicts a live window, which is the only report dev has', async () => {
		// Dev registers no metrics, so `egress_evicted_total` does not exist
		// here. Without a line, a ledger past its bound stopped enforcing for
		// evicted keys and every dev surface stayed silent - enforcement
		// disappearing quietly is worse in dev than in production, because dev
		// is where the ceiling is being trusted for the first time.
		const { setOperationalEventSink } = await import('../src/runtime/diagnostic.js');
		/** @type {any[]} */
		const seen = [];
		setOperationalEventSink((record) => { seen.push(record); });
		try {
			// One message, many publishes: the ledger's bound is 4096 keys and
			// the eviction is what happens once a new key can only be seated by
			// taking a live window from another.
			const flood = {
				message(ws, { data, platform }) {
					let msg;
					try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
					if (msg?.type !== 'flood') return;
					for (let i = 0; i < msg.count; i++) platform.publish('flood-' + i, 'e', null, { seq: false });
					platform.send(ws, 'probe', 'flooded', { count: msg.count });
				}
			};
			// A window long enough that nothing lapses inside the case: every
			// key stays live, so seating the next one has to evict.
			const dev = await bootDev({ egress: { windowMs: 600000, topic: { messages: 50 } } }, flood);
			dev.send({ type: 'flood', count: 4600 });
			expect(await dev.waitFor((f) => f.event === 'flooded', 10000), 'the flood must complete').not.toBeNull();

			const evictions = seen.filter((r) => r.event === 'egress.window-evicted');
			expect(evictions.length, 'dev must report the eviction it is enforcing through').toBe(1);
			expect(evictions[0].severity).toBe('warn');
			expect(evictions[0].attributes.scope).toBe('topic');
			// Throttled per scope, not per key: a line per eviction would fire
			// at the rate of the churn causing it, which is thousands here.
			expect(evictions.length, 'one line, not one per evicted key').toBe(1);
		} finally {
			setOperationalEventSink(null);
		}
	}, 30000);
});
