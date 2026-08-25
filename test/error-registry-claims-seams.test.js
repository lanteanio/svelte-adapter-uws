// Registry entries driven from the conditions they claim, through the exported
// seams that produce them.
//
// Same contract as test/error-registry-claims.test.js: a case reaches the
// condition an entry's cause names through the real code path, then holds the
// entry to what it promised - especially that the signal it sends an operator
// to DISTINGUISHES the failure instead of reading all-clear under it. Every
// case here binds a claim that generate-error-reference cannot check, because
// that gate counts and renders entries without evaluating them.

import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY, adapterConsoleLine } from '../src/runtime/error-registry.js';
import { certExpiryAlert, createCertWatcher, readCertIdentity, reloadClusterTls } from '../src/runtime/utils/tls-reload.js';
import { createResourceGrowthAuditor, structuralResourceProbes } from '../src/runtime/leak-probes.js';
import { GAP_CONFIRM_MS, recordOriginStream, takeConfirmedGaps } from '../src/runtime/handler/state.js';
import { runMessageHook } from '../src/runtime/utils/hook-boundary.js';
import { formatOperationalDiagnostic, viteHandlerFailureDiagnostic } from '../src/runtime/utils/operational-diagnostic.js';
import { verifyNativeInstall } from '../scripts/check-native-install.js';
import { containMetricInstrument, mirrorRegistry, readMetricMirror, resetMetricMirror } from '../src/runtime/utils/metrics.js';
import { createPosture } from '../src/runtime/utils/pressure.js';
import { resolveWaitingRoom } from '../src/runtime/utils/upgrade-admission.js';
import { createStateHashDetector } from '../src/runtime/state-hash-detector.js';
import {
	assert as frameworkAssert,
	devAssert,
	fatal,
	readAssertionCounts,
	setFatalSink,
	_resetAssertionCountsForTest
} from '../src/runtime/utils/assertions.js';
import { emitOperationalEvent, setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { SIGNALS } from '../src/runtime/observability-manifest.js';

/** @param {string} id */
function entryFor(id) {
	const entry = ADAPTER_ERROR_REGISTRY.find((candidate) => candidate.id === id);
	expect(entry, `no registry entry for ${id}`).toBeTruthy();
	return entry;
}

/** Silence a console method for one case; restored by the file-level afterEach. */
function stub(method) {
	return vi.spyOn(console, method).mockImplementation(() => {});
}

const scratch = mkdtempSync(join(tmpdir(), 'err-claims-seams-'));

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// openssl gate, same discovery as test/error-registry-tls.test.js: real
// certificate material where a claim needs a parseable certificate; skipped
// cleanly on a machine without openssl.
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

function genCert(dir, name) {
	const key = join(dir, name + '.key');
	const crt = join(dir, name + '.crt');
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
	], { stdio: 'ignore' });
	return { key, crt };
}

describe('ADAPTER-ERR-TLS-PRIMARY-BOOT-READ', () => {
	// The entry's cause is the primary failing to read or parse the boot
	// certificate while arming the reload watch, and its consequence is that
	// expiry observability then starts blind: no baseline means a later
	// failure is reported without the urgency number.

	it('an unreadable or unparseable certificate throws out of the boot read', () => {
		// Both halves of the cause ("could not read or parse"): a path with no
		// file behind it, and a file that is not certificate material. Each
		// throws synchronously, which is what the primary boot catch is shaped
		// around. Would fail if readCertIdentity started swallowing bad
		// material and returning a placeholder identity.
		expect(() => readCertIdentity(join(scratch, 'no-such-cert.pem'))).toThrow();
		const broken = join(scratch, 'broken.pem');
		writeFileSync(broken, 'not a certificate at all\n');
		expect(() => readCertIdentity(broken)).toThrow();
	});

	it('without the baseline the later degraded-expiry line cannot carry its number', () => {
		// The consequence: the boot-read failure keeps notAfter null, and the
		// expiry sentinel refuses to speak without a finite expiry - a later
		// reload failure is degraded-only, reported "without the number that
		// says how urgent it is". Would fail if certExpiryAlert invented a
		// countdown from a null baseline.
		const alert = certExpiryAlert({ degraded: 'renewed certificate unreadable', notAfter: null, notAfterText: '' }, 1700000000000);
		expect(alert).toBeNull();
	});

	it('the console line carries the indexed prefix and the stable id', () => {
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_BOOT_READ);
		expect(line.startsWith('[tls] boot certificate unreadable on the primary')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-TLS-PRIMARY-BOOT-READ]');
	});

	describeOpenssl('with real certificate material', () => {
		let boot;
		beforeAll(() => {
			boot = genCert(scratch, 'boot-read');
		}, 120000);

		it('the next clean read records identity and expiry, which is the promised recovery', () => {
			// automaticRecovery: "The next reload that reads cleanly records
			// identity and expiry." The clean read must produce all three
			// pieces the failure path left blank. Hosts bind to the SAN the
			// certificate was generated with, not to anything the reader
			// derives from its own output.
			const identity = readCertIdentity(boot.crt);
			expect(typeof identity.fingerprint).toBe('string');
			expect(identity.fingerprint.length).toBeGreaterThan(0);
			expect(identity.hosts).toEqual(['localhost']);
			expect(Number.isFinite(identity.notAfter)).toBe(true);
			expect(identity.notAfter).toBeGreaterThan(Date.now());
			expect(identity.notAfterText.length).toBeGreaterThan(0);
		});
	});
});

