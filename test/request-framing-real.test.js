// Where a request says its body ends, driven over raw sockets against the real
// built runtime, because no HTTP client can be made to send these shapes.
//
// The vendored parser reads the PRESENCE of Transfer-Encoding, not its value:
// `xchunked`, `gzip`, `chunked, chunked` and `chunked, gzip` are all decoded as
// chunked, and an empty Content-Length is accepted as a bodyless request.
// (Measured against uWebSockets.js v20.69.0; the malformed Content-Length
// spellings it does refuse - `0x6`, `+6`, `6abc` - are refused before any of
// this runs, and a request carrying both Transfer-Encoding and Content-Length
// is refused there too.) A conformant intermediary in front reads the same
// bytes differently - an unknown coding means it cannot frame the body, so the
// request is bodyless and what follows is the NEXT request - and the two
// readings disagree about where the request ends. That disagreement is the
// whole of request smuggling, so the adapter refuses these shapes itself.
//
// Two oracles, and the second is the one that matters:
//
// 1. The refusal is 400, from whichever lane would have answered.
// 2. The server ENDS the connection, without the client asking it to. What a
//    pooled connection carries next is the request the two readings disagree
//    about, so a 400 that keeps reading leaves the desync in place; a case
//    asserting only the status would pass on a fix that fixes nothing.
//
// Measured, so the cases below read correctly: uWS ends the connection when a
// response is finished with its close flag, but a request it has ALREADY
// parsed out of the same segment is still answered first. So these probes go
// one request at a time and watch for the server's own hangup, rather than
// pipelining a follower and asserting silence.
//
// The discriminator for the second oracle closes the first block below: a
// repeated Authorization line is also refused 400, and its connection stays
// OPEN. So the hangup is scoped to the headers that frame a body rather than
// sprayed over every refusal.

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * Send ONE request, keep the connection open from this side, and report what
 * came back and whether the SERVER hung up.
 *
 * Nothing here sends `Connection: close`, so an ordinary exchange leaves the
 * connection open and `closedByServer` is false; the client gives up after the
 * grace window instead.
 *
 * @param {number} port
 * @param {string[]} lines request line and headers, no terminator
 * @param {string} [body] raw bytes after the header block
 * @returns {Promise<{ statuses: string[], raw: string, closedByServer: boolean }>}
 */
function probe(port, lines, body = '') {
	const wire = [...lines, `Host: 127.0.0.1:${port}`].join('\r\n') + '\r\n\r\n' + body;
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => socket.write(wire));
		let raw = '';
		let closedByServer = false;
		const done = () => {
			clearTimeout(timer);
			resolve({ statuses: [...raw.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]), raw, closedByServer });
		};
		socket.on('data', (chunk) => { raw += chunk.toString('latin1'); });
		socket.on('end', () => { closedByServer = true; });
		socket.on('close', done);
		socket.on('error', (error) => {
			// A hangup while this side still had bytes in flight surfaces as a
			// reset on some stacks, which is the same answer.
			if (/** @type {any} */ (error).code === 'ECONNRESET') { closedByServer = true; return; }
			clearTimeout(timer);
			reject(error);
		});
		// Long enough that a server which was going to hang up has, short
		// enough that a case proving it did not stays quick.
		const timer = setTimeout(() => socket.destroy(), 1000);
		timer.unref?.();
	});
}

/**
 * A registry that only remembers what was counted, so a case can ask which
 * reason a refusal was counted under.
 */
function recordingRegistry() {
	const counters = new Map();
	return {
		counter(name) {
			let c = counters.get(name);
			if (!c) {
				c = {
					series: new Map(),
					inc(labels) {
						const key = labels ? JSON.stringify(labels) : '';
						c.series.set(key, (c.series.get(key) || 0) + 1);
					}
				};
				counters.set(name, c);
			}
			return c;
		},
		gauge() { return { set() {} }; },
		/** @param {string} name @param {string} reason */
		reason(name, reason) {
			return counters.get(name)?.series.get(JSON.stringify({ reason })) || 0;
		}
	};
}

/** The header lines that make a request a WebSocket handshake. */
const HANDSHAKE = Object.freeze([
	'GET /ws HTTP/1.1',
	'Upgrade: websocket',
	'Connection: Upgrade',
	'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
	'Sec-WebSocket-Version: 13'
]);

/** One chunked-encoded body carrying `AA`, the shape a smuggler hides behind. */
const CHUNKED_AA = '2\r\nAA\r\n0\r\n\r\n';

