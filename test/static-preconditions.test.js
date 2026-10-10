// The static lane's RFC 9110 preconditions, driven through the BUILT module
// the way the negotiate suite drives it: real files indexed by the shipped
// cacheDir with a pinned mtime, responses recorded off serveStatic.
//
// What the lane promises: mutable entries carry Last-Modified beside the ETag
// (immutable assets carry neither - the versioned filename is the validator);
// evaluation runs in the RFC's order, If-Match then If-Unmodified-Since in its
// absence to 412, then If-None-Match then If-Modified-Since in its absence to
// 304 - so a failed If-Match is never converted into a 304. If-Match compares
// by opaque equality against ANY validator the lane issued for the asset
// (which representation the client holds is a property of an earlier
// negotiation, not of today's Accept-Encoding); If-None-Match compares against
// the SELECTED representation, as the 304 always did. Both take the list form
// and `*`. An unparseable date is an ignored header, never a refusal, at the
// whole-second precision HTTP dates carry.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { buildFixtureOnce } from './helpers/fixture-build.js';

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}
const describeMaybe = bindingLoads() ? describe : describe.skip;

const IDENTITY = Array.from({ length: 120 }, (_, i) => `precondition line ${i}\n`).join('');
// A pinned whole-second mtime, so every date in the table is deterministic.
const MTIME = new Date('2026-01-02T03:04:05Z');
const MTIME_HTTP = MTIME.toUTCString();
const EARLIER = new Date(MTIME.getTime() - 1000).toUTCString();
const LATER = new Date(MTIME.getTime() + 60000).toUTCString();

function recorder() {
	const rec = { status: '', headers: /** @type {[string,string][]} */ ([]), body: null, bodyLength: -1, res: /** @type {any} */ (null) };
	const res = {
		cork(fn) { fn(); return res; },
		writeStatus(s) { rec.status = s; return res; },
		writeHeader(k, v) { rec.headers.push([k, v]); return res; },
		end(b) { rec.body = b === undefined ? null : Buffer.from(b); return res; },
		endWithoutBody(n) { rec.bodyLength = n; return res; }
	};
	rec.res = res;
	return rec;
}
const header = (rec, name) => (rec.headers.find((h) => h[0] === name) || [])[1];

