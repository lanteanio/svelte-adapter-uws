// ADAPTER-ERR-TLS-SWAP and ADAPTER-ERR-TLS-WATCH, driven from the conditions
// they claim.
//
// TLS-SWAP's cause is a swap that failed partway through applying a new
// certificate set. The two partial shapes its consequence names are produced
// by applyServerNames: a host already moved to the new certificate (whose
// fresh SNI router is empty until the caller replays routes), and a host
// removed but not yet re-added (which falls back to the default context and
// the boot-time certificate). The cases drive the pure export with a
// recording app and real certificate files, and hold it to the contract the
// entry stands on: a mutation-phase throw is MARKED (tlsAppTouched), a
// validation throw leaves the app untouched, and an unchanged fingerprint is
// a no-op.
//
// TLS-WATCH's consequence promises the degraded state STAYS set: a dead
// directory watch cannot be resurrected by any later reload, so the
// arm-time catch-up swapping a renewal that was already on disk must not
// read as recovery. That decision lives in the degraded-state ledger, a
// pure export, driven here for every transition the two entries describe.
//
// The full serving behaviors behind the shapes - the mirrored router after a
// successful swap, the default-context fallback for unmatched SNI - are
// driven with real handshakes in test/tls-watch.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyServerNames, createTlsDegradedLedger } from '../src/runtime/utils/tls-reload.js';
import { hasUWS, EVAL_TIME_ENV, freePort } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
		if (process.env.SystemDrive) {
			candidates.push(join(process.env.SystemDrive, '\\', 'Program Files', 'Git', 'usr', 'bin', 'openssl.exe'));
		}
	}
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ['version'], { stdio: 'ignore' });
			return candidate;
		} catch { /* try the next */ }
	}
	return null;
}

const openssl = findOpenssl();
const describeOpenssl = openssl !== null ? describe : describe.skip;

/** A uWS-shaped app that records every SNI mutation and can throw on cue. */
function recordingApp({ throwOnAdd = null } = {}) {
	const calls = [];
	return {
		calls,
		addServerName(host) {
			if (host === throwOnAdd) throw new Error(`refused ${host}`);
			calls.push(['add', host]);
		},
		removeServerName(host) {
			calls.push(['remove', host]);
		}
	};
}

describe('ADAPTER-ERR-TLS-WATCH: the degraded-state ledger', () => {
	function build() {
		const health = { degraded: null };
		const recovered = [];
		let armed = 0;
		let disarmed = 0;
		const ledger = createTlsDegradedLedger({
			health,
			onRecovered: (was, still) => recovered.push([was, still]),
			armSentinel: () => { armed++; },
			disarmSentinel: () => { disarmed++; }
		});
		return { health, recovered, ledger, armed: () => armed, disarmed: () => disarmed };
	}

	it('a reload failure is cleared by the next success', () => {
		const s = build();
		s.ledger.failed('the certificate on disk did not validate');
		expect(s.health.degraded).toBe('the certificate on disk did not validate');
		expect(s.armed()).toBe(1);
		s.ledger.recovered();
		expect(s.health.degraded).toBeNull();
		expect(s.disarmed()).toBe(1);
		expect(s.recovered).toEqual([['the certificate on disk did not validate', null]]);
	});

	it('a dead watch survives the catch-up swap that succeeds after it', () => {
		const s = build();
		s.ledger.watchFailed('the watch failed to start');
		// The arm-time catch-up finds a renewal on disk and swaps it in.
		s.ledger.recovered();
		// The swap cannot resurrect the watcher: still degraded, sentinel still
		// armed, and no recovery line for a state that did not recover.
		expect(s.health.degraded).toBe('the watch failed to start');
		expect(s.disarmed()).toBe(0);
		expect(s.recovered).toEqual([]);
	});

	it('a later swap failure is superseded, then falls back to the watch reason', () => {
		const s = build();
		s.ledger.watchFailed('the watch failed to start');
		s.ledger.failed('a certificate swap failed mid-apply');
		expect(s.health.degraded).toBe('a certificate swap failed mid-apply');
		s.ledger.recovered();
		expect(s.health.degraded).toBe('the watch failed to start');
		expect(s.recovered).toEqual([['a certificate swap failed mid-apply', 'the watch failed to start']]);
		expect(s.disarmed()).toBe(0);
	});

	it('without a dead watch, repeated failures collapse into one recovery', () => {
		const s = build();
		s.ledger.failed('first');
		s.ledger.failed('second');
		s.ledger.recovered();
		expect(s.health.degraded).toBeNull();
		expect(s.recovered).toEqual([['second', null]]);
		expect(s.disarmed()).toBe(1);
	});
});

