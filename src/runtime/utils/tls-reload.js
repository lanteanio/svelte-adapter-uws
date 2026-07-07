// Opt-in TLS certificate hot-reload. When a renewed cert lands on disk (certbot,
// cert-manager), a debounced directory watch re-reads it and swaps the uWS SNI
// server name for its served host(s) via removeServerName + addServerName - new
// TLS handshakes matching the SNI get the fresh cert, the listen socket is never
// re-bound, and in-flight connections survive. Hostnames are auto-discovered from
// the cert SAN. The uWS default context is NOT hot-swappable, so a non-SNI or
// unmatched-SNI client keeps the boot-time cert until a restart (documented).
//
// Pure/injectable by construction: parseSniHosts and applyServerNames are pure
// over their inputs, and createCertWatcher takes its clock (setTimer/clearTimer)
// and fs (watchFs) as injected dependencies, defaulting to the runtime seam so
// the debounce stays deterministic under a seeded harness (check-determinism).

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
 * Reconcile the uWS app's SNI server names with the certificate now on disk.
 * The cert + key are read and VALIDATED (parse + pairing) before the app is
 * touched, so a half-written file throws here and the caller keeps `prevHosts`
 * and the old context - TLS is never dropped on a partial write. Existing hosts
 * are reloaded (remove + add) so the fresh cert is served; new hosts are added;
 * gone hosts are removed. Returns the reconciled host list.
 *
 * @param {{ addServerName: (host: string, options: object) => void, removeServerName: (host: string) => void }} app
 * @param {{ certPath: string, keyPath: string, hosts?: string[] }} source
 *   `hosts` overrides SAN auto-discovery when provided (SSL_SNI_HOSTS).
 * @param {string[]} prevHosts the hosts currently registered (from the last apply)
 * @returns {string[]} the reconciled host list
 */
export function applyServerNames(app, source, prevHosts) {
	const certPem = readFileSync(source.certPath, 'utf8');
	const keyPem = readFileSync(source.keyPath, 'utf8');
	// Validate BEFORE mutating the app. A partial write makes one of these throw,
	// and the caller keeps the old registration + context (never drops TLS).
	const cert = new X509Certificate(certPem);
	const key = createPrivateKey(keyPem);
	if (!cert.checkPrivateKey(key)) {
		throw new Error('tls-reload: certificate and private key do not match');
	}
	const hosts = (source.hosts && source.hosts.length > 0) ? source.hosts : parseSniHosts(certPem);
	if (hosts.length === 0) {
		throw new Error('tls-reload: certificate has no SAN DNS names or CN, and no SSL_SNI_HOSTS override');
	}
	const options = { cert_file_name: source.certPath, key_file_name: source.keyPath };
	const prev = new Set(prevHosts || []);
	const next = new Set(hosts);
	// Remove hosts this cert no longer serves.
	for (const host of prev) {
		if (!next.has(host)) app.removeServerName(host);
	}
	// Add new hosts; reload (remove + add) already-registered hosts so the swap
	// takes effect for a renewed cert on the same host.
	for (const host of next) {
		if (prev.has(host)) app.removeServerName(host);
		app.addServerName(host, options);
	}
	return hosts;
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