describeMaybe('static preconditions follow the RFC evaluation order', () => {
	let tmpDir = '';
	/** @type {any} */ let entry;
	/** @type {any} */ let fracEntry;
	/** @type {any} */ let immutableEntry;
	/** @type {any} */ let overrideEntry;
	/** @type {any} */ let staticPreconditions;
	/** @type {(opts?: Record<string, string|boolean>) => any} */ let serve;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed').toBe(true);
		const mod = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');
		const { manifest } = await import('./fixture/build/manifest-bridge.js');
		staticPreconditions = mod.staticPreconditions;

		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-static-precond-'));
		const assetPath = path.join(tmpDir, 'doc.txt');
		fs.writeFileSync(assetPath, IDENTITY);
		fs.writeFileSync(assetPath + '.br', zlib.brotliCompressSync(Buffer.from(IDENTITY)));
		fs.utimesSync(assetPath, MTIME, MTIME);

		// A file whose mtime carries FRACTIONAL milliseconds - the normal case
		// in production, where the pinned whole-second asset above cannot see
		// a dropped floor.
		const fracPath = path.join(tmpDir, 'doc-frac.txt');
		fs.writeFileSync(fracPath, IDENTITY);
		fs.utimesSync(fracPath, MTIME, new Date('2026-01-02T03:04:05.789Z'));

		const immutableRel = path.join(manifest.appPath, 'immutable', 'pin.js');
		fs.mkdirSync(path.dirname(path.join(tmpDir, immutableRel)), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, immutableRel), IDENTITY);

		mod.cacheDir(tmpDir, '/precond', false);
		mod.cacheDir(tmpDir, '/precond-immutable', true);
		// The date validator is the lane's to manage: a configured header must
		// not displace the file's real time, or the preconditions would answer
		// from a fiction.
		mod.cacheDir(tmpDir, '/precond-override', false, { 'last-modified': 'Thu, 01 Jan 1970 00:00:00 GMT' });

		entry = staticCache.get('/precond/doc.txt');
		fracEntry = staticCache.get('/precond/doc-frac.txt');
		immutableEntry = staticCache.get(`/precond-immutable/${manifest.appPath}/immutable/pin.js`);
		overrideEntry = staticCache.get('/precond-override/doc.txt');

		serve = (opts = {}) => {
			const rec = recorder();
			mod.serveStatic(
				rec.res, opts.entry || entry,
				String(opts.acceptEncoding ?? ''),
				String(opts.ifNoneMatch ?? ''),
				opts.headOnly === true,
				String(opts.range ?? ''),
				String(opts.ifRange ?? ''),
				String(opts.ifMatch ?? ''),
				String(opts.ifUnmodifiedSince ?? ''),
				String(opts.ifModifiedSince ?? '')
			);
			return rec;
		};
	}, 400000);

	afterAll(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('a mutable entry serves Last-Modified beside the ETag; an immutable entry serves neither', () => {
		const rec = serve();
		expect(rec.status).toBe('200 OK');
		expect(header(rec, 'last-modified')).toBe(MTIME_HTTP);
		expect(header(rec, 'etag')).toBe(entry.etag);

		const imm = serve({ entry: immutableEntry });
		expect(imm.status).toBe('200 OK');
		expect(header(imm, 'last-modified')).toBeUndefined();
		expect(header(imm, 'etag')).toBeUndefined();
	});

	it('If-Modified-Since answers 304 at and after the file time, 200 before it, and carries the validators', () => {
		const at = serve({ ifModifiedSince: MTIME_HTTP });
		expect(at.status).toBe('304 Not Modified');
		expect(header(at, 'etag')).toBe(entry.etag);
		expect(header(at, 'last-modified')).toBe(MTIME_HTTP);
		expect(header(at, 'vary')).toBe('Accept-Encoding');

		expect(serve({ ifModifiedSince: LATER }).status).toBe('304 Not Modified');
		expect(serve({ ifModifiedSince: EARLIER }).status).toBe('200 OK');
	});

	it('an unparseable date is an ignored header, never a refusal', () => {
		expect(serve({ ifModifiedSince: 'not a date' }).status).toBe('200 OK');
		expect(serve({ ifUnmodifiedSince: 'yesterday-ish' }).status).toBe('200 OK');
	});

	it('If-None-Match takes the list form and star, and wins over If-Modified-Since', () => {
		expect(serve({ ifNoneMatch: `W/"other", ${entry.etag}` }).status).toBe('304 Not Modified');
		expect(serve({ ifNoneMatch: '*' }).status).toBe('304 Not Modified');
		expect(serve({ ifNoneMatch: 'W/"other"' }).status).toBe('200 OK');
		// An entity validator was sent, so the date validator is not consulted
		// (RFC 9110 13.1.3): a mismatching If-None-Match serves even though the
		// date alone would have answered 304.
		expect(serve({ ifNoneMatch: 'W/"other"', ifModifiedSince: LATER }).status).toBe('200 OK');
	});

	it('If-None-Match validates the SELECTED representation', () => {
		expect(entry.brEtag, 'the fixture must carry a brotli sibling').toBeTruthy();
		const br = serve({ acceptEncoding: 'br', ifNoneMatch: entry.brEtag });
		expect(br.status).toBe('304 Not Modified');
		expect(header(br, 'etag')).toBe(entry.brEtag);
		// The identity validator does not confirm brotli bytes.
		expect(serve({ acceptEncoding: 'br', ifNoneMatch: entry.etag }).status).toBe('200 OK');
	});

	it('If-Match answers 412 on a mismatch, and matches any validator the lane issued', () => {
		expect(serve({ ifMatch: 'W/"stranger"' }).status).toBe('412 Precondition Failed');
		expect(serve({ ifMatch: entry.etag }).status).toBe('200 OK');
		expect(serve({ ifMatch: '*' }).status).toBe('200 OK');
		expect(serve({ ifMatch: `W/"stranger", ${entry.etag}` }).status).toBe('200 OK');
		// The client may hold the brotli representation's validator from an
		// earlier negotiation; today's request negotiates identity. Which
		// representation this request selects does not change what the client
		// holds, so any validator the lane issued satisfies the guard.
		expect(serve({ ifMatch: entry.brEtag }).status).toBe('200 OK');
	});

	it('a failed If-Match is never converted into a 304', () => {
		const rec = serve({ ifMatch: 'W/"stranger"', ifNoneMatch: entry.etag, ifModifiedSince: LATER });
		expect(rec.status).toBe('412 Precondition Failed');
	});

	it('If-Unmodified-Since answers 412 for a newer file, and yields to If-Match when both are sent', () => {
		expect(serve({ ifUnmodifiedSince: EARLIER }).status).toBe('412 Precondition Failed');
		expect(serve({ ifUnmodifiedSince: MTIME_HTTP }).status).toBe('200 OK');
		expect(serve({ ifUnmodifiedSince: LATER }).status).toBe('200 OK');
		// If-Match present: the date is not consulted (RFC 9110 13.1.4) - a
		// matching entity validator serves even though the date alone would
		// have refused.
		expect(serve({ ifMatch: entry.etag, ifUnmodifiedSince: EARLIER }).status).toBe('200 OK');
	});

	it('preconditions are answered before Range (RFC 9110 13.2.1)', () => {
		// A resuming client that revalidates gets its 304 or its 412, never a
		// slice: converting a matched If-None-Match into a 206, or a failed
		// If-Match into a body, is the inversion the evaluation order forbids.
		const notModified = serve({ range: 'bytes=10-19', ifNoneMatch: entry.etag });
		expect(notModified.status).toBe('304 Not Modified');
		expect(notModified.body, 'a 304 must carry no slice').toBe(null);
		expect(serve({ range: 'bytes=10-19', ifMatch: 'W/"stranger"' }).status).toBe('412 Precondition Failed');
	});

	it('floors the date validator to the second the header spells', () => {
		// A fractional mtime kept at millisecond precision would make a client
		// echoing the server's own Last-Modified fail the comparison forever
		// (x.789 > x.000) - a permanent revalidation loop. The basis must be
		// the same whole second the header carries.
		expect(fracEntry, 'the fractional-mtime asset must be indexed').toBeTruthy();
		expect(fracEntry.lastModifiedMs % 1000, 'the date basis must be floored to the second').toBe(0);
		const served = header(serve({ entry: fracEntry }), 'last-modified');
		expect(served).toBeTruthy();
		expect(serve({ entry: fracEntry, ifModifiedSince: served }).status).toBe('304 Not Modified');
	});

	it('preconditions answer HEAD exactly as GET', () => {
		expect(serve({ headOnly: true, ifModifiedSince: MTIME_HTTP }).status).toBe('304 Not Modified');
		expect(serve({ headOnly: true, ifMatch: 'W/"stranger"' }).status).toBe('412 Precondition Failed');
	});

	it('an immutable entry ignores absent date validators but evaluates entity conditions', () => {
		expect(serve({ entry: immutableEntry, ifModifiedSince: LATER }).status).toBe('200 OK');
		expect(serve({ entry: immutableEntry, ifMatch: 'W/"stranger"' }).status).toBe('412 Precondition Failed');
		expect(serve({ entry: immutableEntry, ifMatch: '*' }).status).toBe('200 OK');
		expect(serve({ entry: immutableEntry, ifNoneMatch: '*' }).status).toBe('304 Not Modified');
	});

	it('a configured last-modified cannot displace the file time', () => {
		const rec = serve({ entry: overrideEntry });
		expect(header(rec, 'last-modified')).toBe(MTIME_HTTP);
	});

	it('the pure planner refuses nothing when the entry has no date', () => {
		// Belt and braces for the planner itself: a caller with no
		// lastModifiedMs (an immutable-shaped entry, were one ever passed)
		// ignores both date preconditions rather than comparing against
		// undefined.
		expect(staticPreconditions({ etag: 'W/"x"' }, 'W/"x"', '', EARLIER, '', '')).toBe(0);
		expect(staticPreconditions({ etag: 'W/"x"' }, 'W/"x"', '', '', '', LATER)).toBe(0);
	});
});