describeOpenssl('ADAPTER-ERR-TLS-SWAP: the partial-swap shapes', () => {
	let dir;
	let boot;
	let renewal;

	function gen(name) {
		const key = join(dir, name + '.key');
		const crt = join(dir, name + '.crt');
		execFileSync(openssl, [
			'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
			'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
		], { stdio: 'ignore' });
		const fingerprint = new X509Certificate(readFileSync(crt, 'utf8')).fingerprint256;
		return { key, crt, fingerprint };
	}

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'tls-swap-claims-'));
		boot = gen('boot');
		renewal = gen('renewal');
	}, 120000);

	it('a mutation-phase throw is marked, leaving a recorded partial swap', () => {
		// Two overridden hosts; the second add refuses. The state left behind
		// is exactly the entry's two shapes at once: host a moved to the new
		// certificate (entry: fresh empty router until the routes are
		// replayed), host b removed and never re-added (entry: default
		// context, boot certificate).
		const app = recordingApp({ throwOnAdd: 'b.example' });
		const prev = { hosts: ['a.example', 'b.example'], fingerprint: 'served-before' };
		let caught = null;
		try {
			applyServerNames(app, { certPath: renewal.crt, keyPath: renewal.key, hosts: ['a.example', 'b.example'] }, prev);
		} catch (err) {
			caught = err;
		}
		expect(caught, 'the mid-loop refusal must throw').toBeTruthy();
		expect(caught.tlsAppTouched, 'a mutation-phase throw must carry the marker').toBe(true);
		expect(app.calls).toEqual([
			['remove', 'a.example'], ['add', 'a.example'],
			['remove', 'b.example']
		]);
	});

	it('a validation throw is unmarked and the app is untouched', () => {
		// Mismatched pair: the renewal certificate against the boot key. The
		// entry's contrast - the previous certificate fully intact - holds
		// only if nothing mutated the app before the throw.
		const app = recordingApp();
		let caught = null;
		try {
			applyServerNames(app, { certPath: renewal.crt, keyPath: boot.key, hosts: ['localhost'] }, { hosts: [], fingerprint: 'served-before' });
		} catch (err) {
			caught = err;
		}
		expect(caught, 'a key mismatch must throw').toBeTruthy();
		expect(caught.tlsAppTouched).toBeUndefined();
		expect(app.calls).toEqual([]);
	});

	it('an unchanged fingerprint is a no-op that never touches the app', () => {
		const app = recordingApp();
		const result = applyServerNames(
			app,
			{ certPath: renewal.crt, keyPath: renewal.key, hosts: ['localhost'] },
			{ hosts: ['localhost'], fingerprint: renewal.fingerprint }
		);
		expect(result.changed).toBe(false);
		expect(app.calls).toEqual([]);
	});
});

const describeWatchWiring = (openssl !== null && hasUWS) ? describe : describe.skip;

describeWatchWiring('ADAPTER-ERR-TLS-WATCH: the wiring against the built runtime', () => {
	let dir;
	let boot;
	let renewal;

	function gen(name) {
		const key = join(dir, name + '.key');
		const crt = join(dir, name + '.crt');
		execFileSync(openssl, [
			'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
			'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
		], { stdio: 'ignore' });
		return { key, crt };
	}

	beforeAll(() => {
		expect(buildFixtureOnce('tlswatch')).toBe(true);
		dir = mkdtempSync(join(tmpdir(), 'tls-watch-wiring-'));
		boot = gen('boot');
		renewal = gen('renewal');
	}, 400000);

	it('the watch-failure degradation survives the reload that succeeds after it', async () => {
		// The dedicated variant gives this suite its own module identity: the
		// TLS environment is eval-time, and this module must be the one that
		// evaluated under THIS suite's paths.
		const certDir = mkdtempSync(join(tmpdir(), 'tls-watch-dead-'));
		copyFileSync(boot.crt, join(certDir, 'cert.pem'));
		copyFileSync(boot.key, join(certDir, 'key.pem'));

		const envBefore = EVAL_TIME_ENV.map((key) => [key, process.env[key]]);
		for (const key of EVAL_TIME_ENV) delete process.env[key];
		process.env.SSL_CERT = join(certDir, 'cert.pem');
		process.env.SSL_KEY = join(certDir, 'key.pem');
		try {
			const handler = await import(pathToFileURL(join(fixtureDir, variantOut('tlswatch'), 'handler.js')).href);
			// The SSLApp holds the boot certificate; the directory can now
			// vanish, which is what start()'s watch arming will hit.
			rmSync(certDir, { recursive: true, force: true });
			await handler.start('127.0.0.1', await freePort());
			try {
				const afterBoot = handler.tlsReloadState();
				expect(afterBoot.watching, 'the watch must have failed').toBe(false);
				expect(afterBoot.degraded, 'the failed boot must be degraded').toBeTruthy();

				// A renewal lands, and the reload the primary broadcast path
				// would drive succeeds - the entry's catch-up window.
				mkdirSync(certDir, { recursive: true });
				copyFileSync(renewal.crt, join(certDir, 'cert.pem'));
				copyFileSync(renewal.key, join(certDir, 'key.pem'));
				handler.reloadTls();

				const after = handler.tlsReloadState();
				// The renewal WAS served (the consequence's catch-up sentence)...
				expect(after.generation, 'the renewal must have been swapped in').toBe(1);
				// ...and the degradation survives it: the watcher is still dead,
				// so a success must fall back to the watch reason, not clear.
				expect(after.watching).toBe(false);
				expect(after.degraded).toBe('the certificate directory watch failed to start, so no renewal will be seen');
			} finally {
				try { await handler.shutdown(); } catch { /* already down */ }
				try { handler.forceCloseApp(); } catch { /* already closed */ }
			}
		} finally {
			for (const [key, value] of envBefore) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(certDir, { recursive: true, force: true });
		}
	}, 120000);
});