describeUWS('ambiguous request framing at the built runtime', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime();
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => { await server?.stop(); });

	/** The request is refused, and the server hangs up rather than read on. */
	async function expectRefusedAndClosed(lines, body = CHUNKED_AA) {
		const { statuses, raw, closedByServer } = await probe(port, lines, body);
		expect(statuses[0], 'the request is refused: ' + JSON.stringify(raw.slice(0, 80))).toBe('400');
		expect(closedByServer, 'the server ends a connection it can no longer read').toBe(true);
		// The header a client reads to learn the same thing, exactly once. uWS
		// emits it itself for a response finished with its close flag, so a
		// refusal that writes one as well puts the field on the wire twice.
		const headBlock = raw.split('\r\n\r\n')[0];
		const closeHeaders = headBlock.split('\r\n')
			.filter((line) => line.toLowerCase().replace(/ /g, '') === 'connection:close');
		expect(closeHeaders, 'exactly one Connection: close line').toHaveLength(1);
		return raw;
	}

	describe('a Transfer-Encoding this server cannot read as exactly chunked', () => {
		it('refuses a coding it does not know', async () => {
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: xchunked']);
		}, 30000);

		it('refuses chunked applied twice', async () => {
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: chunked, chunked']);
		}, 30000);

		it('refuses a coding list ending in chunked', async () => {
			// RFC 9112 6.1 allows the list, and this server decodes only the
			// chunked half of it, so it is refused rather than half-read.
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: gzip, chunked']);
		}, 30000);

		it('refuses chunked that is not the final coding', async () => {
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: chunked, gzip']);
		}, 30000);

		it('refuses a coding with no chunked at all', async () => {
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: gzip']);
		}, 30000);

		it('serves a conformant chunked request and keeps the connection', async () => {
			// The control arm. Without it the rule above would be satisfied by
			// refusing every chunked request, which no case here would notice.
			const { statuses, closedByServer } = await probe(
				port,
				['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: chunked', 'content-type: application/octet-stream'],
				CHUNKED_AA
			);
			expect(statuses[0]).toBe('200');
			expect(closedByServer, 'a served request keeps its connection').toBe(false);
		}, 30000);

		it('serves a value the parser has to trim first', async () => {
			// The rule compares the whole value against one token, so it leans on
			// the parser handing it a trimmed one. A conformant client may put
			// optional whitespace around a field value (RFC 9112 5), and if that
			// whitespace arrived intact this rule would answer 400 and hang up on
			// it. Nothing else measures that, and it is the shape most likely to
			// break a real client rather than an attacker.
			const { statuses, closedByServer } = await probe(
				port,
				['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding:  chunked ', 'content-type: application/octet-stream'],
				CHUNKED_AA
			);
			expect(statuses[0]).toBe('200');
			expect(closedByServer).toBe(false);
		}, 30000);

		it('reads the value case-insensitively', async () => {
			// `Chunked` is the same coding; refusing it would break a conformant
			// client over a spelling the grammar calls equal.
			const { statuses, closedByServer } = await probe(
				port,
				['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding: Chunked', 'content-type: application/octet-stream'],
				CHUNKED_AA
			);
			expect(statuses[0]).toBe('200');
			expect(closedByServer).toBe(false);
		}, 30000);
	});

	describe('a framing header sent with no value at all', () => {
		it('refuses an empty Transfer-Encoding, which names no coding', async () => {
			// Invisible to a header lookup, which answers the empty string for an
			// absent header too, so only the whole header set can refuse it.
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Transfer-Encoding:'], '');
		}, 30000);

		it('refuses an empty Content-Length, which names no length', async () => {
			await expectRefusedAndClosed(['POST /ssr-echo HTTP/1.1', 'Content-Length:'], '');
		}, 30000);
	});

	describe('a framing header sent twice', () => {
		it('refuses the same header twice, whatever the values say', async () => {
			// Two counts are two readings even when they agree, and the sender
			// left bytes on the connection under one of them.
			await expectRefusedAndClosed(
				['POST /ssr-echo HTTP/1.1', 'Content-Length: 2', 'Content-Length: 3'],
				'AA'
			);
		}, 30000);
	});

	describe('the refusal reaches every lane, not just the one that renders', () => {
		it('refuses ahead of the static file lane', async () => {
			// The static lane answers before any header collection, so a guard
			// placed with the collectors would serve this 200 and leave the
			// ambiguous bytes on the connection.
			const served = await probe(port, ['GET /test.txt HTTP/1.1'], '');
			expect(served.statuses[0], 'the asset exists').toBe('200');
			expect(served.closedByServer, 'an ordinary asset keeps its connection').toBe(false);

			await expectRefusedAndClosed(['GET /test.txt HTTP/1.1', 'Transfer-Encoding: xchunked']);
		}, 30000);

		it('serves an asset for the two shapes only a header walk could see', async () => {
			// The line this package draws, pinned so it cannot move unnoticed.
			// The edge asks ONE header lookup, which cannot tell an absent
			// Transfer-Encoding from one sent empty, and returns the first of a
			// repeated Content-Length. Both are refused on every lane that
			// builds a header set; on a built asset they are served.
			//
			// It is a price, not an oversight: against the built static lane, the
			// walk that would close these two costs about 8% of every asset
			// answer, where a lookup form costs at most a few percent
			// (bench/39-request-framing-guard-ab.mjs). Moving the line means
			// rerunning that bench, and this case going red is how you find out
			// it moved.
			const emptyTE = await probe(port, ['GET /test.txt HTTP/1.1', 'Transfer-Encoding:'], '');
			expect(emptyTE.statuses[0], 'an empty Transfer-Encoding on the fast path').toBe('200');

			const repeated = await probe(
				port,
				['GET /test.txt HTTP/1.1', 'Content-Length: 2', 'Content-Length: 3'],
				'AA'
			);
			expect(repeated.statuses[0], 'a repeated Content-Length on the fast path').toBe('200');
		}, 30000);

		it('refuses on the authenticate path', async () => {
			// A repeated Content-Length, not a Transfer-Encoding shape: the one
			// lookup in front of every route reads the first value of a repeat
			// and sees nothing wrong, so this reaches the authenticate door,
			// which builds the header set and refuses there. A Transfer-Encoding
			// probe would be answered by the wrapper and this case would stay
			// green with the door's own wiring deleted.
			await expectRefusedAndClosed([
				'POST /__ws/auth HTTP/1.1',
				'x-requested-with: XMLHttpRequest',
				'Content-Length: 2',
				'Content-Length: 3'
			], 'AA');
		}, 30000);

		it('refuses on a lane that answers without reading a header set', async () => {
			// The health probe is answered from the request method alone, with no
			// header collection anywhere in it, and a fronting load balancer
			// polls it constantly. It is refused because the guard wraps the
			// route registrations rather than living inside one handler; write
			// the guard into a lane instead and this is the case that catches
			// the lane that was forgotten.
			const served = await probe(port, ['GET /healthz HTTP/1.1'], '');
			expect(served.statuses[0], 'the probe answers').toBe('200');

			await expectRefusedAndClosed(['GET /healthz HTTP/1.1', 'Transfer-Encoding: xchunked']);
		}, 30000);

		it('refuses a WebSocket handshake that frames a body', async () => {
			// The handshake does not go through the route wrapper - uWS takes an
			// options object there, not a handler - so the upgrade callback asks
			// the same question itself.
			await expectRefusedAndClosed([...HANDSHAKE, 'Transfer-Encoding: xchunked']);
		}, 30000);
	});

	it('keeps the connection open for a refusal that is not about framing', async () => {
		// The discriminator. A repeated Authorization line is refused too, and
		// nothing about it makes the remaining bytes unreadable, so that
		// connection answers the request pipelined behind it. Close the
		// connection on every 400 and this case goes red.
		const { statuses, closedByServer } = await probe(
			port,
			['GET / HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
			''
		);
		expect(statuses[0]).toBe('400');
		expect(closedByServer, 'a non-framing refusal keeps the connection').toBe(false);
	}, 30000);
});

