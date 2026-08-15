// ADAPTER-ERR-POSTURE-EXPORT-DISABLED, the post-listen shape - which no real
// socket can produce on cue, so node:net and the unlink are mocked and every
// line of the error handler is bound deterministically: the shape wording,
// the reader teardown, the listener close, and the path release that must
// happen ONLY when this process bound the path (a failed listen may mean a
// sibling process just won the bind, and unlinking then would unreach the
// winner's live socket). Kept apart from the real-socket suite because the
// module mock replaces node:net for the whole file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const servers = [];

vi.mock('node:net', () => ({
	createServer(onConnection) {
		const server = new EventEmitter();
		server.onConnection = onConnection;
		// The case decides whether the bind wins: it emits 'listening' itself,
		// or goes straight to 'error' for a lost bind.
		server.listen = vi.fn();
		server.close = vi.fn();
		servers.push(server);
		return server;
	}
}));

const unlinked = [];
vi.mock('node:fs', () => ({
	unlinkSync(target) { unlinked.push(target); }
}));

const { startPostureExport } = await import('../src/runtime/utils/posture-export.js');

function fakeReader() {
	const socket = new EventEmitter();
	socket.write = vi.fn();
	socket.destroy = vi.fn();
	return socket;
}

beforeEach(() => {
	servers.length = 0;
	unlinked.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ADAPTER-ERR-POSTURE-EXPORT-DISABLED: a socket error after a successful listen', () => {
	it('names the shape, drops the readers, closes the listener, and releases the path', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const path = '/run/posture/claims.sock';
		const exporter = startPostureExport(path, () => ({ v: 1, posture: 'normal' }));
		const server = servers[0];
		expect(server.listen).toHaveBeenCalledWith(path);
		server.emit('listening');

		const readerA = fakeReader();
		const readerB = fakeReader();
		server.onConnection(readerA);
		server.onConnection(readerB);
		expect(exporter.clientCount()).toBe(2);

		server.emit('error', new Error('accept failed'));

		const lines = warn.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) =>
			l.includes('[ADAPTER-ERR-POSTURE-EXPORT-DISABLED]') && l.includes('socket error on ' + path)
		), `the line must name the post-listen shape: ${lines.join(' | ')}`).toBe(true);
		// The consequence's second half: whichever readers were connected drop.
		expect(readerA.destroy).toHaveBeenCalled();
		expect(readerB.destroy).toHaveBeenCalled();
		expect(exporter.clientCount()).toBe(0);
		// Disabled is real: the listener closes and the bound path is released
		// (the pre-listen repair unlink came first, then the release).
		expect(server.close).toHaveBeenCalled();
		expect(unlinked).toEqual([path, path]);
		// And inert: the sampler keeps calling broadcast without effect.
		expect(() => exporter.broadcast()).not.toThrow();
	});

	it('a failed listen touches nothing beyond its own repair attempt', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const path = '/run/posture/contended.sock';
		startPostureExport(path, () => ({ v: 1 }));
		const server = servers[0];
		// The bind lost - EADDRINUSE, and 'listening' never fired.
		server.emit('error', new Error('listen EADDRINUSE'));

		const lines = warn.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) =>
			l.includes('[ADAPTER-ERR-POSTURE-EXPORT-DISABLED]') && l.includes('listen on ' + path + ' failed')
		), `the line must name the listen shape: ${lines.join(' | ')}`).toBe(true);
		// Only the pre-listen repair unlink ran: the path may now belong to a
		// sibling process that won the bind, and must not be unreached here.
		expect(unlinked).toEqual([path]);
	});
});
