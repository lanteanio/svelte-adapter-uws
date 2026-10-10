import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPresence } from '../src/plugins/presence/server.js';
import { createTestServer } from '../src/testing.js';
import { connectRealClient, hasUWS } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const ROOM = 'unicode-presence';
const PRESENCE_TOPIC = '__presence:' + ROOM;

// The plugin runs through its public server API and message hook, with real
// sockets. Assertions read the observer's delivered diffs and fresh snapshots.
describeUWS('presence identity field matching over WebSocket', () => {
	let server;
	let presence;
	let warning;
	let clients = [];

	afterEach(async () => {
		for (const client of clients) client.close();
		clients = [];
		await server?.close();
		server = null;
		presence?.clear();
		presence = null;
		warning?.mockRestore();
	});

	async function client(id) {
		const connection = await connectRealClient(server.wsUrl + '?id=' + id);
		clients.push(connection);
		return connection;
	}

	async function start(key, clientUpdateFields) {
		warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		presence = createPresence({ key, clientUpdateFields, topicThrottle: 0, binary: false });
		server = await createTestServer({
			handler: {
				upgrade({ url }) {
					return { [key]: new URL('http://test' + url).searchParams.get('id') };
				},
				subscribe(_ws, topic) { return topic === ROOM ? null : 'FORBIDDEN'; },
				message(ws, { data, platform }) {
					const msg = JSON.parse(Buffer.from(data).toString('utf8'));
					if (msg.type === 'server-join') presence.join(ws, ROOM, platform);
					else if (msg.type === 'server-update') presence.update(ws, ROOM, msg.fields, platform);
					else if (msg.type === 'barrier') ws.send(JSON.stringify({ type: 'barrier', ref: msg.ref }));
					else presence.hooks.message(ws, { data, msg, platform });
				},
				close(ws, { platform }) { presence.hooks.close(ws, { platform }); }
			}
		});
		const observer = await client('observer');
		observer.send({ type: 'presence-snapshot', topic: ROOM });
		expect(await observer.waitFor((m) => m?.topic === PRESENCE_TOPIC && m.event === 'state', 2000)).not.toBeNull();
		const participant = await client('participant');
		participant.send({ type: 'server-join' });
		const joined = await observer.waitFor((m) => m?.topic === PRESENCE_TOPIC && m.event === 'diff' && m.data.joins?.participant, 2000);
		expect(joined?.parsed.data.joins.participant).toEqual({ [key]: 'participant' });
		return { observer, participant };
	}

	async function freshSnapshot() {
		const fresh = await client('fresh');
		fresh.send({ type: 'presence-snapshot', topic: ROOM });
		const state = await fresh.waitFor((m) => m?.topic === PRESENCE_TOPIC && m.event === 'state', 2000);
		expect(state).not.toBeNull();
		return state.parsed.data;
	}

	it.each([
		{ label: 'Unicode-only key', key: '\u7528\u6237', allowed: ['\u72b6\u6001', '...'], aliases: [], empty: true },
		{ label: 'Unicode case remains exact for an empty fold', key: '\u00c4', allowed: ['\u00e4', '\u00d6'], aliases: [], empty: true },
		{ label: 'punctuation-only key', key: '---', allowed: ['...', '\u03a9'], aliases: [], empty: true },
		{ label: 'Unicode key with nonempty ASCII fold', key: '\u212aey', allowed: ['\u72b6\u6001', '...'], aliases: ['K-e_y', 'KEY'], empty: false },
		{ label: 'ASCII key keeps folded aliases', key: 'userKey', allowed: ['\u72b6\u6001', '...'], aliases: ['USER_KEY'], empty: false }
	])('$label keeps its identity and delivers unrelated fields', async ({ key, allowed, aliases, empty }) => {
		const { observer, participant } = await start(key);
		const expected = Object.fromEntries(allowed.map((name) => [name, 'server-value']));
		expected.status = 'server-updated';
		participant.send({
			type: 'server-update',
			fields: { [key]: 'forged', ...Object.fromEntries(aliases.map((name) => [name, 'forged'])), ...expected, '__\u72b6\u6001': 'private' }
		});
		const diff = await observer.waitFor((m) => m?.topic === PRESENCE_TOPIC && m.event === 'diff' && m.data.updates?.participant?.status === 'server-updated', 2000);
		expect(diff?.parsed.data.updates.participant).toEqual(expected);
		expect((await freshSnapshot()).participant).toEqual({ [key]: 'participant', ...expected });

		const warnings = warning.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('presence.update():'));
		expect(warnings).toHaveLength(1 + aliases.length);
		expect(warnings.some((message) => message.includes("field '" + key + "' is reserved"))).toBe(true);
		if (empty) expect(warnings.some((message) => message.includes('__\u72b6\u6001'))).toBe(false);

		// Ordered on one socket: the barrier confirms the wire update was
		// handled before a new observer requests the durable state.
		participant.send({ type: 'presence-update', topic: ROOM, fields: { [allowed[0]]: 'wire-value', status: 'wire-updated' } });
		participant.send({ type: 'barrier', ref: 'wire-processed' });
		expect(await participant.waitFor((m) => m?.type === 'barrier' && m.ref === 'wire-processed', 2000)).not.toBeNull();
		expect((await freshSnapshot()).participant).toEqual({ [key]: 'participant', ...expected });
	});

	it('wire updates retain exact explicit allowlist matching with a Unicode identity key', async () => {
		const key = '\u7528\u6237';
		const allowed = '\u72b6\u6001';
		const { observer, participant } = await start(key, [allowed]);
		participant.send({ type: 'presence-update', topic: ROOM, fields: { [key]: 'forged', [allowed]: 'wire-ready', status: 'excluded' } });
		const diff = await observer.waitFor((m) => m?.topic === PRESENCE_TOPIC && m.event === 'diff' && m.data.updates?.participant?.[allowed] === 'wire-ready', 2000);
		expect(diff?.parsed.data.updates.participant).toEqual({ [allowed]: 'wire-ready' });
		expect((await freshSnapshot()).participant).toEqual({ [key]: 'participant', [allowed]: 'wire-ready' });
	});
});