describe('ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ', () => {
	// The entry's consequence has two load-bearing halves: the broadcast still
	// goes out after a failed primary read (workers gate on their OWN reads),
	// and the primary records no renewed identity or expiry.

	it('a failed read still broadcasts to every worker and keeps the prior state', () => {
		const state = Object.freeze({ hosts: ['api.example'], fingerprint: 'prev-fp', notAfter: 1234, notAfterText: 'prev' });
		const posts = [];
		const workers = [
			{ postMessage: (msg) => posts.push(['w1', msg]) },
			{ postMessage: (msg) => posts.push(['w2', msg]) }
		];
		let failure = null;
		const result = reloadClusterTls({
			workers,
			source: { certPath: join(scratch, 'never-written.pem') },
			state,
			onError: (err) => { failure = err; }
		});
		// The failure was reported, not swallowed.
		expect(failure).toBeTruthy();
		// "no renewed identity or expiry is recorded": the same state object
		// comes back, untouched. Identity equality, so a rebuilt look-alike
		// object would not pass for "unchanged".
		expect(result).toBe(state);
		// "The reload broadcast still goes out": both workers were posted the
		// reload message despite the primary-side read failure. Would fail if
		// the read throw short-circuited the broadcast.
		expect(posts).toEqual([
			['w1', { type: 'tls-reload' }],
			['w2', { type: 'tls-reload' }]
		]);
	});

	it('one worker mid-exit cannot rob its siblings of the broadcast', () => {
		// The per-worker post is best-effort; a throwing postMessage must not
		// stop the loop, or a single exiting worker would turn a fleet reload
		// into a partial one - the split failure the nextAction warns about
		// would then have a second, undocumented cause.
		const received = [];
		const workers = [
			{ postMessage: () => { throw new Error('worker exiting'); } },
			{ postMessage: (msg) => received.push(msg) }
		];
		reloadClusterTls({ workers, state: { hosts: [], fingerprint: null } });
		expect(received).toEqual([{ type: 'tls-reload' }]);
	});

	it('the console line carries the indexed prefix and the stable id', () => {
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_RELOAD_READ);
		expect(line.startsWith('[tls] renewed certificate unreadable on the primary')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-TLS-PRIMARY-RELOAD-READ]');
	});

	describeOpenssl('with real certificate material', () => {
		let renewal;
		beforeAll(() => {
			renewal = genCert(scratch, 'reload-read');
		}, 120000);

		it('the next change the primary reads cleanly records identity and expiry', () => {
			// automaticRecovery: a later clean read replaces the stale state.
			const state = { hosts: [], fingerprint: 'prev-fp', notAfter: null, notAfterText: null };
			const posts = [];
			const result = reloadClusterTls({
				workers: [{ postMessage: (msg) => posts.push(msg) }],
				source: { certPath: renewal.crt },
				state,
				onError: () => { throw new Error('a clean read must not report'); }
			});
			expect(result).not.toBe(state);
			expect(result.fingerprint).not.toBe('prev-fp');
			expect(result.hosts).toEqual(['localhost']);
			expect(Number.isFinite(result.notAfter)).toBe(true);
			expect(posts).toEqual([{ type: 'tls-reload' }]);
		});
	});
});

describe('ADAPTER-ERR-TLS-PRIMARY-WATCH', () => {
	// The entry's cause: the filesystem watch on the certificate directory
	// could not start - commonly a not-yet-mounted secret volume or a mistyped
	// path. No certificate file is needed to reach it: the watch arms on the
	// DIRECTORY, and a missing directory throws at start().

	it('a missing certificate directory throws synchronously out of start()', () => {
		const watcher = createCertWatcher({
			certPath: join(scratch, 'no-such-dir', 'cert.pem'),
			onChange: () => { throw new Error('a dead watch must never fire'); }
		});
		let caught = null;
		try {
			watcher.start();
		} catch (err) {
			caught = err;
		}
		// Synchronous, so the primary's try/catch around start() can catch it
		// at boot; an async throw would escape that catch and the entry's
		// "(server keeps running)" promise would be false.
		expect(caught).toBeTruthy();
		expect(caught.code).toBe('ENOENT');
		// Teardown after the failed start stays safe - the process keeps
		// running, exactly as the prefix says.
		expect(() => watcher.stop()).not.toThrow();
	});

	it('the entry does not promise a retry the code does not have', () => {
		// automaticRecovery must keep saying None: nothing in the runtime
		// re-arms a failed primary watch, so wording that claimed a retry
		// would send an operator into waiting for a recovery that cannot come.
		const entry = entryFor(ADAPTER_ERROR_IDS.TLS_PRIMARY_WATCH);
		expect(entry.automaticRecovery).toMatch(/^None\./);
		expect(entry.automaticRecovery).toMatch(/not retried/);
		expect(entry.consequence).toMatch(/process lifetime/);
	});

	it('the console line carries the indexed prefix and the stable id', () => {
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_WATCH);
		expect(line.startsWith('[tls] primary cert watch failed to start')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-TLS-PRIMARY-WATCH]');
	});
});

describe('ADAPTER-ERR-TLS-DEGRADED-EXPIRY', () => {
	// The entry's cause has two conditions that must BOTH hold before the line
	// exists: the degraded state, and a recorded expiry inside the alert
	// window. Each gate is driven from both sides so the alarm provably
	// distinguishes the failure instead of firing on healthy state.
	const DAY = 86400000;
	const now = 1700000000000;

	it('fires only while degraded AND inside the window', () => {
		// Healthy reload path, near expiry: silent (renewal will handle it).
		expect(certExpiryAlert({ degraded: null, notAfter: now + DAY, notAfterText: 'soon' }, now)).toBeNull();
		// Degraded, but expiry far away: silent (no urgency yet).
		expect(certExpiryAlert({ degraded: 'reason', notAfter: now + 15 * DAY, notAfterText: 'later' }, now)).toBeNull();
		// Degraded with no recorded expiry: silent - the alarm never invents
		// the number (the boot-read entry leans on exactly this refusal).
		expect(certExpiryAlert({ degraded: 'reason', notAfter: null, notAfterText: '' }, now)).toBeNull();
		// Both conditions: the line exists.
		expect(certExpiryAlert({ degraded: 'reason', notAfter: now + 13 * DAY, notAfterText: 'soon' }, now)).toBeTruthy();
	});

	it('the window boundary is exact', () => {
		// One millisecond outside the two-week window stays silent; the
		// boundary itself alerts. Would fail if the comparison drifted to a
		// strict/loose mismatch against what the entry documents as "inside".
		expect(certExpiryAlert({ degraded: 'r', notAfter: now + 14 * DAY + 1, notAfterText: 't' }, now)).toBeNull();
		expect(certExpiryAlert({ degraded: 'r', notAfter: now + 14 * DAY, notAfterText: 't' }, now)).toBeTruthy();
	});

	it('the composed line reads as the entry documents it', () => {
		const tail = certExpiryAlert({
			degraded: 'the certificate on disk did not validate',
			notAfter: now + 13 * DAY,
			notAfterText: 'Nov 20 12:00:00 2026 GMT'
		}, now);
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, tail);
		// The invariant head is the registry prefix; the tail opens with the
		// degraded reason and carries the certificate's own expiry rendering
		// plus the remaining time an operator acts on.
		expect(line.startsWith(
			'[svelte-adapter-uws] [tls] certificate hot-reload is DEGRADED (the certificate on disk did not validate)'
		)).toBe(true);
		expect(line).toContain('Nov 20 12:00:00 2026 GMT');
		expect(line).toContain('13d 0h left');
		// The tail must keep telling the operator that a renewal on disk will
		// not fix a broken reload by itself - the trap this entry exists for.
		expect(line).toContain('A failed reload keeps the PREVIOUS');
		expect(line).toContain('[ADAPTER-ERR-TLS-DEGRADED-EXPIRY]');
	});

	it('a certificate already past its expiry says so instead of a negative countdown', () => {
		const tail = certExpiryAlert({ degraded: 'r', notAfter: now - DAY, notAfterText: 'yesterday' }, now);
		expect(tail).toContain('ALREADY EXPIRED');
	});
});

