// Allocate free OS-assigned ports for the dev and prod e2e servers.
//
// The previous setup hardcoded 49321 and 49322. Both numbers fall inside
// Windows' Hyper-V dynamic exclusion range (which is auto-assigned at
// boot and can include any sub-range of 49152-65535), so on a typical
// Windows + Hyper-V box the e2e suite cannot bind and fails immediately
// with EACCES on ::1:<port>.
//
// Asking the OS for a free port via listen(0) returns a port that was
// available at the moment of the call. The OS will not return a Hyper-V-
// excluded port, so the allocated port is guaranteed to be bindable from
// userspace.
//
// We cache the allocation into env vars (E2E_DEV_PORT, E2E_PROD_PORT)
// so that child processes spawned by global-setup (dev-server.js,
// prod-server.js) and Playwright workers all see the same numbers via
// the same process tree's inherited env. Re-importing this module in a
// child process picks up the env-cached value instead of allocating a
// new one.
//
// Race window: between this module's `srv.close()` and the actual server
// binding the port, another process could in theory grab it. In practice
// the gap is a few ms and the test runner is single-tenant, so the race
// is extremely unlikely. If it ever bites, just re-run.

import { createServer } from 'node:net';

/**
 * Bind to port 0 on 127.0.0.1, read what the OS assigned, then release it.
 * @returns {Promise<number>}
 */
function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close();
				return reject(new Error('listen(0) returned no address'));
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Read a port from `envVar` if already set in this process tree, else
 * allocate a fresh one and stash it into `envVar` for inheritance.
 * @param {string} envVar
 * @returns {Promise<number>}
 */
async function getOrAllocate(envVar) {
	if (process.env[envVar]) return Number(process.env[envVar]);
	const port = await pickFreePort();
	process.env[envVar] = String(port);
	return port;
}

export const DEV_PORT = await getOrAllocate('E2E_DEV_PORT');
export const PROD_PORT = await getOrAllocate('E2E_PROD_PORT');
