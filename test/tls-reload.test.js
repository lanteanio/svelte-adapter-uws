import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSniHosts, readCertIdentity, applyServerNames, createCertWatcher, reloadClusterTls } from '../src/runtime/utils/tls-reload.js';

// Cert parsing / server-name reconciliation needs a real X.509 cert with a SAN.
// We generate a couple at setup with openssl; if none is found, those cases skip
// while the injected-deps watcher test still runs. The binary must be resolved at
// module scope: describe-vs-skip is decided at collection time, so a beforeAll
// discovery would register the cert suites before learning openssl is missing.
// On Windows the shell PATH often lacks openssl, but Git for Windows bundles one.
function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
	}
	for (const bin of candidates) {
		try {
			execFileSync(bin, ['version'], { stdio: 'ignore' });
			return bin;
		} catch {}
	}
	return null;
}
const openssl = findOpenssl();
const hasOpenssl = openssl !== null;
let dir;
const certs = {};

function gen(name, cn, san, subj) {
	const key = join(dir, name + '.key');
	const crt = join(dir, name + '.crt');
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', subj || ('/CN=' + cn), '-addext', 'subjectAltName=' + san
	], { stdio: 'ignore' });
	return { key, crt };
}

beforeAll(() => {
	if (!hasOpenssl) return;
	dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
	// A: a.example.com + a wildcard. B: a.example.com + c.example.com (b/wildcard
	// gone, c new, a shared). D: CN only, no SAN DNS.
	certs.A = gen('a', 'a.example.com', 'DNS:a.example.com,DNS:*.api.example.com');
	certs.B = gen('b', 'a.example.com', 'DNS:a.example.com,DNS:c.example.com');
	certs.CN = gen('cn', 'legacy.example.com', 'IP:10.0.0.1'); // no DNS SAN -> CN fallback
	// CN-trap: an earlier RDN value literally contains "CN=", CN is last, no SAN DNS.
	certs.CNTRAP = gen('cntrap', null, 'IP:10.0.0.2', '/O=Foo CN=Corp/CN=host.example.com');
});

function readPem(p) { return readFileSync(p, 'utf8'); }

function mockApp() {
	const calls = { add: [], remove: [] };
	return {
		calls,
		addServerName(host, options) { calls.add.push({ host, options }); },
		removeServerName(host) { calls.remove.push(host); }
	};
}

const describeSsl = () => (hasOpenssl ? describe : describe.skip);

describeSsl()('parseSniHosts', () => {
	it('returns the SAN DNS names (incl. wildcards), sorted + de-duplicated', () => {
		const hosts = parseSniHosts(readPem(certs.A.crt));
		expect(hosts).toEqual(['*.api.example.com', 'a.example.com']);
	});

	it('falls back to the subject CN when the cert has no SAN DNS name', () => {
		const hosts = parseSniHosts(readPem(certs.CN.crt));
		expect(hosts).toEqual(['legacy.example.com']);
	});

	it('anchors the CN fallback at an RDN boundary (ignores a literal CN= inside another RDN)', () => {
		// Subject: O="Foo CN=Corp", CN=host.example.com. An unanchored /CN=.../ would
		// capture 'Corp' from the O value; matching only a line starting with CN= wins.
		const hosts = parseSniHosts(readPem(certs.CNTRAP.crt));
		expect(hosts).toEqual(['host.example.com']);
	});
});

