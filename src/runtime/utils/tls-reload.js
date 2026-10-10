// TLS certificate hot-reload (on by default for a TLS server; SSL_WATCH=0 opts
// out). When a renewed cert lands on disk (certbot, cert-manager), a debounced
// directory watch re-reads it and swaps the served cert without re-binding the
// listen socket: the renewed cert is registered as uWS SNI server names for its
// host(s) (auto-discovered from the SAN), so new TLS handshakes matching the
// SNI get the fresh cert while in-flight connections survive.
//
// The SNI overlay is LAZY: nothing is registered at boot - the boot cert is
// served by the SSLApp default context alone, exactly as with SSL_WATCH=0.
// applyServerNames is gated on the cert's fingerprint256, so the overlay
// activates only when the cert on disk genuinely differs from the one being
// served. This matters because a uWS server name carries its OWN (empty) HTTP
// router: whoever activates the overlay MUST replay the app's routes onto each
// host's domain router (route-registry.js mirrorRoutes), and again after every
// swap - `changed: true` in the return value is that signal. The uWS default
// context is NOT hot-swappable, so a non-SNI or unmatched-SNI client keeps the
// boot-time cert until a restart (documented).
//
// Pure/injectable by construction: parseSniHosts, readCertIdentity and
// applyServerNames are pure over their inputs, and createCertWatcher takes its
// clock (setTimer/clearTimer) and fs (watchFs) as injected dependencies,
// defaulting to the runtime seam so the debounce stays deterministic under a
// seeded harness (check-determinism).

import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync, statSync as fsStatSync, watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { setTimer as seamSetTimer, clearTimer as seamClearTimer } from '../runtime.js';

/**
 * Discover the hostnames a certificate serves. Prefers the SAN DNS entries and
 * falls back to the subject CN for legacy single-name certs. Wildcards
 * (`*.api.example.com`) are kept verbatim - uWS SNI matches them. Pure: PEM text
 * in, a sorted de-duplicated lower-case host list out.
 *
 * @param {string} certPem
 * @returns {string[]}
 */
export function parseSniHosts(certPem) {
	const cert = new X509Certificate(certPem);
	const hosts = new Set();
	// subjectAltName looks like: "DNS:a.example.com, DNS:*.api.example.com, IP Address:10.0.0.1"
	const san = cert.subjectAltName;
	if (san) {
		for (const entry of san.split(',')) {
			const trimmed = entry.trim();
			if (trimmed.startsWith('DNS:')) {
				const host = trimmed.slice(4).trim().toLowerCase();
				if (host) hosts.add(host);
			}
		}
	}
	// CN fallback only when the cert carries no SAN DNS names. node:crypto prints
	// the subject as newline-separated RDNs, so match CN only at an RDN boundary (a
	// line beginning with `CN=`); a literal "CN=" inside an earlier RDN value must
	// not be mistaken for the Common Name.
	if (hosts.size === 0 && cert.subject) {
		for (const line of cert.subject.split('\n')) {
			if (line.startsWith('CN=')) {
				const host = line.slice(3).trim().toLowerCase();
				if (host) hosts.add(host);
			}
		}
	}
	return [...hosts].sort();
}

/**
 * Read the identity of the certificate on disk without touching any app: its
 * fingerprint256 (the change-detection key for the fingerprint gate), the host
 * list it serves, and when it expires. Throws on an unreadable / unparseable
 * cert, so callers can disable hot-reload loudly at boot instead of failing on
 * the first renewal.
 *
 * The expiry is carried in both forms on purpose: `notAfterText` is the
 * certificate's own rendering (what an operator sees from `openssl x509`) and
 * goes into log lines verbatim, while `notAfter` is the epoch form the
 * remaining-validity arithmetic needs, and is null for a certificate whose date
 * this platform cannot parse.
 *
 * @param {string} certPath
 * @param {string[]} [overrideHosts] overrides SAN auto-discovery (SSL_SNI_HOSTS)
 * @returns {{ fingerprint: string, hosts: string[], notAfter: number | null, notAfterText: string }}
 */