describe('ADAPTER-ERR-RESOURCE-GROWTH', () => {
	// The entry claims a DIRECTION across consecutive samples: a structure
	// trending upward without shedding raises the signal, one that sheds never
	// does, and the metric - not the once-latched line - carries the ongoing
	// trend under a `resource` label.

	it('a structure that keeps growing raises the signal and labels the metric with its name', () => {
		const live = new Map();
		const reports = [];
		const incs = [];
		const growth = createResourceGrowthAuditor({
			probes: structuralResourceProbes({ decodeCache: live }),
			onGrowth: (report) => reports.push(report),
			metrics: { inc: (labels) => incs.push(labels) }
		});
		// Grow by one entry per sample. The kernel needs eight analyzed
		// samples before it may speak, so the first seven ticks stay silent -
		// that silence is part of the claim (never on a one- or two-sample
		// fluke).
		for (let i = 0; i < 7; i++) {
			live.set('conn' + i, i);
			growth.runOnce();
		}
		expect(reports).toEqual([]);
		expect(incs).toEqual([]);
		live.set('conn7', 7);
		growth.runOnce();
		// The report names the structure (the line's "names the structure"
		// claim rides this field), and the metric carries it as the
		// `resource` label, which is what the nextAction sends readers to.
		expect(reports.length).toBe(1);
		expect(reports[0].name).toBe('decodeCache');
		expect(incs).toEqual([{ resource: 'decodeCache' }]);

		// "the metric keeps carrying the ongoing signal": while the trend
		// continues, every further sample increments again - the metric shows
		// whether the trend continued after the once-per-worker line.
		live.set('conn8', 8);
		growth.runOnce();
		live.set('conn9', 9);
		growth.runOnce();
		expect(incs.length).toBe(3);

		// Observe-only: nothing was evicted from the structure it watched.
		expect(live.size).toBe(10);
	});

	it('a structure that sheds never raises it', () => {
		// The distinguishing control: without it the case above could pass on
		// a signal that fires for any populated Map.
		const live = new Map();
		for (let i = 0; i < 12; i++) live.set('conn' + i, i);
		const reports = [];
		const growth = createResourceGrowthAuditor({
			probes: structuralResourceProbes({ decodeCache: live }),
			onGrowth: (report) => reports.push(report)
		});
		for (let i = 0; i < 12; i++) {
			live.delete('conn' + i);
			growth.runOnce();
		}
		expect(reports).toEqual([]);
	});

	it('never throws into the sampler, even when the reporting side does', () => {
		// automaticRecovery is None because the watcher only observes; that
		// contract includes containing its own reporting failures - a
		// throwing metric or callback must not kill the timer path it rides.
		const live = new Map();
		const growth = createResourceGrowthAuditor({
			probes: structuralResourceProbes({ decodeCache: live }),
			onGrowth: () => { throw new Error('report failure'); },
			metrics: { inc: () => { throw new Error('metric failure'); } }
		});
		expect(() => {
			for (let i = 0; i < 10; i++) {
				live.set('conn' + i, i);
				growth.runOnce();
			}
		}).not.toThrow();
	});

	it('the instrument the nextAction names exists in the manifest with the label it promises', () => {
		// Bound to the manifest rather than to the entry's own text, so the
		// guidance breaks loudly if the signal is ever renamed or loses its
		// label.
		const signal = SIGNALS.find((candidate) => candidate.name === 'framework_resource_growth_suspected_total');
		expect(signal).toBeTruthy();
		expect(signal.labels).toContain('resource');
		// The signal is marked optional in the manifest - the entry's cause
		// says silence means "disabled just as often as nothing is growing",
		// which is only honest for an opt-in instrument.
		expect(signal.optional).toBe(true);
		const entry = entryFor(ADAPTER_ERROR_IDS.RESOURCE_GROWTH);
		expect(entry.nextAction).toContain('framework_resource_growth_suspected_total');
	});

	it('the console line opens with the indexed prefix and the structure detail', () => {
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.RESOURCE_GROWTH, "'decodeCache' size trending upward");
		expect(line.startsWith('[ws] resource-growth ')).toBe(true);
		expect(line).toContain("'decodeCache' size trending upward");
		expect(line).toContain('[ADAPTER-ERR-RESOURCE-GROWTH]');
	});
});

