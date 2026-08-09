/**
 * Posture push-export: a local stream socket where an external process can
 * follow the adapter's live protection posture.
 *
 * An edge-defense daemon (an L3/L4 filter, a front proxy, a watchdog) wants
 * one thing from the app it protects: "how loaded are you, right now?" -
 * without speaking the app's protocol or scraping metrics over HTTP. This
 * module listens on a unix domain socket (or a Windows named pipe) and
 * pushes newline-delimited JSON:
 *
 *   {"v":1,"posture":"elevated","reason":"PSI","value":0.83,"psi":{...},"cpuThrottle":{...}}
 *
 * A line is pushed to every connected client immediately on connect, on
 * every posture/reason transition, and on every 1 Hz pressure sample. The
 * steady 1 Hz cadence is part of the contract: a consumer that stops
 * receiving lines knows the adapter is gone (killed, frozen, deadlocked)
 * without any extra liveness protocol.
 *
 * Local-only by design: a filesystem socket inherits filesystem
 * permissions, exposes nothing over the network, and carries no client
 * identity or payload data - posture, reason, and kernel pressure numbers
 * only. Consumers are read-only; inbound bytes are ignored.
 *
 * Failure philosophy: the export must never hurt the server it reports on.
 * Listen errors log once and disable the export; a slow or dead consumer
 * with backed-up buffers is disconnected rather than buffered without
 * bound; serialization happens once per push regardless of client count
 * and not at all with zero clients.
 *
 * @module svelte-adapter-uws/runtime/utils/posture-export
 */

import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

// A consumer that cannot drain this much pending posture JSON is not
// consuming; disconnect it rather than queue without bound.
const MAX_CLIENT_BUFFER = 64 * 1024;

/**
 * Start the export server.
 *
 * @param {string} path unix socket path (or `\\\\.\\pipe\\...` on Windows)
 * @param {() => Record<string, any>} getLine builds the current posture line object
 * @returns {{ broadcast: () => void, close: () => void, clientCount: () => number }}
 */
export function startPostureExport(path, getLine) {
	/** @type {Set<import('node:net').Socket>} */
	const clients = new Set();
	let closed = false;

	// A stale socket file from a previous unclean exit would fail the listen
	// with EADDRINUSE even though nothing is serving; remove it first. Named
	// pipes on Windows never hit the filesystem, so the unlink is a no-op
	// there (ENOENT and friends are all non-fatal by design).
	if (!path.startsWith('\\\\')) {
		try { unlinkSync(path); } catch { /* absent or not removable - listen decides */ }
	}

	const server = createServer((socket) => {
		clients.add(socket);
		socket.on('close', () => clients.delete(socket));
		socket.on('error', () => clients.delete(socket));
		// Consumers are read-only; drain and ignore anything they send.
		socket.on('data', () => {});
		try {
			socket.write(JSON.stringify(getLine()) + '\n');
		} catch { /* raced a disconnect */ }
	});
	server.on('error', (err) => {
		console.warn(adapterConsoleLine(ADAPTER_ERROR_IDS.POSTURE_EXPORT_DISABLED,
			'listen on ' + path + ' failed: ' + (err && err.message ? err.message : err)));
		closed = true;
		for (const socket of clients) socket.destroy();
		clients.clear();
	});
	server.listen(path);

	return {
		broadcast() {
			if (closed || clients.size === 0) return;
			let line;
			try {
				line = JSON.stringify(getLine()) + '\n';
			} catch {
				return; // a non-serializable snapshot must not break the sampler
			}
			for (const socket of clients) {
				if (socket.writableLength > MAX_CLIENT_BUFFER) {
					// Not consuming: cut it loose rather than buffer unboundedly.
					socket.destroy();
					clients.delete(socket);
					continue;
				}
				try { socket.write(line); } catch { clients.delete(socket); }
			}
		},
		close() {
			if (closed) return;
			closed = true;
			for (const socket of clients) socket.destroy();
			clients.clear();
			try { server.close(); } catch { /* already down */ }
			if (!path.startsWith('\\\\')) {
				try { unlinkSync(path); } catch { /* best-effort cleanup */ }
			}
		},
		clientCount() {
			return clients.size;
		}
	};
}
