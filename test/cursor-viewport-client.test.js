// Client-side tests for reportViewport() in the cursor plugin: it sends a
// rAF-coalesced { type: 'cursor-viewport', topic, rect } frame, resolving the
// rect from a scroll-container element, an explicit rect, or a getter.

import { describe, it, expect, beforeEach } from 'vitest';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
		this.binaryType = 'blob';
		MockWebSocket._last = this;
		queueMicrotask(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.();
			}
		});
	}
	send(data) { this._sent.push(data); }
	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });
// Deterministic rAF so the coalesced flush fires on the next macrotask.
globalThis.requestAnimationFrame = /** @type {any} */ ((cb) => setTimeout(cb, 0));

const clientModule = await import('../client.js');
const cursorClient = await import('../plugins/cursor/client.js');

const flush = () => new Promise((r) => setTimeout(r, 5));
function viewportFrames(mock, from) {
	return mock._sent
		.slice(from)
		.filter((s) => typeof s === 'string')
		.map((s) => JSON.parse(s))
		.filter((m) => m.type === 'cursor-viewport');
}

describe('cursor client reportViewport', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* none */ }
		MockWebSocket._last = null;
	});

	it('sends a cursor-viewport frame from an explicit rect', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		cursorClient.reportViewport('board', { x: 10, y: 20, w: 640, h: 480, zoom: 1 });
		await flush();

		const frames = viewportFrames(mock, before);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: 'cursor-viewport', topic: 'board', rect: { x: 10, y: 20, w: 640, h: 480, zoom: 1 } });
	});

	it('computes the rect from a scroll-container-like element (scroll + client size)', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		const el = { scrollLeft: 100, scrollTop: 50, clientWidth: 800, clientHeight: 600 };
		cursorClient.reportViewport('board', el);
		await flush();

		expect(viewportFrames(mock, before)[0].rect).toEqual({ x: 100, y: 50, w: 800, h: 600, zoom: 1 });
	});

	it('resolves a getter source', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		cursorClient.reportViewport('board', () => ({ x: 5, y: 6, w: 7, h: 8 }));
		await flush();

		expect(viewportFrames(mock, before)[0].rect).toEqual({ x: 5, y: 6, w: 7, h: 8, zoom: 1 });
	});

	it('coalesces multiple reports within a frame to the latest', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		cursorClient.reportViewport('board', { x: 1, y: 1, w: 10, h: 10 });
		cursorClient.reportViewport('board', { x: 2, y: 2, w: 20, h: 20 });
		await flush();

		const frames = viewportFrames(mock, before);
		expect(frames).toHaveLength(1);
		expect(frames[0].rect).toEqual({ x: 2, y: 2, w: 20, h: 20, zoom: 1 });
	});

	it('drops an unresolvable source silently (no frame)', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		cursorClient.reportViewport('board', { x: 1 }); // missing y/w/h
		cursorClient.reportViewport('board', null);
		await flush();

		expect(viewportFrames(mock, before)).toHaveLength(0);
	});

	it('drops a degenerate zero-size element or rect (no frame)', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const before = mock._sent.length;

		// Unmounted / collapsed element reports 0x0.
		cursorClient.reportViewport('board', { scrollLeft: 0, scrollTop: 0, clientWidth: 0, clientHeight: 0 });
		// Explicit zero-width / zero-zoom rects.
		cursorClient.reportViewport('board', { x: 0, y: 0, w: 0, h: 100 });
		cursorClient.reportViewport('board', { x: 0, y: 0, w: 100, h: 100, zoom: 0 });
		await flush();

		expect(viewportFrames(mock, before)).toHaveLength(0);
	});
});
