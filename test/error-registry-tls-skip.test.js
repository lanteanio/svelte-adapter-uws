// ADAPTER-ERR-TLS-RELOAD-SKIPPED, driven from the condition it claims: a
// renewal on disk that does not validate is skipped, the previous certificate
// keeps serving, and the reload path marks itself degraded so the quiet
// failure is not silent. The case boots the built runtime with real
// certificates, then overwrites the on-disk cert with one that does not pair
// with the key and drives the reload the watcher or a primary broadcast
// would.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
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
const describeMaybe = hasUWS && openssl !== null ? describe : describe.skip;
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describeMaybe('ADAPTER-ERR-TLS-RELOAD-SKIPPED', () => {
	let dir;
	let certDir;
	let server = null;
	let diagnostic = null;

	function gen(name) {
		const key = join(dir, name + '.key');
		const crt = join(dir, name + '.crt');
		execFileSync(openssl, [
			'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
			'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
		], { stdio: 'ignore' });
		return { key, crt };
	}

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'tls-skip-'));
		certDir = mkdtempSync(join(tmpdir(), 'tls-skip-live-'));
		const boot = gen('boot');
		copyFileSync(boot.crt, join(certDir, 'cert.pem'));
		copyFileSync(boot.key, join(certDir, 'key.pem'));
		server = await startRealRuntime({
			variant: 'tlsskip',
			env: { SSL_CERT: join(certDir, 'cert.pem'), SSL_KEY: join(certDir, 'key.pem') }
		});
		diagnostic = await import(pathToFileURL(join(fixtureDir, 'build-tls-skip', 'diagnostic.js')).href);
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
		rmSync(dir, { recursive: true, force: true });
		rmSync(certDir, { recursive: true, force: true });
	});

	it('a renewal that does not validate is skipped, kept off the wire, and marked degraded', async () => {
		const events = [];
		const dispose = diagnostic.setOperationalEventSink((record) => { events.push(record); });
		try {
			const before = server.handler.tlsReloadState();
			expect(before.degraded).toBeNull();
			expect(before.generation).toBe(0);

			// The renewal lands half-broken: a fresh certificate over the OLD
			// key - the exact mismatch a partial write produces.
			const renewal = gen('renewal');
			copyFileSync(renewal.crt, join(certDir, 'cert.pem'));
			server.handler.reloadTls();

			const hit = events.find((e) => e.event === 'tls.reload-skipped');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error).toBeTruthy();

			// The consequence's both halves: nothing swapped (the previous
			// certificate is fully intact), and the path knows it is degraded
			// rather than reading healthy while the served leaf runs down.
			const after = server.handler.tlsReloadState();
			expect(after.generation).toBe(0);
			expect(after.degraded).toBeTruthy();
			expect(String(after.degraded)).toContain('previous one is still being served');
		} finally {
			dispose();
		}
	});
});