export function readCertIdentity(certPath, overrideHosts) {
	const certPem = readFileSync(certPath, 'utf8');
	const cert = new X509Certificate(certPem);
	const hosts = (overrideHosts && overrideHosts.length > 0) ? overrideHosts : parseSniHosts(certPem);
	const notAfter = Date.parse(cert.validTo);
	return {
		fingerprint: cert.fingerprint256,
		hosts,
		notAfter: Number.isNaN(notAfter) ? null : notAfter,
		notAfterText: cert.validTo
	};
}

/**
 * How close to expiry a certificate has to be before a broken reload path is
 * worth waking someone over. Two weeks: longer than every automated renewal
 * cadence in use (certbot renews at 30 days, cert-manager at a third of the
 * lifetime), so reaching this window means renewal has already failed several
 * times over, and short enough that the line is not permanent background noise.
 */
const CERT_EXPIRY_ALERT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Remaining validity in the form an operator reads at 3am.
 * @param {number} ms
 * @returns {string}
 */
function formatRemaining(ms) {
	if (ms <= 0) return 'ALREADY EXPIRED';
	const days = Math.floor(ms / 86400000);
	const hours = Math.floor((ms % 86400000) / 3600000);
	if (days > 0) return `${days}d ${hours}h left`;
	const minutes = Math.floor((ms % 3600000) / 60000);
	return `${hours}h ${minutes}m left`;
}

/**
 * The line an operator needs when certificate hot-reload is broken AND the
 * certificate still being served is running out - or null when there is nothing
 * to say.
 *
 * This is the reporting half of "a failed reload keeps the previous cert". That
 * choice protects availability, and it also hides the failure: every probe
 * stays green, the renewed certificate on disk is never served, and the first
 * symptom is every handshake failing at once. Nothing else in the process knows
 * both halves - that renewal is dead, and how long the served leaf has left -
 * so nothing else can raise this.
 *
 * Deliberately NOT wired to readiness: taking a fleet out of rotation because
 * its certificate is near expiry removes a service that is still serving fine,
 * at the exact moment it can least afford it. Report loudly, keep serving.
 *
 * Pure, so the rule (only while degraded, only inside the window) is testable
 * without a clock, a watcher or a certificate.
 *
 * @param {{ degraded?: string | null, notAfter?: number | null, notAfterText?: string | null }} state
 * @param {number} now wall-clock epoch ms
 * @param {number} [withinMs] alert window before expiry
 * @returns {string | null}
 */
export function certExpiryAlert(state, now, withinMs = CERT_EXPIRY_ALERT_MS) {
	if (!state || !state.degraded) return null;
	if (typeof state.notAfter !== 'number' || !Number.isFinite(state.notAfter)) return null;
	const remaining = state.notAfter - now;
	if (remaining > withinMs) return null;
	// The varying tail only: the invariant head lives in the error registry
	// (TLS_DEGRADED_EXPIRY) and callers print through adapterConsoleLine, so
	// the emitted line is searchable by its indexed prefix.
	return (
		`${state.degraded}) and the certificate being served expires ` +
		`${state.notAfterText || state.notAfter} (${formatRemaining(remaining)}). A failed reload keeps the PREVIOUS ` +
		'certificate, so a renewal landing on disk will not fix this by itself: check the certificate files and restart this instance.'
	);
}

/**
 * The degraded-state ledger for one process's certificate reload path. One
 * shared slot reports the CURRENT reason serving is degraded, but reasons
 * differ in what can clear them: a swap or validation failure is superseded
 * by the next reload that succeeds, while a dead directory watch cannot be -
 * no later swap resurrects the watcher, so after any recovery the ledger
 * falls back to the watch reason instead of clearing. The sentinel follows
 * the same rule: it stays armed as long as any reason, the sticky watch
 * reason included, remains. Kept separate from the lifecycle wiring so the
 * policy is executable without a server, a watcher, or a certificate.
 *
 * @param {{
 *   health: { degraded: string | null },
 *   onRecovered: (was: string, still: string | null) => void,
 *   armSentinel: () => void,
 *   disarmSentinel: () => void
 * }} options
 */
