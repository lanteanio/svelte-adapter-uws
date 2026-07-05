/**
 * systemd readiness + watchdog integration (sd_notify).
 *
 * Under a `Type=notify` unit, systemd holds dependents until the service
 * says READY and - when `WatchdogSec=` is set - restarts it if the periodic
 * WATCHDOG ping stops. Both map exactly onto failure modes an HTTP health
 * route cannot cover: "the process is up but the app has not finished
 * booting" and "the process is alive but the event loop is frozen." The
 * watchdog ping is sent from a timer callback on the main loop, so the ping
 * itself IS the liveness proof - a wedged loop never fires it and systemd
 * takes the configured action.
 *
 * Transport: NOTIFY_SOCKET is an AF_UNIX datagram socket, which Node cannot
 * write natively; the notifications go through the `systemd-notify` helper
 * binary (present wherever the socket is). The helper runs as a short-lived
 * child, so the unit needs `NotifyAccess=all` (documented in the README unit
 * example). Every send is best-effort and contained: a missing binary or a
 * failed spawn can never take the server down.
 *
 * Zero-config: everything derives from the environment systemd itself
 * provides. No NOTIFY_SOCKET (any non-systemd host, dev, CI, containers
 * without the passthrough) - complete no-op. WATCHDOG_USEC absent - READY
 * only, no timer.
 *
 * Determinism: the watchdog interval rides the injectable runtime timer
 * seam; env and exec are injectable for tests.
 *
 * @module svelte-adapter-uws/runtime/utils/sd-notify
 */

import { execFile } from 'node:child_process';
import { setIntervalTimer, clearIntervalTimer } from '../runtime.js';

/**
 * @param {{ env?: Record<string, string | undefined>, exec?: (cmd: string, args: string[]) => void }} [deps]
 * @returns {{
 *   enabled: boolean,
 *   ready: () => void,
 *   stopping: () => void,
 *   armWatchdog: () => void,
 *   disarmWatchdog: () => void
 * }}
 */
export function createSdNotify(deps) {
	const env = deps?.env ?? process.env;
	const exec = deps?.exec ?? ((cmd, args) => {
		try {
			const child = execFile(cmd, args, () => { /* best-effort; errors are irrelevant */ });
			child.on('error', () => { /* binary missing - stay silent after the first warn below */ });
		} catch { /* spawn refused synchronously - same contract */ }
	});

	const enabled = typeof env.NOTIFY_SOCKET === 'string' && env.NOTIFY_SOCKET.length > 0;
	const watchdogUsec = enabled ? Number(env.WATCHDOG_USEC) : NaN;
	const hasWatchdog = Number.isFinite(watchdogUsec) && watchdogUsec > 0;
	// Ping at half the timeout (the systemd-recommended cadence), never
	// faster than once a second.
	const watchdogIntervalMs = hasWatchdog ? Math.max(1000, Math.floor(watchdogUsec / 1000 / 2)) : 0;

	/** @type {ReturnType<typeof setIntervalTimer> | null} */
	let watchdogTimer = null;

	function notify(args) {
		if (!enabled) return;
		exec('systemd-notify', args);
	}

	return {
		enabled,
		/** Tell systemd the service finished booting (Type=notify gate). */
		ready() {
			notify(['--ready']);
		},
		/** Tell systemd an orderly shutdown began (status surfaces in systemctl). */
		stopping() {
			notify(['STOPPING=1']);
		},
		/**
		 * Start the periodic watchdog ping. The callback firing from the main
		 * event loop is the liveness proof; a frozen loop stops the pings and
		 * systemd applies the unit's watchdog action. No-op without
		 * WATCHDOG_USEC.
		 */
		armWatchdog() {
			if (!hasWatchdog || watchdogTimer !== null) return;
			watchdogTimer = setIntervalTimer(() => {
				notify(['WATCHDOG=1']);
			}, watchdogIntervalMs);
			if (watchdogTimer && watchdogTimer.unref) watchdogTimer.unref();
		},
		disarmWatchdog() {
			if (watchdogTimer !== null) {
				clearIntervalTimer(watchdogTimer);
				watchdogTimer = null;
			}
		}
	};
}