describeSsl()('readCertIdentity', () => {
	it('returns the cert fingerprint and its SAN hosts without touching any app', () => {
		const id = readCertIdentity(certs.A.crt);
		expect(id.hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(id.fingerprint).toMatch(/^([0-9A-F]{2}:)+[0-9A-F]{2}$/);
		// Different cert bytes -> different fingerprint (the change-detection key).
		expect(readCertIdentity(certs.B.crt).fingerprint).not.toBe(id.fingerprint);
	});

	it('honors an explicit host override instead of SAN discovery', () => {
		const id = readCertIdentity(certs.A.crt, ['override.example.com']);
		expect(id.hosts).toEqual(['override.example.com']);
	});

	it('throws on an unreadable cert so boot can disable hot-reload loudly', () => {
		expect(() => readCertIdentity(join(dir, 'nope.crt'))).toThrow();
	});
});

describeSsl()('applyServerNames', () => {
	it('skips untouched (changed: false) when the disk cert fingerprint matches prev', () => {
		// The lazy-activation core: boot state carries the boot cert's fingerprint
		// and NO registered hosts; a watcher double-fire / unchanged-cert broadcast
		// must leave the app exactly as it was.
		const app = mockApp();
		const bootFp = readCertIdentity(certs.A.crt).fingerprint;
		const result = applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key }, { hosts: [], fingerprint: bootFp });
		expect(result).toEqual({ hosts: [], fingerprint: bootFp, changed: false });
		expect(app.calls.add).toEqual([]);
		expect(app.calls.remove).toEqual([]);
	});

	it('registers every served host on the first genuine change (empty prev hosts)', () => {
		// Boot state fingerprint belongs to a DIFFERENT cert than the one now on
		// disk -> the overlay activates and registers all hosts fresh.
		const app = mockApp();
		const bootFp = readCertIdentity(certs.B.crt).fingerprint;
		const result = applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key }, { hosts: [], fingerprint: bootFp });
		expect(result.changed).toBe(true);
		expect(result.hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(result.fingerprint).toBe(readCertIdentity(certs.A.crt).fingerprint);
		expect(app.calls.add.map((c) => c.host).sort()).toEqual(['*.api.example.com', 'a.example.com']);
		expect(app.calls.remove).toEqual([]);
		// The add carries the file paths so uWS reads the current cert bytes.
		expect(app.calls.add[0].options).toMatchObject({ cert_file_name: certs.A.crt, key_file_name: certs.A.key });
	});

	it('diffs on reload: removes gone hosts, reloads shared, adds new', () => {
		// Swap cert A's files for cert B's content in place, then reconcile from A's state.
		const app = mockApp();
		copyFileSync(certs.B.crt, join(dir, 'live.crt'));
		copyFileSync(certs.B.key, join(dir, 'live.key'));
		const prev = { hosts: ['*.api.example.com', 'a.example.com'], fingerprint: readCertIdentity(certs.A.crt).fingerprint };
		const result = applyServerNames(app, { certPath: join(dir, 'live.crt'), keyPath: join(dir, 'live.key') }, prev);
		expect(result.changed).toBe(true);
		expect(result.hosts).toEqual(['a.example.com', 'c.example.com']);
		// *.api gone -> removed; a shared -> reloaded (remove+add); c new -> added.
		expect(app.calls.remove).toContain('*.api.example.com'); // gone
		expect(app.calls.remove).toContain('a.example.com');     // reloaded
		expect(app.calls.add.map((c) => c.host)).toContain('a.example.com'); // re-added
		expect(app.calls.add.map((c) => c.host)).toContain('c.example.com'); // new
		expect(app.calls.add.map((c) => c.host)).not.toContain('*.api.example.com');
	});

	it('honors an explicit host override instead of SAN discovery', () => {
		const app = mockApp();
		const result = applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key, hosts: ['override.example.com'] }, { hosts: [], fingerprint: null });
		expect(result.hosts).toEqual(['override.example.com']);
		expect(app.calls.add.map((c) => c.host)).toEqual(['override.example.com']);
	});

	it('throws and does not touch the app on an unparseable (half-written) cert', () => {
		const app = mockApp();
		const badCrt = join(dir, 'bad.crt');
		writeFileSync(badCrt, '-----BEGIN CERTIFICATE-----\nnot a real cert\n-----END CERTIFICATE-----\n');
		expect(() => applyServerNames(app, { certPath: badCrt, keyPath: certs.A.key }, { hosts: ['a.example.com'], fingerprint: 'AA:BB' })).toThrow();
		expect(app.calls.add).toEqual([]);
		expect(app.calls.remove).toEqual([]);
	});

	it('throws on a cert/key mismatch (never registers a broken pair)', () => {
		const app = mockApp();
		expect(() => applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.B.key }, { hosts: [], fingerprint: null })).toThrow(/do not match/);
		expect(app.calls.add).toEqual([]);
	});

	it('marks a mid-apply throw with tlsAppTouched so callers can tell a partial swap from an untouched app', () => {
		// Validation throws leave the app untouched (asserted above) and carry no
		// marker; a throw from the mutation loop means the swap is PARTIAL and the
		// caller must escalate + force a retry instead of claiming the previous
		// cert was kept.
		const app = mockApp();
		app.addServerName = () => { throw new Error('native add failed'); };
		let caught = null;
		try {
			applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key }, { hosts: [], fingerprint: null });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeTruthy();
		expect(caught.tlsAppTouched).toBe(true);

		// A non-Error throw from the native layer is normalized so it cannot
		// dodge the marker.
		const rawApp = mockApp();
		rawApp.addServerName = () => { throw 'native string throw'; };
		let normalized = null;
		try {
			applyServerNames(rawApp, { certPath: certs.A.crt, keyPath: certs.A.key }, { hosts: [], fingerprint: null });
		} catch (err) {
			normalized = err;
		}
		expect(normalized).toBeInstanceOf(Error);
		expect(normalized.tlsAppTouched).toBe(true);
		expect(normalized.message).toContain('native string throw');

		// The pre-mutation counterpart: a key mismatch throws WITHOUT the marker.
		let validation = null;
		try {
			applyServerNames(mockApp(), { certPath: certs.A.crt, keyPath: certs.B.key }, { hosts: [], fingerprint: null });
		} catch (err) {
			validation = err;
		}
		expect(validation).toBeTruthy();
		expect(validation.tlsAppTouched).toBeUndefined();
	});
});