describe('ADAPTER-ERR-RELAY-GAP', () => {
	// The entry's cause is a gap detected in the relayed sequence this worker
	// received from its siblings. The detection contract that makes the claim
	// honest: only an interior hole that outlives the reorder grace confirms,
	// a hole that fills in time never reports, and a report drains once
	// rather than restating forever.
	const topic = 'game:lobby';

	it('an interior hole that outlives the grace is confirmed with its exact range', () => {
		let nowMs = 1000;
		const nowFn = () => nowMs;
		const streams = new Map();
		// Ordinal 1 baselines the stream, ordinal 3 opens the hole at 2.
		recordOriginStream(streams, topic, 3, 1, 0, 10, nowFn);
		recordOriginStream(streams, topic, 3, 3, 0, 10, nowFn);
		// Inside the grace nothing is confirmed - a reorder still in flight
		// must not read as loss. This is the gate that makes the emission
		// distinguish real loss from in-process reordering.
		expect(takeConfirmedGaps(streams, nowMs + GAP_CONFIRM_MS - 1, GAP_CONFIRM_MS)).toEqual([]);
		// Past the grace the hole is proven, named by topic, origin and the
		// missing range.
		expect(takeConfirmedGaps(streams, nowMs + GAP_CONFIRM_MS, GAP_CONFIRM_MS)).toEqual([
			{ topic, origin: 3, from: 2, to: 2, count: 1 }
		]);
		// The frames are never back-filled: the gap is reported once and
		// consumed - the stream re-baselines instead of restating the same
		// loss on every later drain. (What IS repaired happens downstream of
		// this drain: the signal walk tells opted-in subscribers to drop the
		// poisoned offset, and the topic's re-minted generation repudiates
		// the rest at their next resume.)
		expect(takeConfirmedGaps(streams, nowMs + 10 * GAP_CONFIRM_MS, GAP_CONFIRM_MS)).toEqual([]);
	});

	it('a hole that fills inside the grace never reports', () => {
		let nowMs = 1000;
		const nowFn = () => nowMs;
		const streams = new Map();
		recordOriginStream(streams, topic, 3, 1, 0, 10, nowFn);
		recordOriginStream(streams, topic, 3, 3, 0, 10, nowFn);
		nowMs = 1500;
		recordOriginStream(streams, topic, 3, 2, 0, 10, nowFn);
		expect(takeConfirmedGaps(streams, 60000, GAP_CONFIRM_MS)).toEqual([]);
	});

	it('a stream that predates the relay attach reports no gap for its unseen prefix', () => {
		// The consequence claims siblings RECEIVED what this worker lost. A
		// worker that joined mid-stream was never owed the prefix, so a first
		// sighting at ordinal 5 must baseline silently instead of reporting
		// four frames nobody withheld from it.
		let nowMs = 1000;
		const nowFn = () => nowMs;
		const streams = new Map();
		recordOriginStream(streams, topic, 7, 5, 0, 10, nowFn); // birth 0 predates attach at 10
		expect(takeConfirmedGaps(streams, 60000, GAP_CONFIRM_MS)).toEqual([]);
	});

	it('a stream born after the attach owes its whole prefix', () => {
		// The inverse of the case above, so the attach boundary provably cuts
		// both ways: a stream that STARTED while this worker was already
		// attached owed it ordinal 1, and a first sighting at 3 proves the
		// prefix was lost in transit.
		let nowMs = 1000;
		const nowFn = () => nowMs;
		const streams = new Map();
		recordOriginStream(streams, topic, 7, 3, 50, 10, nowFn); // birth 50 is after attach at 10
		expect(takeConfirmedGaps(streams, nowMs + GAP_CONFIRM_MS, GAP_CONFIRM_MS)).toEqual([
			{ topic, origin: 7, from: 1, to: 2, count: 2 }
		]);
	});
});

describe('ADAPTER-ERR-MESSAGE-HOOK', () => {
	// The entry promises per-connection containment: the failing client's
	// connection closes with 1011 and the reason `Message handler error`, the
	// cause stays server-side, and the error printed with the line is the
	// original throw.

	it('a throwing hook closes only that connection and prints the original throw', async () => {
		const errSpy = stub('error');
		const boom = new Error('hook exploded');
		const ws = { end: vi.fn() };
		// The boundary resolving (instead of rejecting) is the load-bearing
		// half of "other connections are unaffected": the hosts do not await
		// this promise, so a rejection here would become an unhandled
		// rejection and take the worker down, not one connection.
		await expect(runMessageHook(() => { throw boom; }, ws, {})).resolves.toBeUndefined();
		expect(ws.end).toHaveBeenCalledTimes(1);
		expect(ws.end).toHaveBeenCalledWith(1011, 'Message handler error');
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0][0]).toBe(adapterConsoleLine(ADAPTER_ERROR_IDS.MESSAGE_HOOK));
		expect(errSpy.mock.calls[0][0].startsWith('[ws] the message hook threw')).toBe(true);
		// nextAction: "The error printed with this line is the original
		// throw" - identity, not a copy or a wrapper.
		expect(errSpy.mock.calls[0][1]).toBe(boom);
	});

	it('a rejecting hook takes the same boundary', async () => {
		// The cause covers "threw or rejected"; the async form must land in
		// the same containment.
		const errSpy = stub('error');
		const boom = new Error('hook rejected');
		const ws = { end: vi.fn() };
		await expect(runMessageHook(async () => { throw boom; }, ws, {})).resolves.toBeUndefined();
		expect(ws.end).toHaveBeenCalledWith(1011, 'Message handler error');
		expect(errSpy.mock.calls[0][1]).toBe(boom);
	});

	it('a hook that completes leaves the connection open and the console silent', async () => {
		// The control that makes the cases above meaningful: the close and
		// the line are driven by the failure, not by every frame.
		const errSpy = stub('error');
		const ws = { end: vi.fn() };
		await runMessageHook(async () => {}, ws, {});
		expect(ws.end).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
	});
});

describe('ADAPTER-ERR-VITE-LOAD', () => {
	// The entry is emitted composed: the diagnostic must carry the registry's
	// own consequence/recovery/action text and render under the indexed
	// prefix, and the initial-load failure must stay distinguishable from the
	// hot-reload failure next door.

	it('the composed diagnostic carries the entry fields and renders under the indexed prefix', () => {
		const entry = entryFor(ADAPTER_ERROR_IDS.VITE_LOAD);
		const cause = new Error('SyntaxError in the handler module');
		const input = viteHandlerFailureDiagnostic({
			phase: 'load',
			source: 'src/lib/server/ws.js',
			host: 'localhost',
			port: 5173,
			error: cause
		});
		// The record's operator-facing fields come from the registry entry,
		// so the emitted guidance and the documented guidance cannot drift
		// apart. Would fail if the builder stopped reading the registry.
		expect(input.event).toBe(entry.event);
		expect(input.component).toBe(entry.component);
		expect(input.level).toBe(entry.severity);
		expect(input.effect).toBe(entry.consequence);
		expect(input.recovery).toBe(entry.automaticRecovery);
		expect(input.action).toBe(entry.nextAction);
		expect(input.problem).toContain('[ADAPTER-ERR-VITE-LOAD]');
		// willRetry mirrors the promised recovery: Vite retries on the next
		// module-graph change, so the record must not read as terminal.
		expect(input.willRetry).toBe(true);

		const line = formatOperationalDiagnostic(input);
		expect(line.startsWith(entry.messagePrefix)).toBe(true);
		expect(line).toContain('(src/lib/server/ws.js) failed.');
	});

	it('the initial-load failure and the hot-reload failure stay distinct events', () => {
		// The two entries split on whether a handler had loaded before; a
		// collapse of the two would route initial failures to prose about
		// existing connections that cannot exist.
		const load = viteHandlerFailureDiagnostic({ phase: 'load', error: new Error('x') });
		const reload = viteHandlerFailureDiagnostic({ phase: 'reload', error: new Error('x') });
		expect(load.event).not.toBe(reload.event);
		expect(reload.event).toBe(entryFor(ADAPTER_ERROR_IDS.VITE_RELOAD).event);
	});
});