export function createTlsDegradedLedger({ health, onRecovered, armSentinel, disarmSentinel }) {
	let watchReason = null;
	return {
		/** The directory watch is dead for the process lifetime; sticky. */
		watchFailed(reason) {
			watchReason = reason;
			health.degraded = reason;
			armSentinel();
		},
		/** A reload-path failure; superseded by the next reload that succeeds. */
		failed(reason) {
			health.degraded = reason;
			armSentinel();
		},
		/** A reload succeeded: clear what a success can clear. */
		recovered() {
			if (watchReason !== null) {
				// The swap worked, the watcher is still dead: this process will
				// not see the next renewal, so the degradation and its expiry
				// sentinel stay.
				if (health.degraded !== watchReason) {
					onRecovered(health.degraded, watchReason);
					health.degraded = watchReason;
				}
				return;
			}
			if (health.degraded !== null) {
				onRecovered(health.degraded, null);
				health.degraded = null;
			}
			disarmSentinel();
		}
	};
}

/**
 * Reconcile the uWS app's SNI server names with the certificate now on disk,
 * gated on the cert's fingerprint: when the disk cert is byte-identical to the
 * one already served (`prev.fingerprint`), the app is not touched and
 * `changed: false` is returned - watcher double-fires and unchanged-cert
 * broadcasts cost one file read, and the lazy overlay stays inactive until a
 * genuine renewal.
 *
 * On a change, the cert + key are read and VALIDATED (parse + pairing) before
 * the app is touched, so a half-written file throws here and the caller keeps
 * `prev` and the old context - TLS is never dropped on a partial write.
 * Existing hosts are reloaded (remove + add; uSockets refuses a duplicate
 * addServerName) so the fresh cert is served; new hosts are added; gone hosts
 * are removed. A swap REPLACES each host's SNI domain router with a fresh empty
 * one, so on `changed: true` the caller MUST replay the app's routes onto the
 * returned hosts (route-registry.js mirrorRoutes) before the next request.
 *
 * @param {{ addServerName: (host: string, options: object) => void, removeServerName: (host: string) => void }} app
 * @param {{ certPath: string, keyPath: string, hosts?: string[] }} source
 *   `hosts` overrides SAN auto-discovery when provided (SSL_SNI_HOSTS).
 * @param {{ hosts: string[], fingerprint: string | null }} prev
 *   the hosts currently registered and the fingerprint of the cert they serve
 *   (boot state: `hosts: []` + the boot cert's fingerprint - nothing registered,
 *   default context serving).
 * @returns {{ hosts: string[], fingerprint: string, changed: boolean }}
 */
export function applyServerNames(app, source, prev) {
	const prevHosts = (prev && prev.hosts) || [];
	const prevFingerprint = (prev && prev.fingerprint) || null;
	const certPem = readFileSync(source.certPath, 'utf8');
	const cert = new X509Certificate(certPem);
	if (prevFingerprint !== null && cert.fingerprint256 === prevFingerprint) {
		// Same cert as last time - nothing to swap, app untouched.
		return { hosts: prevHosts, fingerprint: prevFingerprint, changed: false };
	}
	// Validate BEFORE mutating the app. A partial write makes one of these throw,
	// and the caller keeps the old registration + context (never drops TLS).
	const keyPem = readFileSync(source.keyPath, 'utf8');
	const key = createPrivateKey(keyPem);
	if (!cert.checkPrivateKey(key)) {
		throw new Error('tls-reload: certificate and private key do not match');
	}
	const hosts = (source.hosts && source.hosts.length > 0) ? source.hosts : parseSniHosts(certPem);
	if (hosts.length === 0) {
		throw new Error('tls-reload: certificate has no SAN DNS names or CN, and no SSL_SNI_HOSTS override');
	}
	const options = { cert_file_name: source.certPath, key_file_name: source.keyPath };
	const prevSet = new Set(prevHosts);
	const next = new Set(hosts);
	// Everything below mutates the app. A throw from here on leaves it PARTIALLY
	// swapped (some hosts on the new cert, possibly with a fresh unmirrored
	// domain router), which the caller must treat differently from the
	// validation throws above (app untouched, previous cert fully intact) - so
	// mark the error before rethrowing.
	try {
		// Remove hosts this cert no longer serves.
		for (const host of prevSet) {
			if (!next.has(host)) app.removeServerName(host);
		}
		// Add new hosts; reload (remove + add) already-registered hosts so the swap
		// takes effect for a renewed cert on the same host.
		for (const host of next) {
			if (prevSet.has(host)) app.removeServerName(host);
			app.addServerName(host, options);
		}
	} catch (err) {
		// Normalize before marking: a non-Error throw (or a frozen Error, which
		// would reject the property write) must not dodge the marker - an
		// unmarked mutation-phase throw would make the caller claim the previous
		// cert was kept when the app is in fact partially swapped.
		const e = (err instanceof Error && !Object.isFrozen(err)) ? err : new Error(String(err && err.message ? err.message : err));
		e.tlsAppTouched = true;
		throw e;
	}
	return { hosts, fingerprint: cert.fingerprint256, changed: true };
}