describe('createCertWatcher (injected clock + fs)', () => {
	function fakeTimers() {
		let seq = 0;
		const pending = new Map();
		return {
			setTimer: (cb, ms) => { const id = ++seq; pending.set(id, { cb, at: ms }); return id; },
			clearTimer: (id) => { pending.delete(id); },
			fireAll: () => { const cbs = [...pending.values()].map((p) => p.cb); pending.clear(); cbs.forEach((cb) => cb()); },
			size: () => pending.size
		};
	}

	it('coalesces a burst of fs events into a single debounced onChange', () => {
		const t = fakeTimers();
		let fsCallback;
		const watchFs = (_dir, _opts, cb) => { fsCallback = cb; return { close() {} }; };
		let reloads = 0;
		const w = createCertWatcher({ certPath: '/certs/live.crt', debounceMs: 500, onChange: () => { reloads++; }, watchFs, setTimer: t.setTimer, clearTimer: t.clearTimer });
		w.start();

		// Five rapid events - each reschedules; only the last timer survives.
		for (let i = 0; i < 5; i++) fsCallback('change', 'live.crt');
		expect(t.size()).toBe(1);
		expect(reloads).toBe(0);
		t.fireAll();
		expect(reloads).toBe(1);
		w.stop();
	});

	it('start() is idempotent and stop() clears a pending debounce timer', () => {
		const t = fakeTimers();
		let watchers = 0;
		const watchFs = () => { watchers++; return { close() {} }; };
		let reloads = 0;
		const w = createCertWatcher({ certPath: '/certs/live.crt', onChange: () => { reloads++; }, watchFs, setTimer: t.setTimer, clearTimer: t.clearTimer });
		w.start();
		w.start(); // idempotent - no second watcher
		expect(watchers).toBe(1);
		w.stop();
		expect(t.size()).toBe(0);
		expect(() => w.stop()).not.toThrow(); // safe repeat
	});

	it('surfaces a watchFs error from start() (fs.watch throws ENOENT on a missing dir) so the caller must guard it', () => {
		// Node's fs.watch throws synchronously when the watched directory is absent.
		// The watcher does not swallow it - callers (lifecycle.js, index.js primary)
		// wrap start() to degrade gracefully instead of crashing the process.
		const watchFs = () => { const e = new Error("ENOENT: no such file or directory, watch '/no/such/dir'"); e.code = 'ENOENT'; throw e; };
		const w = createCertWatcher({ certPath: '/no/such/dir/live.crt', onChange: () => {}, watchFs });
		expect(() => w.start()).toThrow(/ENOENT/);
	});
});

// The cluster-primary reload action: an UNCONDITIONAL broadcast to every worker
// (each worker fingerprint-gates its own apply), plus an observability refresh
// of the primary's view of the disk cert. The primary terminates no TLS, so no
// app is ever touched here. The broadcast paths need no certs; the identity
// refresh uses a real cert (openssl-gated).
function mockWorker() {
	const posted = [];
	return { posted, postMessage(msg) { posted.push(msg); } };
}

describe('reloadClusterTls (cluster broadcast)', () => {
	it('broadcasts {type:tls-reload} to every worker (no source to read)', () => {
		const workers = [mockWorker(), mockWorker(), mockWorker()];
		const state = reloadClusterTls({ workers, state: { hosts: ['prev.example.com'], fingerprint: 'AA:BB' } });
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
		// No source -> the primary's cert-identity state is returned unchanged.
		expect(state).toEqual({ hosts: ['prev.example.com'], fingerprint: 'AA:BB' });
	});

	it('does not let one exiting worker (postMessage throws) stop the broadcast', () => {
		const good1 = mockWorker();
		const bad = { postMessage() { throw new Error('worker exiting'); } };
		const good2 = mockWorker();
		expect(() => reloadClusterTls({ workers: [good1, bad, good2] })).not.toThrow();
		expect(good1.posted).toEqual([{ type: 'tls-reload' }]);
		expect(good2.posted).toEqual([{ type: 'tls-reload' }]);
	});

	it('reports an unreadable cert via onError but still broadcasts and keeps the prior state', () => {
		const workers = [mockWorker()];
		let errored = null;
		const state = reloadClusterTls({
			workers,
			source: { certPath: '/no/such/cert.crt' },
			state: { hosts: ['kept.example.com'], fingerprint: 'AA:BB' },
			onError: (err) => { errored = err; }
		});
		expect(errored).toBeTruthy(); // onError fired with the thrown cert-read error
		expect(String(errored.message || errored)).toMatch(/ENOENT|no such file/);
		expect(state).toEqual({ hosts: ['kept.example.com'], fingerprint: 'AA:BB' }); // read threw -> prior state kept
		expect(workers[0].posted).toEqual([{ type: 'tls-reload' }]); // workers still notified
	});
});

describeSsl()('reloadClusterTls (identity refresh with a real cert)', () => {
	it('refreshes the primary state from the disk cert and broadcasts to workers', () => {
		const workers = [mockWorker(), mockWorker()];
		const state = reloadClusterTls({
			workers,
			source: { certPath: certs.A.crt },
			state: { hosts: [], fingerprint: null }
		});
		// The primary now reflects the cert on disk...
		expect(state.hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(state.fingerprint).toBe(readCertIdentity(certs.A.crt).fingerprint);
		// ...and every worker was told to reload its own context.
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
	});
});