describe('ADAPTER-ERR-NATIVE-LOAD', () => {
	// The entry is thrown, not logged: install and startup stop at it, and the
	// nextAction promises the exact supported archive plus the documented
	// Linux libc floor. The message is built from the adapter's own package
	// metadata, bound here against package.json directly.

	it('a failing native import throws the composed message with the pinned install spec', async () => {
		const boom = new Error('Cannot find module uws_linux_x64_127.node');
		let caught = null;
		try {
			await verifyNativeInstall(() => Promise.reject(boom), {});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeTruthy();
		expect(caught.message.startsWith('Could not load uWebSockets.js.')).toBe(true);
		expect(caught.message).toContain('[ADAPTER-ERR-NATIVE-LOAD]');
		// The pinned spec, read from package.json here so the hint can never
		// drift from the actual pin without this failing.
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		const pinned = pkg.optionalDependencies['uWebSockets.js'];
		expect(typeof pinned).toBe('string');
		expect(caught.message).toContain('npm install ' + pinned.replace(/^github:/, ''));
		// The documented libc floor and the original loader diagnostic.
		expect(caught.message).toMatch(/glibc >= 2\.\d+/);
		expect(caught.message).toContain('Native loader cause: ' + boom.message);
		expect(caught.cause).toBe(boom);
	});

	it('a loadable addon passes without a throw', async () => {
		await expect(verifyNativeInstall(() => Promise.resolve({}), {})).resolves.toEqual({ skipped: false });
	});

	it('only the explicit opt-out skips the check', async () => {
		// automaticRecovery is None: nothing recovers on its own, and the
		// bypass is a deliberate operator act, not a fallback - the importer
		// is not even attempted under it.
		const importer = vi.fn();
		await expect(
			verifyNativeInstall(importer, { SVELTE_ADAPTER_UWS_SKIP_NATIVE_CHECK: '1' })
		).resolves.toEqual({ skipped: true });
		expect(importer).not.toHaveBeenCalled();
	});
});

describe('ADAPTER-ERR-METRICS-MODULE-SHAPE', () => {
	afterEach(() => {
		resetMetricMirror();
	});

	it('a primitive registry value prints the type it got and disables metrics', () => {
		const errSpy = stub('error');
		resetMetricMirror();
		const disabled = mirrorRegistry(42);
		expect(disabled).toBeNull();
		expect(errSpy).toHaveBeenCalledTimes(1);
		// nextAction: "the `got` value on the line says which type" - the
		// operator can tell a number from a string without reading code.
		expect(errSpy.mock.calls[0][0]).toBe(
			adapterConsoleLine(ADAPTER_ERROR_IDS.METRICS_MODULE_SHAPE, 'number. Metrics are disabled.')
		);
		expect(mirrorRegistry('oops')).toBeNull();
		expect(errSpy.mock.calls[1][0]).toContain('string. Metrics are disabled.');
	});

	it('disabled metrics leave the series ABSENT from the mirror, not present at zero', () => {
		// The consequence's sharpest claim. Control first: a valid registry
		// records a registered family as a healthy zero via the registration
		// inventory, even before the first emit.
		resetMetricMirror();
		const wrapped = mirrorRegistry({ counter: () => ({ inc() {} }) });
		wrapped.counter('framework_resource_growth_suspected_total', 'help', ['resource']);
		const withRegistry = readMetricMirror();
		const inventory = withRegistry.find((sample) => Array.isArray(sample.families));
		expect(inventory).toBeTruthy();
		expect(inventory.families).toContain('framework_resource_growth_suspected_total');

		// The failure: a primitive export means no instrument is ever
		// created, so the mirror is empty - dashboards read no data rather
		// than zeros.
		const errSpy = stub('error');
		resetMetricMirror();
		expect(mirrorRegistry(7)).toBeNull();
		expect(readMetricMirror()).toEqual([]);
		expect(errSpy).toHaveBeenCalledTimes(1);
	});

	it('the two silent pass-through shapes the nextAction warns about are real', () => {
		const errSpy = stub('error');
		// A module exporting none of the three names reaches the mirror as
		// nullish and prints NOTHING - treated as no registry configured.
		expect(mirrorRegistry(null)).toBeNull();
		expect(mirrorRegistry(undefined)).toBeUndefined();
		// A factory function is accepted as-is and never called: the guard
		// admits it, no line prints, and no instrument creation ever invokes
		// it.
		const factory = vi.fn();
		const wrapped = mirrorRegistry(factory);
		expect(wrapped).not.toBeNull();
		wrapped.counter('framework_resource_growth_suspected_total', 'help', ['resource']);
		expect(factory).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
	});
});

describe('ADAPTER-ERR-METRICS-INSTRUMENT', () => {
	afterEach(() => {
		resetMetricMirror();
	});

	it('prints once with the original throw, and every later call is still attempted', () => {
		const errSpy = stub('error');
		const boom = new Error('label cardinality exceeded');
		let calls = 0;
		const contained = containMetricInstrument({
			inc() {
				calls++;
				if (calls === 1) throw boom;
			}
		});
		// The first failure is contained and reported; the caller completes
		// normally (automaticRecovery: per call, the triggering request
		// finishes).
		expect(() => contained.inc({ route: 'a' })).not.toThrow();
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0][0]).toBe(adapterConsoleLine(ADAPTER_ERROR_IDS.METRICS_INSTRUMENT));
		// nextAction: the printed error is the original throw.
		expect(errSpy.mock.calls[0][1]).toBe(boom);
		// The next call is attempted again - a transient self-heals - while
		// nothing further prints, which is exactly the suppression the
		// consequence warns makes a still-broken instrument look idle.
		contained.inc({ route: 'b' });
		expect(calls).toBe(2);
		expect(errSpy).toHaveBeenCalledTimes(1);
	});

	it('the mirror records before delegating, so a registry throw loses only the registry copy', () => {
		const errSpy = stub('error');
		resetMetricMirror();
		const wrapped = mirrorRegistry({
			counter: () => ({ inc() { throw new Error('registry refused the emit'); } })
		});
		const counter = containMetricInstrument(
			wrapped.counter('framework_resource_growth_suspected_total', 'help', ['resource'])
		);
		expect(() => counter.inc({ resource: 'decodeCache' })).not.toThrow();
		expect(errSpy).toHaveBeenCalledTimes(1);
		// The consequence's ordering claim: metricsSnapshot() still has the
		// value the configured registry lost. Read from the mirror the
		// snapshot path serves.
		const sample = readMetricMirror().find(
			(candidate) => candidate.name === 'framework_resource_growth_suspected_total' && candidate.labels
		);
		expect(sample).toBeTruthy();
		expect(sample.labels).toEqual({ resource: 'decodeCache' });
		expect(sample.value).toBe(1);
	});
});

