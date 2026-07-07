import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSniHosts, applyServerNames, createCertWatcher, reloadClusterTls } from '../src/runtime/utils/tls-reload.js';

// Cert parsing / server-name reconciliation needs a real X.509 cert with a SAN.
// We generate a couple at setup with openssl (present on dev + CI images); if it
// is missing, those cases skip while the injected-deps watcher test still runs.
let hasOpenssl = true;
let dir;
const certs = {};

function gen(name, cn, san, subj) {
	const key = join(dir, name + '.key');
	const crt = join(dir, name + '.crt');
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', subj || ('/CN=' + cn), '-addext', 'subjectAltName=' + san
	], { stdio: 'ignore' });
	return { key, crt };
}

beforeAll(() => {
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' });
		dir = mkdtempSync(join(tmpdir(), 'tls-reload-'));
		// A: a.example.com + a wildcard. B: a.example.com + c.example.com (b/wildcard
		// gone, c new, a shared). D: CN only, no SAN DNS.
		certs.A = gen('a', 'a.example.com', 'DNS:a.example.com,DNS:*.api.example.com');
		certs.B = gen('b', 'a.example.com', 'DNS:a.example.com,DNS:c.example.com');
		certs.CN = gen('cn', 'legacy.example.com', 'IP:10.0.0.1'); // no DNS SAN -> CN fallback
		// CN-trap: an earlier RDN value literally contains "CN=", CN is last, no SAN DNS.
		certs.CNTRAP = gen('cntrap', null, 'IP:10.0.0.2', '/O=Foo CN=Corp/CN=host.example.com');
	} catch {
		hasOpenssl = false;
	}
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

describeSsl()('applyServerNames', () => {
	it('registers every served host on the first apply', () => {
		const app = mockApp();
		const hosts = applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key }, []);
		expect(hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(app.calls.add.map((c) => c.host).sort()).toEqual(['*.api.example.com', 'a.example.com']);
		expect(app.calls.remove).toEqual([]);
		// The add carries the file paths so uWS reads the current cert bytes.
		expect(app.calls.add[0].options).toMatchObject({ cert_file_name: certs.A.crt, key_file_name: certs.A.key });
	});

	it('diffs on reload: removes gone hosts, reloads shared, adds new', () => {
		// Swap cert A's files for cert B's content in place, then reconcile from A's hosts.
		const app = mockApp();
		copyFileSync(certs.B.crt, join(dir, 'live.crt'));
		copyFileSync(certs.B.key, join(dir, 'live.key'));
		const prev = ['*.api.example.com', 'a.example.com'];
		const hosts = applyServerNames(app, { certPath: join(dir, 'live.crt'), keyPath: join(dir, 'live.key') }, prev);
		expect(hosts).toEqual(['a.example.com', 'c.example.com']);
		// *.api gone -> removed; a shared -> reloaded (remove+add); c new -> added.
		expect(app.calls.remove).toContain('*.api.example.com'); // gone
		expect(app.calls.remove).toContain('a.example.com');     // reloaded
		expect(app.calls.add.map((c) => c.host)).toContain('a.example.com'); // re-added
		expect(app.calls.add.map((c) => c.host)).toContain('c.example.com'); // new
		expect(app.calls.add.map((c) => c.host)).not.toContain('*.api.example.com');
	});

	it('honors an explicit host override instead of SAN discovery', () => {
		const app = mockApp();
		const hosts = applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.A.key, hosts: ['override.example.com'] }, []);
		expect(hosts).toEqual(['override.example.com']);
		expect(app.calls.add.map((c) => c.host)).toEqual(['override.example.com']);
	});

	it('throws and does not touch the app on an unparseable (half-written) cert', () => {
		const app = mockApp();
		const badCrt = join(dir, 'bad.crt');
		writeFileSync(badCrt, '-----BEGIN CERTIFICATE-----\nnot a real cert\n-----END CERTIFICATE-----\n');
		expect(() => applyServerNames(app, { certPath: badCrt, keyPath: certs.A.key }, ['a.example.com'])).toThrow();
		expect(app.calls.add).toEqual([]);
		expect(app.calls.remove).toEqual([]);
	});

	it('throws on a cert/key mismatch (never registers a broken pair)', () => {
		const app = mockApp();
		expect(() => applyServerNames(app, { certPath: certs.A.crt, keyPath: certs.B.key }, [])).toThrow(/do not match/);
		expect(app.calls.add).toEqual([]);
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

// The cluster-primary reload action: broadcast to every worker, and (acceptor
// mode) reload the acceptor app's own context first. The broadcast path needs no
// certs; the acceptor-reload path uses a real cert (openssl-gated).
function mockWorker() {
	const posted = [];
	return { posted, postMessage(msg) { posted.push(msg); } };
}

describe('reloadClusterTls (cluster broadcast)', () => {
	it('broadcasts {type:tls-reload} to every worker (no acceptor app)', () => {
		const workers = [mockWorker(), mockWorker(), mockWorker()];
		const hosts = reloadClusterTls({ workers, acceptorApp: null, acceptorHosts: ['prev.example.com'] });
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
		// No acceptor app -> the acceptor host list is returned unchanged.
		expect(hosts).toEqual(['prev.example.com']);
	});

	it('does not let one exiting worker (postMessage throws) stop the broadcast', () => {
		const good1 = mockWorker();
		const bad = { postMessage() { throw new Error('worker exiting'); } };
		const good2 = mockWorker();
		expect(() => reloadClusterTls({ workers: [good1, bad, good2], acceptorApp: null })).not.toThrow();
		expect(good1.posted).toEqual([{ type: 'tls-reload' }]);
		expect(good2.posted).toEqual([{ type: 'tls-reload' }]);
	});

	it('reports an acceptor reload error via onError but still broadcasts and keeps the prior hosts', () => {
		const workers = [mockWorker()];
		const app = mockApp();
		let errored = null;
		// A source pointing at a nonexistent cert makes applyServerNames throw.
		const hosts = reloadClusterTls({
			workers,
			acceptorApp: app,
			source: { certPath: '/no/such/cert.crt', keyPath: '/no/such/cert.key' },
			acceptorHosts: ['kept.example.com'],
			onError: (err) => { errored = err; }
		});
		expect(errored).toBeTruthy(); // onError fired with the thrown cert-read error
		expect(String(errored.message || errored)).toMatch(/ENOENT|no such file/);
		expect(hosts).toEqual(['kept.example.com']); // reload threw -> prior hosts kept
		expect(app.calls.add).toHaveLength(0); // app never touched on a bad cert
		expect(workers[0].posted).toEqual([{ type: 'tls-reload' }]); // workers still notified
	});
});

describeSsl()('reloadClusterTls (acceptor reload with a real cert)', () => {
	it('reloads the acceptor app SNI in place and broadcasts to workers', () => {
		const workers = [mockWorker(), mockWorker()];
		const app = mockApp();
		const hosts = reloadClusterTls({
			workers,
			acceptorApp: app,
			source: { certPath: certs.A.crt, keyPath: certs.A.key },
			acceptorHosts: []
		});
		// Acceptor registered the cert's SAN hosts...
		expect(hosts).toEqual(['*.api.example.com', 'a.example.com']);
		expect(app.calls.add.map((c) => c.host).sort()).toEqual(['*.api.example.com', 'a.example.com']);
		// ...and every worker was told to reload its own context.
		for (const w of workers) expect(w.posted).toEqual([{ type: 'tls-reload' }]);
	});
});