describeUWS('the built runtime, with its connection gate full', () => {
	// The production ordering, on a build whose gate can actually be filled.
	// `waitingdefault` sets maxConnections to 2, so two held sockets shut the
	// gate for real, and the refusal that answers a third handshake writes a
	// 503 and KEEPS its connection. That is what the framing answer has to come
	// before: delete the lookup at the top of the upgrade callback and this
	// case reads 503 on an open connection instead of 400 on a closed one.
	let server;
	let port;
	const held = [];

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'waitingdefault' });
		port = Number(new URL(server.httpUrl).port);
		held.push(await connectRealClient(server.wsUrl));
		held.push(await connectRealClient(server.wsUrl));
	}, 400000);

	afterAll(async () => {
		for (const client of held) await client.close();
		await server?.stop();
	});

	it('answers the framing question before the capacity one', async () => {
		const plain = await probe(port, HANDSHAKE, '');
		expect(plain.statuses[0], 'two held sockets shut the gate').toBe('503');
		expect(plain.closedByServer, 'and that refusal keeps its connection').toBe(false);

		const framed = await probe(port, [...HANDSHAKE, 'Transfer-Encoding: xchunked'], CHUNKED_AA);
		expect(framed.statuses[0], 'framing is answered ahead of capacity').toBe('400');
		expect(framed.closedByServer, 'and it hangs up').toBe(true);
	}, 30000);
});