describe('ADAPTER-ERR-POSTURE-OBSERVER', () => {
	// The entry's consequence: the posture CHANGED and the runtime keeps
	// acting on it - only the record of the transition is lost. Its
	// automaticRecovery: a throw does not unregister the handler, so the next
	// transition runs it again.

	it('a throwing transition handler is contained, and the posture still advances', () => {
		const errSpy = stub('error');
		const boom = new Error('observer exploded');
		let fired = 0;
		const posture = createPosture({
			admission: { maxConcurrent: 2 },
			getThresholds: () => ({}),
			onTransition: () => { fired++; throw boom; }
		});
		for (let i = 0; i < 5; i++) posture.tick({ active: true });
		// The machine settled on the new level BEFORE the handler ran, so the
		// throw cannot hold the posture back - the runtime is shedding or
		// recovering as configured while only the record is lost.
		expect(posture.level).toBe('elevated');
		expect(fired).toBe(1);
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0][0]).toBe(adapterConsoleLine(ADAPTER_ERROR_IDS.POSTURE_OBSERVER));
		expect(errSpy.mock.calls[0][0].startsWith('[ws] a posture transition handler threw')).toBe(true);
		expect(errSpy.mock.calls[0][1]).toBe(boom);

		// The handler stays registered: the relaxation transition runs it
		// again rather than finding it unregistered. Would fail if the catch
		// tore the observer down.
		for (let i = 0; i < 10; i++) posture.tick({ active: false });
		expect(posture.level).toBe('normal');
		expect(fired).toBe(2);
		expect(errSpy).toHaveBeenCalledTimes(2);
	});
});

describe('ADAPTER-ERR-POSTURE-TRANSITION', () => {
	// The entry's cause describes the machine's two decision rules: pressure
	// dwell decides normal to elevated, capacity-rejection rate decides
	// elevated to siege independently of the pressure signals, and relaxation
	// steps down one level at a time after a quiet run.

	function build(seen) {
		return createPosture({
			admission: { maxConcurrent: 2 },
			getThresholds: () => ({}),
			onTransition: (from, to) => seen.push(from + '->' + to)
		});
	}

	it('escalation to elevated is dwell-gated on sampled pressure', () => {
		const seen = [];
		const posture = build(seen);
		for (let i = 0; i < 4; i++) posture.tick({ active: true });
		// Four active samples are not enough - the dwell is what keeps a
		// momentary spike from flapping the posture.
		expect(posture.level).toBe('normal');
		posture.tick({ active: false }); // the run breaks
		for (let i = 0; i < 4; i++) posture.tick({ active: true });
		expect(posture.level).toBe('normal');
		posture.tick({ active: true }); // the fifth consecutive sample
		expect(posture.level).toBe('elevated');
		expect(seen).toEqual(['normal->elevated']);
	});

	it('siege is decided by the rejection rate with NO pressure signal at all', () => {
		// The cause's "independently of those signals", and the nextAction's
		// "entering siege ... can print pressure=NONE": every sample on the
		// way to siege is pressure-inactive; only capacity rejects drive it.
		const seen = [];
		const posture = build(seen);
		for (let i = 0; i < 5; i++) posture.tick({ active: true });
		expect(posture.level).toBe('elevated');
		// maxConcurrent 2 makes the siege rate 4 rejects per sample.
		for (let i = 0; i < 10; i++) {
			for (let r = 0; r < 4; r++) posture.recordCapacityReject();
			posture.tick({ active: false });
		}
		expect(posture.level).toBe('siege');
		expect(seen).toEqual(['normal->elevated', 'elevated->siege']);
	});

	it('relaxation steps siege down to elevated, never straight to normal', () => {
		const seen = [];
		const posture = build(seen);
		for (let i = 0; i < 5; i++) posture.tick({ active: true });
		for (let i = 0; i < 10; i++) {
			for (let r = 0; r < 4; r++) posture.recordCapacityReject();
			posture.tick({ active: false });
		}
		expect(posture.level).toBe('siege');
		// One quiet dwell steps down exactly one level.
		for (let i = 0; i < 10; i++) posture.tick({ active: false });
		expect(posture.level).toBe('elevated');
		// The next quiet dwell finishes the descent, and each de-escalation
		// fired the same transition handler that prints the line.
		for (let i = 0; i < 10; i++) posture.tick({ active: false });
		expect(posture.level).toBe('normal');
		expect(seen).toEqual([
			'normal->elevated',
			'elevated->siege',
			'siege->elevated',
			'elevated->normal'
		]);
	});

	it('the console line opens with the indexed posture prefix', () => {
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.POSTURE_TRANSITION, 'normal -> elevated rejected/s=0 pressure=MEMORY');
		expect(line.startsWith('[ws] protection posture normal -> elevated')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-POSTURE-TRANSITION]');
	});
});

