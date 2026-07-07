import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const messages = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) { messages.push({ binary: data }); return; }
		messages.push(JSON.parse(data.toString()));
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, messages };
}

const tick = () => new Promise(r => setTimeout(r, 40));

// Build a control-SHAPED text frame (byte[3] = 'y', i.e. begins {"type) of at
// least `size` bytes by padding an extra field. The pad content is irrelevant:
// the server rejects on size + prefix alone, without parsing.
function oversizedControlFrame(size) {
	const head = '{"type":"subscribe","topic":"chat","ref":1,"pad":"';
	const tail = '"}';
	const pad = 'x'.repeat(Math.max(0, size - head.length - tail.length));
	return head + pad + tail;
}

// Build a data-event SHAPED text frame (byte[3] = 'o', i.e. begins {"topic).
function oversizedDataFrame(size) {
	const head = '{"topic":"chat","event":"e","data":"';
	const tail = '"}';
	const pad = 'x'.repeat(Math.max(0, size - head.length - tail.length));
	return head + pad + tail;
}

describeUWS('control-frame size ceiling reject', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('rejects an oversized control-shaped frame with CONTROL_FRAME_TOO_LARGE and does not deliver it', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const appReceived = [];
		server = await createTestServer({
			handler: {
				message(_ws, ctx) { appReceived.push(ctx); }
			}
		});

		const { ws, messages } = await connectClient(server.wsUrl);
		await tick();
		const frame = oversizedControlFrame(9000);
		expect(frame.length).toBeGreaterThanOrEqual(8192);
		expect(frame.charCodeAt(3)).toBe(0x79); // 'y'
		ws.send(frame);
		await tick();

		const err = messages.find(m => m.type === 'error');
		expect(err).toBeDefined();
		expect(err.code).toBe('CONTROL_FRAME_TOO_LARGE');
		expect(err.limit).toBe(8192);
		// The offending frame's byte length rides along: the frame was
		// rejected without parsing, so no ref can be echoed and the size is
		// what identifies which frame overflowed.
		expect(err.size).toBe(Buffer.byteLength(frame));
		// The rejected frame must NOT reach the application message hook.
		expect(appReceived.length).toBe(0);

		ws.close();
	});

	it('counts the CONTROL_FRAME_TOO_LARGE reject in the connection outbound totals', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const { controlFrameTooLargeFrame } = await import('../src/runtime/wire.js');
		const closes = [];
		server = await createTestServer({
			handler: { close(_ws, ctx) { closes.push(ctx); } }
		});

		async function runConn(sendOversized) {
			const { ws } = await connectClient(server.wsUrl);
			await tick();
			if (sendOversized) {
				ws.send(oversizedControlFrame(9000));
				await tick();
			}
			ws.close();
			await new Promise(res => ws.on('close', res));
			await tick();
		}

		await runConn(false); // baseline: welcome only
		await runConn(true);  // welcome + CONTROL_FRAME_TOO_LARGE reject

		const [ctrl, rej] = closes;
		const rejectLen = controlFrameTooLargeFrame(Buffer.byteLength(oversizedControlFrame(9000))).length;
		// The reject is outbound traffic: it adds exactly one message and its bytes
		// to the connection totals. The delta would be 0 if the reject bypassed the
		// outbound counter, as it did before it was made symmetric with the other
		// control-demux sends (welcome / lease-ok / resumed / ingress-ok / denied).
		expect(rej.messagesOut - ctrl.messagesOut).toBe(1);
		expect(rej.bytesOut - ctrl.bytesOut).toBe(rejectLen);
	});

	it('does not reject a data-event-shaped frame over the ceiling; it falls through to the app hook', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const appReceived = [];
		server = await createTestServer({
			handler: {
				message(_ws, ctx) { appReceived.push(ctx); }
			}
		});

		const { ws, messages } = await connectClient(server.wsUrl);
		await tick();
		const frame = oversizedDataFrame(9000);
		expect(frame.charCodeAt(3)).toBe(0x6f); // 'o'
		ws.send(frame);
		await tick();

		expect(messages.find(m => m.type === 'error')).toBeUndefined();
		// A large user data-event frame is not control-shaped: it reaches the app.
		expect(appReceived.length).toBe(1);
		expect(appReceived[0].msg).toBeUndefined();

		ws.close();
	});

	it('acks a control frame just under the ceiling normally (no error)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({});

		const { ws, messages } = await connectClient(server.wsUrl);
		await tick();
		// A normal small subscribe is well under 8192 bytes.
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat', ref: 7 }));
		await tick();

		expect(messages.find(m => m.type === 'error')).toBeUndefined();
		const ack = messages.find(m => m.type === 'subscribed' && m.topic === 'chat');
		expect(ack).toBeDefined();
		expect(ack.ref).toBe(7);

		ws.close();
	});
});