/**
 * Watch the DIRECTORY containing the certificate and fire a debounced `onChange`.
 * Directory-watch (not file-watch) survives the atomic rename / symlink swap
 * certbot and cert-manager use, which a file-watch misses. Time and fs access are
 * injected (defaulting to the runtime seam + node:fs) so the debounce is
 * deterministic under test and routed through the injectable timer.
 *
 * `start()` throws what the platform throws when the watch cannot be
 * established at all; `onError` reports a watch that dies AFTER starting.
 * That death reaches the watcher two ways, and both end the same: the watch
 * is closed, the caller hears about it once, and nothing re-arms it.
 *
 * The platform may report its own failure as an `error` event, which with no
 * listener is rethrown and otherwise fatal (see `start`). Or it may not: a
 * watched directory that is removed or replaced is a dead watch on every
 * platform - inotify watches the inode and drops the watch with it, and a
 * Windows directory handle keeps narrating its own deletion - and none of
 * them says so through `error`. What they do say is an event that names the
 * WATCHED DIRECTORY ITSELF rather than an entry inside it (inotify spells it
 * as the directory's basename, Windows as its full path), so that spelling is
 * the trigger for a check of the directory's identity: gone, or a different
 * inode at the same path, means the watch is dead. A replaced directory gets
 * one final debounced read, because what replaced it is very often the
 * renewal itself; a removed one gets none. Nothing else costs a stat - an
 * event naming an entry never does - and the storm a deleted Windows
 * directory produces is closed on its first event.
 *
 * @param {{ certPath: string, onChange: () => void, onError?: (err: any) => void, dir?: string, debounceMs?: number, watchFs?: typeof import('node:fs').watch, statFs?: typeof import('node:fs').statSync, setTimer?: Function, clearTimer?: Function }} config
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createCertWatcher(config) {
	const dir = config.dir || dirname(config.certPath);
	const base = basename(dir);
	const debounceMs = typeof config.debounceMs === 'number' && config.debounceMs >= 0 ? config.debounceMs : 500;
	const watchFs = config.watchFs || fsWatch;
	const statFs = config.statFs || fsStatSync;
	const setTimer = config.setTimer || seamSetTimer;
	const clearTimer = config.clearTimer || seamClearTimer;
	let watcher = null;
	let timer = null;
	/** The watched directory's inode identity at start, or null when the platform reports none. */
	let identity = null;

	function schedule() {
		if (timer) clearTimer(timer);
		// Coalesce a burst of fs events (a multi-file cert+key write, an editor's
		// write-then-rename) into a single reload after the quiet window.
		timer = setTimer(() => { timer = null; config.onChange(); }, debounceMs);
	}

	/** @returns {{ dev: bigint, ino: bigint } | null} null on a filesystem that reports no inode */
	function identityOf() {
		const st = statFs(dir, { bigint: true });
		if (typeof st.ino !== 'bigint' || st.ino === 0n) return null;
		return { dev: st.dev, ino: st.ino };
	}

	/**
	 * Whether an event names an entry inside the directory. A non-recursive
	 * watch delivers a bare entry name for those; the directory's own basename,
	 * its full path, or no name at all is the platform talking about the
	 * watched directory itself.
	 * @param {string | null | undefined} name
	 */
	function namesAnEntry(name) {
		if (typeof name !== 'string' || name.length === 0 || name === base) return false;
		for (let i = 0; i < name.length; i++) {
			const c = name.charCodeAt(i);
			if (c === 47 || c === 92) return false;
		}
		return true;
	}

	/** The watch is dead: close it, drop what was pending, tell the caller once. */
	function lost(started, err) {
		if (watcher !== started) return;
		watcher = null;
		if (timer) { clearTimer(timer); timer = null; }
		try { started.close(); } catch { /* already gone */ }
		try { config.onError?.(err); } catch { /* reporting must not kill the watch owner */ }
	}

	function onEvent(started, name) {
		if (watcher !== started) return;
		if (namesAnEntry(name)) { schedule(); return; }
		// The event is about the directory itself. That is also what a chmod
		// or a subdirectory count change on a live directory looks like, so
		// the identity decides, not the spelling.
		let now;
		try {
			now = identityOf();
		} catch (err) {
			lost(started, err);
			return;
		}
		if (identity !== null && now !== null && (now.dev !== identity.dev || now.ino !== identity.ino)) {
			const err = new Error(`the watched certificate directory was replaced by a different directory at the same path, watch '${dir}'`);
			lost(started, err);
			// What replaced it is present and readable, and is very often the
			// renewal - so it gets the read a live watch would have given it.
			// The timer outlives the watcher; stop() still clears it.
			schedule();
			return;
		}
		schedule();
	}

	return {
		start() {
			if (watcher) return;
			// persistent:false so the watcher never holds the event loop open.
			const started = watchFs(dir, { persistent: false }, (_type, name) => onEvent(started, name));
			watcher = started;
			try {
				identity = identityOf();
			} catch {
				// The directory went away between the watch and the stat. The
				// watch is already dead, and its first event says so.
				identity = null;
			}
			// An FSWatcher reports a failure that happens AFTER it started - a
			// permission change, the platform's watch limit - as an `error`
			// EVENT, and an `error` event with no listener is rethrown by
			// EventEmitter. Unhandled, that is an uncaught exception raised by a
			// certificate watcher, which on a cluster primary takes the whole
			// fleet with it. So the listener is attached whether or not the
			// caller passes `onError`: not crashing is the point, and being told
			// is the option.
			//
			// Nothing re-arms a watch that has died, so it is closed here rather
			// than left to fire again, and the caller hears about it once. A
			// late error from a watcher that `stop()` already replaced is
			// dropped - that one is not this watch any more.
			if (started && typeof started.on === 'function') {
				started.on('error', (err) => lost(started, err));
			}
		},
		stop() {
			if (timer) { clearTimer(timer); timer = null; }
			if (watcher) {
				try { watcher.close(); } catch { /* already closed */ }
				watcher = null;
			}
		}
	};
}