describe('ADAPTER-ERR-WAITING-ROOM-FALLBACK', () => {
	// The entry promises that a broken renderer costs one visitor the
	// localized page, never the protection: the built-in English page is
	// served, the line prints once per worker, and a per-request failure
	// self-heals because the renderer is called again on the next request.
	const accessibleBody =
		'<!doctype html><html><head><title>Waiting room</title></head><body>' +
		'<main><h1>Waiting room</h1>' +
		'<p role="status" aria-live="polite">The service is at capacity.</p>' +
		'<p><a href="/">Back to start</a></p></main></body></html>';

	it('a throwing renderer serves the built-in English page and reports once', () => {
		const errSpy = stub('error');
		const boom = new Error('renderer exploded');
		const room = resolveWaitingRoom({ maxConcurrent: 8 }, () => { throw boom; });
		expect(room).not.toBeNull();
		const first = room.renderResponse(0);
		// The refusal is still answered, in the built-in page's locale - the
		// consequence's "localization ... lost for it", not an outage.
		expect(first.lang).toBe('en');
		expect(first.body).toContain('<html');
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0][0]).toBe(adapterConsoleLine(ADAPTER_ERROR_IDS.WAITING_ROOM_FALLBACK));
		expect(errSpy.mock.calls[0][1]).toBe(boom);
		// "The line prints once per worker": the second failing render serves
		// the same fallback silently.
		const second = room.renderResponse(0);
		expect(second.lang).toBe('en');
		expect(errSpy).toHaveBeenCalledTimes(1);
	});

	it('a result missing the accessible baseline falls back, and the error names the requirement', () => {
		const errSpy = stub('error');
		const room = resolveWaitingRoom({ maxConcurrent: 8 }, () => ({
			body: '<!doctype html><html><head></head><body>' +
				'<main><p role="status" aria-live="polite">The service is at capacity.</p>' +
				'<p><a href="/">Back to start</a></p></main></body></html>',
			lang: 'en',
			dir: 'ltr'
		}));
		const res = room.renderResponse(0);
		expect(res.lang).toBe('en');
		expect(errSpy).toHaveBeenCalledTimes(1);
		// nextAction: "when the baseline is what failed the error printed
		// with this line names the requirement".
		expect(errSpy.mock.calls[0][1].message).toContain('a non-empty <title>');
	});

	it('a failure that depends on the request self-heals on the next one', () => {
		const errSpy = stub('error');
		let call = 0;
		const room = resolveWaitingRoom({ maxConcurrent: 8 }, () => {
			call++;
			if (call === 1) throw new Error('only the first request fails');
			return { body: accessibleBody, lang: 'de', dir: 'ltr' };
		});
		const fallback = room.renderResponse(0);
		expect(fallback.lang).toBe('en');
		// The renderer is invoked again per request rather than being
		// disabled by its first failure; the visitor after the incident gets
		// the rendered page in the renderer's own locale.
		const healed = room.renderResponse(0);
		expect(healed.lang).toBe('de');
		expect(healed.body).toContain('lang="de"');
		expect(errSpy).toHaveBeenCalledTimes(1);
	});
});

describe('ADAPTER-ERR-DIVERGENCE-QUIET', () => {
	// The entry's cause requires the same disagreement to persist across
	// consecutive comparison epochs before anything logs, and its
	// automaticRecovery promises one report per distinct constellation with a
	// re-arm after agreement.

	function harness() {
		const clock = { nowMs: 500 };
		const detector = createStateHashDetector({ epochMs: 1000, monotonicNow: () => clock.nowMs });
		const live = [1, 2];
		return {
			detector,
			// One comparison round: both live workers report into the same
			// epoch, then the clock rolls to the next epoch.
			round(hashOne, hashTwo) {
				const first = detector.recordQuiet(1, hashOne, live);
				const second = detector.recordQuiet(2, hashTwo, live);
				clock.nowMs += 1000;
				return { first, second };
			}
		};
	}

	it('a single-epoch disagreement never logs; a persisted one logs exactly once', () => {
		const h = harness();
		const r1 = h.round(10, 20);
		// A bucket is judged only when every live worker has reported into
		// it, and one divergent epoch is a boundary artifact, not a report.
		expect(r1.first).toBeNull();
		expect(r1.second).toBeNull();
		// The same minority persisting a second epoch is a standing fact.
		const r2 = h.round(10, 20);
		expect(r2.second).toEqual({
			epoch: expect.any(Number),
			majorityHash: 10,
			hashesByThread: { 1: 10, 2: 20 },
			minorityThreadIds: [2]
		});
		// Deduplicated: the identical standing disagreement is not restated
		// on every later epoch.
		const r3 = h.round(10, 20);
		expect(r3.second).toBeNull();
	});

	it('a changed constellation reports again, and agreement re-arms the report', () => {
		const h = harness();
		h.round(10, 20);
		expect(h.round(10, 20).second).not.toBeNull();
		expect(h.round(10, 20).second).toBeNull();
		// Same persisted partition, different hash constellation: this is new
		// information (the nextAction's "constellation keeps changing" lead)
		// and reports immediately.
		const changed = h.round(10, 30);
		expect(changed.second).toEqual(expect.objectContaining({
			hashesByThread: { 1: 10, 2: 30 },
			minorityThreadIds: [2]
		}));
		// A judged agreement clears the streak and the dedup signature...
		expect(h.round(10, 10).second).toBeNull();
		// ...so a later re-divergence earns its persistence again and is then
		// reported rather than swallowed by the old signature.
		expect(h.round(10, 40).second).toBeNull();
		expect(h.round(10, 40).second).not.toBeNull();
	});
});