describeUWS('the admin lane, on a build that mounts a handler', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => { await server?.stop(); });

	it('refuses through its own JSON writer and hangs up', async () => {
		// The lane has a writer of its own, and the rule has to be wired into
		// it rather than inherited. A repeated Content-Length is the probe,
		// because the one lookup in front of every route cannot see a repeat -
		// it reads the first value - so this reaches the admin handler, which
		// builds the header set and refuses there. A Transfer-Encoding shape
		// would be answered by the wrapper before this lane ever ran, and the
		// case would pass without the lane being wired at all.
		//
		// The default build mounts no admin handler, which is why this block
		// boots the variant that does.
		const served = await probe(port, ['GET /__realtime/introspect HTTP/1.1'], '');
		expect(served.statuses[0], 'the lane answers without a framing header').toBe('200');

		const { statuses, raw, closedByServer } = await probe(
			port,
			['GET /__realtime/introspect HTTP/1.1', 'Content-Length: 2', 'Content-Length: 3'],
			'AA'
		);
		expect(statuses[0]).toBe('400');
		expect(raw, 'the admin writer answers, not the request edge').toContain('bad request');
		expect(closedByServer).toBe(true);
	}, 30000);
});

describeUWS('the test server mirrors the framing refusal', () => {
	let mirror;

	// Per case, not per block: more than one case here boots a mirror onto the
	// same handle, and an afterAll would close only the last of them.
	afterEach(async () => {
		await mirror?.close();
		mirror = null;
	});

	it('answers the framing question before the siege short-circuit', async () => {
		// The mirror's upgrade guard sits at the top of its upgrade callback for
		// the same reason production's does: the refusal below it writes a 503
		// and KEEPS the connection, so a handshake whose framing this server and
		// the one in front of it read differently has to be answered first.
		//
		// Siege, not a full gate: it refuses every new upgrade at static-serve
		// cost while the gate still has free slots, and it is the FIRST refusal
		// under the guard. The block above fills a real connection ceiling
		// instead, which is the other side of the same ordering.
		const { createTestServer } = await import('../src/testing.js');
		const metrics = recordingRegistry();
		const sieged = await createTestServer({
			metrics,
			protection: 'siege',
			upgradeAdmission: { maxConcurrent: 50 },
			handler: { upgrade: () => ({}) }
		});
		try {
			const plain = await probe(sieged.port, HANDSHAKE, '');
			expect(plain.statuses[0], 'siege refuses every new upgrade').toBe('503');
			expect(plain.closedByServer, 'and that refusal keeps its connection').toBe(false);

			const framed = await probe(sieged.port, [...HANDSHAKE, 'Transfer-Encoding: xchunked'], CHUNKED_AA);
			expect(framed.statuses[0], 'framing is answered before the posture').toBe('400');
			expect(framed.closedByServer, 'and it hangs up').toBe(true);
			expect(metrics.reason('upgrade_rejected_total', 'ambiguous_framing')).toBe(1);
			expect(metrics.reason('upgrade_rejected_total', 'siege')).toBe(1);
		} finally {
			await sieged.close();
		}
	}, 30000);

	it('refuses on a mirror lane that answers from the method alone', async () => {
		// The wrapper is applied to each of the mirror's eight HTTP
		// registrations one by one, and the handshake above is not one of them -
		// it asks inside its own callback - so probing the handshake alone
		// leaves all eight able to lose theirs unnoticed. The health probe is
		// the cheapest of them and reads no header set at all, so only the
		// wrapper can refuse it.
		const { createTestServer } = await import('../src/testing.js');
		mirror = await createTestServer({ handler: { upgrade: () => ({}) } });

		const served = await probe(mirror.port, ['GET /healthz HTTP/1.1'], '');
		expect(served.statuses[0], 'the probe answers').toBe('200');
		expect(served.closedByServer).toBe(false);

		const framed = await probe(
			mirror.port,
			['GET /healthz HTTP/1.1', 'Transfer-Encoding: xchunked'],
			CHUNKED_AA
		);
		expect(framed.statuses[0]).toBe('400');
		expect(framed.closedByServer, 'and it hangs up').toBe(true);
	}, 30000);

	it('refuses the handshake and counts it under its own reason', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const metrics = recordingRegistry();
		mirror = await createTestServer({ metrics, handler: { upgrade: () => ({}) } });

		const { statuses, closedByServer } = await probe(
			mirror.port,
			[...HANDSHAKE, 'Transfer-Encoding: xchunked'],
			''
		);
		expect(statuses[0]).toBe('400');
		expect(closedByServer).toBe(true);
		// An operator reading the dashboard sees WHY: a framing disagreement is
		// not the repeated header the same door refuses under its own label.
		expect(metrics.reason('upgrade_rejected_total', 'ambiguous_framing')).toBe(1);
		expect(metrics.reason('upgrade_rejected_total', 'duplicate_header')).toBe(0);
	}, 30000);
});
