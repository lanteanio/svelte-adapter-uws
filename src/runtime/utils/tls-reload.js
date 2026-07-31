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
import { readFileSync, watch as fsWatch } from 'node:fs';
import { dirname } from 'node:path';
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
	return (
		`[tls] certificate hot-reload is DEGRADED (${state.degraded}) and the certificate being served expires ` +
		`${state.notAfterText || state.notAfter} (${formatRemaining(remaining)}). A failed reload keeps the PREVIOUS ` +
		'certificate, so a renewal landing on disk will not fix this by itself: check the certificate files and restart this instance.'
	);
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
 * @param {{ certPath: string, onChange: () => void, dir?: string, debounceMs?: number, watchFs?: typeof import('node:fs').watch, setTimer?: Function, clearTimer?: Function }} config
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createCertWatcher(config) {
	const dir = config.dir || dirname(config.certPath);
	const debounceMs = typeof config.debounceMs === 'number' && config.debounceMs >= 0 ? config.debounceMs : 500;
	const watchFs = config.watchFs || fsWatch;
	const setTimer = config.setTimer || seamSetTimer;
	const clearTimer = config.clearTimer || seamClearTimer;
	let watcher = null;
	let timer = null;

	function schedule() {
		if (timer) clearTimer(timer);
		// Coalesce a burst of fs events (a multi-file cert+key write, an editor's
		// write-then-rename) into a single reload after the quiet window.
		timer = setTimer(() => { timer = null; config.onChange(); }, debounceMs);
	}

	return {
		start() {
			if (watcher) return;
			// persistent:false so the watcher never holds the event loop open.
			watcher = watchFs(dir, { persistent: false }, () => schedule());
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
			if (onError) onError(err);
		}
	}
	for (const worker of workers) {
		try { worker.postMessage({ type: 'tls-reload' }); } catch { /* worker exiting */ }
	}
	return next;
}