describe('ADAPTER-ERR-INVARIANT', () => {
	afterEach(() => {
		_resetAssertionCountsForTest();
	});

	it('a recorded violation appears in the counts map the platform surfaces', () => {
		// The soft tier under a test runner throws loudly; the counter
		// increments either way, which is what platform.assertions serves.
		expect(() => frameworkAssert(false, 'claims.soft-check', { ws: 1 })).toThrow(/claims\.soft-check/);
		expect(readAssertionCounts().get('claims.soft-check')).toBe(1);
	});

	it('a development-only assertion is logged and thrown WITHOUT being recorded', () => {
		// The consequence's warning that an empty map does not mean none
		// fired: devAssert leaves no trace in the counts.
		const errSpy = stub('error');
		expect(() => devAssert(false, 'a development-only shape check', { hint: 1 })).toThrow();
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(readAssertionCounts().size).toBe(0);
	});

	it('the line head is the indexed prefix and the severity varies by call site', () => {
		// emission "head": every violated-invariant line starts with the same
		// prefix up to `severity=`, and what follows is chosen by the tier -
		// the field the nextAction says to read first.
		const entry = entryFor(ADAPTER_ERROR_IDS.INVARIANT);
		const errSpy = stub('error');
		expect(() => fatal(false, 'claims.fatal-check', { ws: 7 })).toThrow(/claims\.fatal-check/);
		expect(() => devAssert(false, 'a development-only shape check')).toThrow();
		const fatalLine = errSpy.mock.calls[0][0];
		const devLine = errSpy.mock.calls[1][0];
		expect(fatalLine.startsWith(entry.messagePrefix + 'fatal')).toBe(true);
		expect(devLine.startsWith(entry.messagePrefix + 'error')).toBe(true);
		// The category and context attributes ride the line, as the
		// nextAction says to report.
		expect(fatalLine).toContain('"category":"claims.fatal-check"');
		expect(fatalLine).toContain('"ws":7');
		// The fatal tier recorded into the same single namespace.
		expect(readAssertionCounts().get('claims.fatal-check')).toBe(1);
	});

	it('the fatal tier schedules the dedicated exit code in production', async () => {
		// The consequence: "the worker is scheduled to exit with a dedicated
		// status code". Driven through the real production branch by flipping
		// the env fatal() re-reads per call, with the exit captured by the
		// injectable sink so the runner survives.
		const errSpy = stub('error');
		const exits = [];
		setFatalSink({ exit: (code) => exits.push(code) });
		const vitestBefore = process.env.VITEST;
		const nodeEnvBefore = process.env.NODE_ENV;
		delete process.env.VITEST;
		process.env.NODE_ENV = 'production';
		try {
			expect(() => fatal(false, 'claims.fatal-exit', {})).not.toThrow();
			// The termination is deferred past the current callback frame.
			expect(exits).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			if (vitestBefore === undefined) delete process.env.VITEST;
			else process.env.VITEST = vitestBefore;
			if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = nodeEnvBefore;
		}
		// 78 is the dedicated code: distinct from a config-error exit (1) and
		// a clean shutdown (0), so restart logs can tell the tiers apart.
		expect(exits).toEqual([78]);
		expect(errSpy).toHaveBeenCalledTimes(1);
	});
});

describe('ADAPTER-ERR-SINK-FAILED', () => {
	afterEach(() => {
		setOperationalEventSink(null);
	});

	function event(name, message) {
		return {
			source: 'svelte-adapter-uws',
			component: 'runtime.claims',
			event: name,
			severity: 'error',
			message
		};
	}

	it('the event lands on the console with the failure notice after it', () => {
		const errSpy = stub('error');
		const sink = vi.fn(() => { throw new Error('sink exploded'); });
		setOperationalEventSink(sink);
		emitOperationalEvent(event('runtime.claims.first', 'the event the sink was meant to carry'));
		expect(sink).toHaveBeenCalledTimes(1);
		expect(errSpy).toHaveBeenCalledTimes(2);
		// Consequence: "That event went to the console instead of the sink" -
		// and it goes out FIRST, so a broken observer can never make the
		// notice claim both records were lost.
		expect(errSpy.mock.calls[0][0]).toContain('runtime.claims.first');
		expect(errSpy.mock.calls[0][0]).toContain('the event the sink was meant to carry');
		const notice = errSpy.mock.calls[1][0];
		expect(notice).toContain('operational.sink.failed');
		expect(notice).toContain(entryFor(ADAPTER_ERROR_IDS.SINK_FAILED).problemPrefix);
	});

	it('the sink is attempted again for the next event rather than being disabled', () => {
		// automaticRecovery is per event. A sink that throws for one class of
		// events loses exactly that class from aggregation - which is only
		// true if the sink keeps being called.
		stub('error');
		let calls = 0;
		setOperationalEventSink((record) => {
			calls++;
			if (record.event === 'runtime.claims.poison') throw new Error('this class fails');
		});
		emitOperationalEvent(event('runtime.claims.poison', 'lost from aggregation'));
		emitOperationalEvent(event('runtime.claims.healthy', 'kept by the sink'));
		expect(calls).toBe(2);
	});

	it('an async sink rejection takes the same fallback', async () => {
		const errSpy = stub('error');
		setOperationalEventSink(() => Promise.reject(new Error('async sink exploded')));
		emitOperationalEvent(event('runtime.claims.async', 'carried by a rejecting sink'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const lines = errSpy.mock.calls.map((call) => call[0]);
		expect(lines.some((line) => line.includes('runtime.claims.async'))).toBe(true);
		expect(lines.some((line) => line.includes('operational.sink.failed'))).toBe(true);
	});
});

describe('ADAPTER-ERR-WORKER-EXIT-SIGKILL', () => {
	// The emission is followed by SIGKILL of the emitting process, so the
	// behavior cannot run in this harness; what is bindable here is the line
	// the primary composes and the prose properties that keep the entry
	// honest about the blast radius.

	it('the composed line names the worker under the indexed prefix', () => {
		const line = adapterConsoleLine(
			ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL,
			'7 did not exit within 5000ms; SIGKILLing the process'
		);
		expect(line.startsWith('[primary] worker 7 did not exit within 5000ms')).toBe(true);
		expect(line).toContain('[ADAPTER-ERR-WORKER-EXIT-SIGKILL]');
	});

	it('the console gate is real: a non-console entry refuses this composition', () => {
		// The control that keeps the case above falsifiable end to end - the
		// composer throws rather than rendering an entry whose emission is
		// not a console line.
		expect(() => adapterConsoleLine(ADAPTER_ERROR_IDS.RELAY_GAP)).toThrow(/not console-emitted/);
	});

	it('the entry owns the whole-process blast radius, not a per-worker one', () => {
		// The kill is process-wide and recovery is external only. Reworded to
		// the per-worker form ("the supervisor replaces it"), this entry
		// would promise a recovery the mechanism cannot deliver - the exact
		// defect shape its sibling entries were corrected for.
		const entry = entryFor(ADAPTER_ERROR_IDS.WORKER_EXIT_SIGKILL);
		expect(entry.cause).toContain('WHOLE PROCESS');
		expect(entry.consequence).toMatch(/Every worker dies/);
		expect(entry.automaticRecovery).toMatch(/^None inside the process/);
		expect(entry.automaticRecovery).not.toMatch(/supervisor replaces/);
		// The one exit request that prints no reason line of its own is the
		// shutdown budget expiring; the nextAction must keep naming it or the
		// operator hunts for a line that was never printed.
		expect(entry.nextAction).toContain('shutdown budget');
	});
});
