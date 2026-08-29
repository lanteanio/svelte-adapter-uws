// The send lanes' explicit seq option - the gap-fill channel a resume hook
// replays history through - on the BUILT modules a running server uses.
//
// The contract: number and bigint stamp the exact value (the publish lanes'
// validation and double-space projection); false/null/absent leave the frame
// byte-identical to the seq-less shape every prior release sent; true throws
// its own message, because the send lanes have no counter to draw; and an
// explicitly-seq'd send is SIDE-EFFECT-FREE - gap-fill replays history that
// is already accounted, so no counter advances, no max-seen records, and no
// resume capture fires. The seq rides the binary frame's seq slot and the
// JSON fallback identically, so the client keys one watermark whichever form
// the connection negotiates.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';

let uWS = null;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
// Visible skip, never a silent in-body return: a case that returns early on a
// missing binding reports PASSED with zero assertions, the reporting shape
// helpers/real-runtime.js exists to forbid.
const itUWS = uWS ? it : it.skip;

const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');

describe('the send lanes stamp an explicit seq, side-effect-free', () => {
	/** @type {any} */ let platform;
	/** @type {any} */ let state;
	/** @type {any} */ let symbols;

	beforeAll(async () => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		({ platform } = await import(pathToFileURL(path.join(builtDir, 'platform.js')).href));
		state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);
		symbols = await import(pathToFileURL(path.join(builtDir, '..', 'utils.js')).href);
	}, 120000);

	function scriptedWs(caps = null) {
		const ud = {};
		if (caps) ud[symbols.WS_CAPS] = new Set(caps);
		const sent = { text: [], binary: [] };
		return {
			sent,
			getUserData() { return ud; },
			send(payload, isBinary) {
				if (isBinary) sent.binary.push(new Uint8Array(payload));
				else sent.text.push(String(payload));
				return 1;
			}
		};
	}

	it('stamps a number and a bigint on the JSON envelope, and omits the field otherwise', () => {
		const ws = scriptedWs();
		platform.send(ws, 'gapfill', 'update', { v: 1 }, { seq: 42 });
		platform.send(ws, 'gapfill', 'update', { v: 2 }, { seq: 7n });
		platform.send(ws, 'gapfill', 'update', { v: 3 });
		platform.send(ws, 'gapfill', 'update', { v: 4 }, { seq: false });
		platform.send(ws, 'gapfill', 'update', { v: 5 }, { seq: null });
		const seqs = ws.sent.text.map((t) => { const p = JSON.parse(t); return 'seq' in p ? p.seq : null; });
		expect(seqs).toEqual([42, 7, null, null, null]);
		// The seq-less shapes are byte-identical to the historical envelope.
		expect(ws.sent.text[2]).toBe('{"topic":"gapfill","event":"update","data":{"v":3}}');
	});

	it('refuses true and every invalid spelling with the send lanes\' own message', () => {
		const ws = scriptedWs();
		// `true` and the type refusals must carry the SEND lane's message -
		// "send seq" appears in no publish-table refusal, so a resolver that
		// regressed to the publish table fails here by wording.
		for (const bad of [true, '5', {}]) {
			expect(() => platform.send(ws, 'gapfill', 'update', {}, { seq: bad }), String(bad))
				.toThrow(/send seq/);
		}
		// Range refusals delegate to the shared explicit validator and carry
		// its message.
		for (const bad of [0, -1, 1.5, NaN, 0n]) {
			expect(() => platform.send(ws, 'gapfill', 'update', {}, { seq: bad }), String(bad))
				.toThrow(/positive integer/);
		}
		expect(ws.sent.text, 'a refused send must put nothing on the wire').toEqual([]);
	});

	it('advances no counter, records no max-seen, captures no resume frame', () => {
		const ws = scriptedWs();
		const topic = 'gapfill-effects';
		// An OPEN capture buffer is the state where a stray capture could
		// actually fire: captureResumeFrame appends only to buffers that
		// already exist, so asserting on an empty map can never catch the
		// mutant. Seed one, prove the seq'd send leaves it untouched.
		const capture = { frames: [], overflow: false };
		state.resumeBuffers.set(topic, new Set([capture]));
		try {
			platform.send(ws, topic, 'update', { v: 1 }, { seq: 900 });
			platform.sendWire(ws, topic, 'update', { v: 2 },
				{ capability: 'fixture.effects:1', schemaVersion: 1, encode: () => null }, { seq: 901 });
			expect(state.topicSeqs.has(topic), 'the per-topic counter must not learn the topic').toBe(false);
			expect(state.maxSeenSeq.has(topic), 'the max-seen guard must not record a gap-fill seq').toBe(false);
			expect(capture.frames.length, 'a single-target send must not enter an open resume capture').toBe(0);
		} finally {
			state.resumeBuffers.delete(topic);
		}
	});

	itUWS('the harness mirror stamps and refuses through the same resolver', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const server = await createTestServer({
			handler: {
				message(ws, ctx) {
					const m = ctx.msg;
					if (m && m.type === 'echo-seq') {
						try {
							ctx.platform.send(ws, 'gapfill-mirror', 'update', { v: m.v }, { seq: m.seq === 'BIG' ? 7n : m.seq });
						} catch (err) {
							ctx.platform.send(ws, 'gapfill-mirror', 'refused', { message: String(err && err.message) });
						}
					}
				}
			}
		});
		try {
			const { WebSocket } = await import('ws');
			const ws = new WebSocket(server.wsUrl);
			const frames = [];
			ws.on('message', (d, isBinary) => { if (!isBinary) { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
			ws.send(JSON.stringify({ type: 'echo-seq', v: 1, seq: 42 }));
			ws.send(JSON.stringify({ type: 'echo-seq', v: 2, seq: 'BIG' }));
			ws.send(JSON.stringify({ type: 'echo-seq', v: 3, seq: null }));
			ws.send(JSON.stringify({ type: 'echo-seq', v: 4, seq: true }));
			const deadline = Date.now() + 5000;
			while (frames.filter((p) => p.topic === 'gapfill-mirror').length < 4 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 10));
			}
			const got = frames.filter((p) => p.topic === 'gapfill-mirror');
			expect(got.map((p) => p.event)).toEqual(['update', 'update', 'update', 'refused']);
			expect(got.slice(0, 3).map((p) => ('seq' in p ? p.seq : null))).toEqual([42, 7, null]);
			expect(got[3].data.message).toMatch(/send seq/);
			ws.terminate();
		} finally {
			await server.close();
		}
	}, 30000);

	it('rides the binary frame seq slot and the JSON fallback identically through sendWire', () => {
		const wire = { capability: 'fixture.send-seq:1', schemaVersion: 1, encode: () => new Uint8Array([9, 9]) };
		const capable = scriptedWs([wire.capability]);
		platform.sendWire(capable, 'gapfill-wire', 'update', { v: 1 }, wire, { seq: 314 });
		// Frame 0 is the wire-id announce; the payload frame follows.
		const frame = parseBinaryFrame(capable.sent.binary[capable.sent.binary.length - 1]);
		expect(frame, 'the capable socket must receive a binary frame').toBeTruthy();
		expect(frame.seq, 'the binary seq slot must carry the explicit value').toBe(314);

		const plain = scriptedWs();
		platform.sendWire(plain, 'gapfill-wire', 'update', { v: 1 }, wire, { seq: 314 });
		expect(JSON.parse(plain.sent.text[0]).seq, 'the JSON fallback must carry the same seq').toBe(314);

		// And seq-less stays seq-less on both forms.
		const quiet = scriptedWs();
		platform.sendWire(quiet, 'gapfill-wire', 'update', { v: 1 }, wire);
		expect('seq' in JSON.parse(quiet.sent.text[0])).toBe(false);
	});
});