/**
 * The cluster-primary TLS reload action, fired by the primary's cert-directory
 * watcher on a renewed cert. The primary terminates no TLS in either cluster
 * mode - reuseport workers own their listen sockets outright, and an acceptor
 * primary only distributes accepted connections to the child worker apps, which
 * run the TLS handshakes on their own contexts - so the primary's whole job is
 * the broadcast: post `{ type: 'tls-reload' }` to every worker so each swaps
 * its OWN app's context. The broadcast is UNCONDITIONAL - each worker
 * fingerprint-gates its own apply (applyServerNames `changed: false`), so an
 * unchanged cert costs each worker one file read and a no-op.
 *
 * The primary also refreshes its own view of the cert's identity (fingerprint +
 * hosts) for observability; a cert that fails to parse is reported via
 * `onError` and the previous state is kept (workers validate independently and
 * keep serving the previous cert). The per-worker post is best-effort (a worker
 * mid-exit may throw).
 *
 * Pure over its inputs apart from the postMessage side effects and the cert
 * read, so a unit test drives it with mock workers.
 *
 * @param {{
 *   workers: Iterable<{ postMessage: (msg: any) => void }>,
 *   source?: { certPath: string, hosts?: string[] },
 *   state?: { hosts: string[], fingerprint: string | null, notAfter?: number | null, notAfterText?: string | null },
 *   onError?: (err: any) => void
 * }} args
 * @returns {{ hosts: string[], fingerprint: string | null, notAfter?: number | null, notAfterText?: string | null }}
 *   the refreshed cert identity, expiry included (the input `state` unchanged
 *   when there is no source or the read threw)
 */
export function reloadClusterTls({ workers, source, state, onError }) {
	let next = state || { hosts: [], fingerprint: null, notAfter: null, notAfterText: null };
	if (source) {
		try {
			next = readCertIdentity(source.certPath, source.hosts);
		} catch (err) {
			try { onError?.(err); } catch { /* reporting must not interrupt the worker broadcast */ }
		}
	}
	for (const worker of workers) {
		try { worker.postMessage({ type: 'tls-reload' }); } catch { /* worker exiting */ }
	}
	return next;
}
