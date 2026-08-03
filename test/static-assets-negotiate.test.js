// Static content negotiation: a content-coding is a distinct representation.
//
// The defect this suite pins was silent file corruption. Every cache entry
// carried ONE validator - computed from the identity file's mtime and size -
// and the range path always cut its slice out of the identity buffer, no matter
// which coding the request had negotiated. A client that fetched with
// `Accept-Encoding: br` therefore stored brotli bytes, and its resume
// (`Range: bytes=N-` with `Accept-Encoding: br`, which is what `curl -C -
// --compressed`, `wget --continue` and every download manager send) came back
// 206 with IDENTITY bytes sliced at offsets the client had computed against the
// brotli stream, a `Content-Range` total quoting the identity length, and no
// `Content-Encoding` at all. Nothing reported an error; the joined file was
// simply not decompressible. Sending `If-Range` did not help - the one shared
// validator matched across codings, so it confirmed the wrong representation.
// The same shared validator also let a 304 answer a request whose negotiated
// coding differed from the coding the validator came from.
//
// The fix is that negotiation happens first and everything downstream speaks
// the selected representation's coordinates: its validator, its offsets, its
// total length, its bytes.
//
// This drives the REAL built runtime rather than a copy of the logic: the
// fixture build resolves the adapter through a symlink to this repo, so
// `cacheDir` indexes real files off disk with real precompressed siblings and
// `serveStatic` runs exactly as the request path calls it. Most cases record
// what `serveStatic` writes to a stand-in uWS HttpResponse; the last block puts
// the same entry behind a real listening uWS app and reads raw bytes off a
// socket, so the status line, the header block and the resumed body are checked
// as they actually go out.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { buildFixtureOnce } from './helpers/fixture-build.js';

// Gated on a loadable uWS binding as the other built-fixture suites are: the
// fixture build resolves it, so a runner without the binding cannot produce the
// module under test.
function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}

const canRun = bindingLoads();
const describeMaybe = canRun ? describe : describe.skip;

// Repetitive enough that brotli and gzip both come out smaller than the
// identity bytes - cacheDir keeps a precompressed sibling only when it is.
const IDENTITY = Array.from({ length: 200 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog\n`).join('');

/**
 * Record what serveStatic writes to a uWS response.
 * @returns {{ res: any, status: string, headers: [string, string][], body: Buffer | null, bodyLength: number }}
 */
function recorder() {
	const rec = {
		status: '',
		/** @type {[string, string][]} */
		headers: [],
		/** @type {Buffer | null} */
		body: null,
		bodyLength: -1,
		res: /** @type {any} */ (null)
	};
	const res = {
		cork(/** @type {() => void} */ fn) { fn(); return res; },
		writeStatus(/** @type {string} */ status) { rec.status = status; return res; },
		writeHeader(/** @type {string} */ key, /** @type {string} */ value) { rec.headers.push([key, value]); return res; },
		end(/** @type {Buffer | undefined} */ body) { rec.body = body === undefined ? null : Buffer.from(body); return res; },
		endWithoutBody(/** @type {number} */ length) { rec.bodyLength = length; return res; }
	};
	rec.res = res;
	return rec;
}

/** @param {{ headers: [string, string][] }} rec @param {string} name */
function header(rec, name) {
	const hit = rec.headers.find((h) => h[0] === name);
	return hit ? hit[1] : undefined;
}

describeMaybe('static assets: per-encoding representations', () => {
	let tmpDir = '';
	/** @type {any} */
	let entry;
	/** @type {any} */
	let immutableEntry;
	/** @type {any} */
	let configuredEntry;
	/** @type {any} */
	let customCacheEntry;
	/** @type {Buffer} */
	let brBytes;
	/** @type {Buffer} */
	let gzBytes;
	/** @type {(entry: any, opts?: { acceptEncoding?: string, ifNoneMatch?: string, headOnly?: boolean, range?: string, ifRange?: string }) => any} */
	let serve;

	beforeAll(async () => {
		// build/ is gitignored, so there is no prebuilt copy on a clean checkout.
		// The build embeds the current runtime source, which is what makes this a
		// test of the shipped module rather than of a transcription of it.
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);

		const { cacheDir, serveStatic } = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');
		const { manifest } = await import('./fixture/build/manifest-bridge.js');

		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-static-negotiate-'));
		brBytes = zlib.brotliCompressSync(Buffer.from(IDENTITY));
		gzBytes = zlib.gzipSync(Buffer.from(IDENTITY));

		const assetPath = path.join(tmpDir, 'asset.txt');
		fs.writeFileSync(assetPath, IDENTITY);
		fs.writeFileSync(assetPath + '.br', brBytes);
		fs.writeFileSync(assetPath + '.gz', gzBytes);

		const immutableRel = path.join(manifest.appPath, 'immutable', 'chunk.js');
		fs.mkdirSync(path.dirname(path.join(tmpDir, immutableRel)), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, immutableRel), IDENTITY);
		fs.writeFileSync(path.join(tmpDir, immutableRel + '.br'), brBytes);

		cacheDir(tmpDir, '/negotiate-probe', false);
		cacheDir(tmpDir, '/negotiate-immutable', true, null, [{
			pattern: `/${manifest.appPath}/immutable/`,
			cacheControl: 'no-store'
		}]);
		cacheDir(tmpDir, '/negotiate-configured', false, { 'x-frame-options': 'DENY' });
		cacheDir(tmpDir, '/negotiate-custom-cache', true, null, [{
			pattern: '/asset.txt',
			cacheControl: 'public, max-age=31536000, immutable'
		}]);

		entry = staticCache.get('/negotiate-probe/asset.txt');
		immutableEntry = staticCache.get(`/negotiate-immutable/${manifest.appPath}/immutable/chunk.js`);
		configuredEntry = staticCache.get('/negotiate-configured/asset.txt');
		customCacheEntry = staticCache.get('/negotiate-custom-cache/asset.txt');

		serve = (target, opts = {}) => {
			const rec = recorder();
			serveStatic(
				rec.res, target,
				opts.acceptEncoding ?? '',
				opts.ifNoneMatch ?? '',
				opts.headOnly ?? false,
				opts.range ?? '',
				opts.ifRange ?? ''
			);
			return rec;
		};
	}, 400000);

	afterAll(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('indexes both precompressed siblings', () => {
		expect(entry, 'the probe asset must be in the static cache').toBeTruthy();
		expect(entry.brBuffer, 'brotli sibling must be smaller than identity to be kept').toBeTruthy();
		expect(entry.gzBuffer, 'gzip sibling must be smaller than identity to be kept').toBeTruthy();
		expect(entry.etag).toMatch(/^W\/"[^"]+"$/);
	});

	it('gives each content-coding its own validator', () => {
		const identity = serve(entry);
		const br = serve(entry, { acceptEncoding: 'br' });
		const gz = serve(entry, { acceptEncoding: 'gzip' });

		expect(header(identity, 'content-encoding')).toBeUndefined();
		expect(header(br, 'content-encoding')).toBe('br');
		expect(header(gz, 'content-encoding')).toBe('gzip');

		const identityEtag = header(identity, 'etag');
		expect(identityEtag).toBe(entry.etag);
		expect(header(br, 'etag')).not.toBe(identityEtag);
		expect(header(gz, 'etag')).not.toBe(identityEtag);
		expect(header(br, 'etag')).not.toBe(header(gz, 'etag'));
		// The coding goes inside the closing quote so the tag stays a valid
		// weak entity-tag.
		expect(header(br, 'etag')).toBe(`${identityEtag.slice(0, -1)}-br"`);
		expect(header(gz, 'etag')).toBe(`${identityEtag.slice(0, -1)}-gzip"`);
	});

	it('serves the bytes the negotiated coding names', () => {
		expect(serve(entry).body.equals(Buffer.from(IDENTITY))).toBe(true);
		expect(serve(entry, { acceptEncoding: 'br' }).body.equals(brBytes)).toBe(true);
		expect(serve(entry, { acceptEncoding: 'gzip' }).body.equals(gzBytes)).toBe(true);
	});

	it('advertises byte ranges on every representation, because every one can serve them', () => {
		expect(header(serve(entry), 'accept-ranges')).toBe('bytes');
		expect(header(serve(entry, { acceptEncoding: 'br' }), 'accept-ranges')).toBe('bytes');
		expect(header(serve(entry, { acceptEncoding: 'gzip' }), 'accept-ranges')).toBe('bytes');
	});

	it('resumes a compressed download in the compressed representation', () => {
		// The corruption path end to end, WITHOUT If-Range - which is what a
		// resuming download manager sends. The client is holding a prefix of the
		// brotli bytes, so the continuation has to be the rest of THOSE bytes.
		const first = serve(entry, { acceptEncoding: 'br' });
		expect(first.body.equals(brBytes), 'the client is holding brotli bytes').toBe(true);

		const held = brBytes.byteLength >> 1;
		const resumed = serve(entry, { acceptEncoding: 'br', range: `bytes=${held}-` });

		expect(resumed.status).toBe('206 Partial Content');
		expect(header(resumed, 'content-encoding')).toBe('br');
		expect(header(resumed, 'etag')).toBe(header(first, 'etag'));
		// Offsets and total length are the brotli representation's, not the
		// identity file's - quoting the identity length here is what told the
		// client to keep asking for bytes that do not belong to its download.
		expect(header(resumed, 'content-range')).toBe(`bytes ${held}-${brBytes.byteLength - 1}/${brBytes.byteLength}`);
		expect(resumed.body.equals(brBytes.subarray(held))).toBe(true);

		// The whole point: joining what the client had to what it just got yields
		// the original file. Before the fix this threw "Decompression failed".
		const joined = Buffer.concat([brBytes.subarray(0, held), resumed.body]);
		expect(zlib.brotliDecompressSync(joined).toString()).toBe(IDENTITY);
	});

	it('resumes a gzip download in the gzip representation', () => {
		const held = gzBytes.byteLength >> 1;
		const resumed = serve(entry, { acceptEncoding: 'gzip', range: `bytes=${held}-` });
		expect(resumed.status).toBe('206 Partial Content');
		expect(header(resumed, 'content-encoding')).toBe('gzip');
		expect(header(resumed, 'content-range')).toBe(`bytes ${held}-${gzBytes.byteLength - 1}/${gzBytes.byteLength}`);
		const joined = Buffer.concat([gzBytes.subarray(0, held), resumed.body]);
		expect(zlib.gunzipSync(joined).toString()).toBe(IDENTITY);
	});

	it('still resumes normally against the identity validator', () => {
		const resumed = serve(entry, { range: 'bytes=10-19', ifRange: entry.etag });
		expect(resumed.status).toBe('206 Partial Content');
		expect(header(resumed, 'content-range')).toBe(`bytes 10-19/${IDENTITY.length}`);
		expect(header(resumed, 'content-encoding')).toBeUndefined();
		expect(header(resumed, 'etag')).toBe(entry.etag);
		expect(resumed.body.toString()).toBe(IDENTITY.slice(10, 20));
	});

	it('validates If-Range against the representation the request selected', () => {
		// A validator from a different representation cannot describe these
		// offsets, so the range is refused and the client gets the whole selected
		// representation instead of a slice it would have joined onto the wrong
		// prefix.
		const brEtag = header(serve(entry, { acceptEncoding: 'br' }), 'etag');

		const identityTagAgainstBrotli = serve(entry, { acceptEncoding: 'br', range: 'bytes=10-19', ifRange: entry.etag });
		expect(identityTagAgainstBrotli.status).toBe('200 OK');
		expect(header(identityTagAgainstBrotli, 'content-encoding')).toBe('br');
		expect(identityTagAgainstBrotli.body.equals(brBytes)).toBe(true);

		const brotliTagAgainstIdentity = serve(entry, { range: 'bytes=10-19', ifRange: brEtag });
		expect(brotliTagAgainstIdentity.status).toBe('200 OK');
		expect(header(brotliTagAgainstIdentity, 'content-encoding')).toBeUndefined();
		expect(brotliTagAgainstIdentity.body.equals(Buffer.from(IDENTITY))).toBe(true);

		// And the matching case still resumes.
		const matched = serve(entry, { acceptEncoding: 'br', range: 'bytes=10-19', ifRange: brEtag });
		expect(matched.status).toBe('206 Partial Content');
		expect(matched.body.equals(brBytes.subarray(10, 20))).toBe(true);
	});

	it('reports an unsatisfiable range against the selected representation length', () => {
		// brotli is far smaller than identity here, so an offset past the end of
		// the brotli bytes is still inside the identity file: quoting the identity
		// length would tell the client its download is much longer than the
		// representation it is fetching.
		const past = brBytes.byteLength + 1;
		expect(past).toBeLessThan(IDENTITY.length);

		const br = serve(entry, { acceptEncoding: 'br', range: `bytes=${past}-` });
		expect(br.status).toBe('416 Range Not Satisfiable');
		expect(header(br, 'content-range')).toBe(`bytes */${brBytes.byteLength}`);

		const identity = serve(entry, { range: `bytes=${IDENTITY.length}-` });
		expect(identity.status).toBe('416 Range Not Satisfiable');
		expect(header(identity, 'content-range')).toBe(`bytes */${IDENTITY.length}`);
	});

	it('keeps compression when a Range header cannot be honoured', () => {
		// Malformed, multi-range and stale-If-Range requests fall through to a
		// normal response - which must still be the negotiated one, or a junk
		// Range header would cost every client its compression.
		for (const opts of [
			{ acceptEncoding: 'br', range: 'bytes=oops' },
			{ acceptEncoding: 'br', range: 'bytes=0-9,20-29' },
			{ acceptEncoding: 'br', range: 'bytes=0-9', ifRange: 'W/"stale"' }
		]) {
			const rec = serve(entry, opts);
			expect(rec.status, JSON.stringify(opts)).toBe('200 OK');
			expect(header(rec, 'content-encoding'), JSON.stringify(opts)).toBe('br');
			expect(rec.body.equals(brBytes)).toBe(true);
		}
	});

	it('never answers 304 for a coding other than the one the validator came from', () => {
		// A client holding the identity copy that now accepts brotli must get the
		// brotli bytes, not a 304 that would leave it using identity bytes under a
		// brotli representation's identity.
		const crossed = serve(entry, { acceptEncoding: 'br', ifNoneMatch: entry.etag });
		expect(crossed.status).toBe('200 OK');
		expect(header(crossed, 'content-encoding')).toBe('br');
		expect(crossed.body.equals(brBytes)).toBe(true);

		// And the mirror: a client holding the brotli copy that stops accepting it
		// must be given real identity bytes.
		const brEtag = header(serve(entry, { acceptEncoding: 'br' }), 'etag');
		const back = serve(entry, { ifNoneMatch: brEtag });
		expect(back.status).toBe('200 OK');
		expect(header(back, 'content-encoding')).toBeUndefined();
		expect(back.body.equals(Buffer.from(IDENTITY))).toBe(true);
	});

	it('answers 304 when the validator does name the negotiated representation', () => {
		const identity = serve(entry, { ifNoneMatch: entry.etag });
		expect(identity.status).toBe('304 Not Modified');
		expect(identity.body).toBeNull();

		const brEtag = header(serve(entry, { acceptEncoding: 'br' }), 'etag');
		const br = serve(entry, { acceptEncoding: 'br', ifNoneMatch: brEtag });
		expect(br.status).toBe('304 Not Modified');
		// A 304 updates a stored response: it has to name which stored
		// representation was validated, the dimension that entry is keyed on, and
		// the freshness policy the entry is stored under.
		expect(header(br, 'etag')).toBe(brEtag);
		expect(header(br, 'vary')).toBe('Accept-Encoding');
		expect(header(br, 'cache-control')).toBe('no-cache');
		expect(header(identity, 'cache-control')).toBe('no-cache');
	});

	it('varies on Accept-Encoding on every representation', () => {
		expect(header(serve(entry), 'vary')).toBe('Accept-Encoding');
		expect(header(serve(entry, { acceptEncoding: 'br' }), 'vary')).toBe('Accept-Encoding');
		expect(header(serve(entry, { acceptEncoding: 'gzip' }), 'vary')).toBe('Accept-Encoding');
		expect(header(serve(entry, { ifNoneMatch: entry.etag }), 'vary')).toBe('Accept-Encoding');
	});

	it('reports the coded length on a HEAD request', () => {
		expect(serve(entry, { headOnly: true }).bodyLength).toBe(IDENTITY.length);
		expect(serve(entry, { acceptEncoding: 'br', headOnly: true }).bodyLength).toBe(brBytes.byteLength);
		// A HEAD with a range reports the slice length of the selected
		// representation, and no body is written.
		const head = serve(entry, { acceptEncoding: 'br', headOnly: true, range: 'bytes=0-9' });
		expect(head.status).toBe('206 Partial Content');
		expect(head.bodyLength).toBe(10);
		expect(head.body).toBeNull();
	});

	it('carries app-configured headers on every coding', () => {
		// A coding's headers are derived from the MERGED identity tuples, so a
		// security header the app configured cannot go missing on the response
		// most clients actually get.
		expect(configuredEntry, 'the configured probe asset must be in the static cache').toBeTruthy();
		expect(header(serve(configuredEntry), 'x-frame-options')).toBe('DENY');
		expect(header(serve(configuredEntry, { acceptEncoding: 'br' }), 'x-frame-options')).toBe('DENY');
		expect(header(serve(configuredEntry, { acceptEncoding: 'gzip' }), 'x-frame-options')).toBe('DENY');
	});

	it('carries a matching custom cache policy across representations and 304', () => {
		expect(customCacheEntry, 'the custom-cache probe asset must be indexed').toBeTruthy();
		const identity = serve(customCacheEntry);
		const br = serve(customCacheEntry, { acceptEncoding: 'br' });
		const validated = serve(customCacheEntry, { ifNoneMatch: customCacheEntry.etag });

		expect(header(identity, 'cache-control')).toBe('public, max-age=31536000, immutable');
		expect(header(br, 'cache-control')).toBe('public, max-age=31536000, immutable');
		expect(header(validated, 'cache-control')).toBe('public, max-age=31536000, immutable');
		expect(validated.status).toBe('304 Not Modified');
		expect(header(identity, 'etag')).toBe(customCacheEntry.etag);
		expect(serve(customCacheEntry, { range: 'bytes=0-9' }).status).toBe('206 Partial Content');
	});

	it('leaves immutable assets without a validator on any coding', () => {
		expect(immutableEntry, 'the immutable probe asset must be in the static cache').toBeTruthy();
		expect(immutableEntry.etag).toBe('');

		const identity = serve(immutableEntry);
		const br = serve(immutableEntry, { acceptEncoding: 'br' });
		expect(header(identity, 'etag')).toBeUndefined();
		expect(header(br, 'etag')).toBeUndefined();
		expect(header(br, 'content-encoding')).toBe('br');
		expect(header(br, 'cache-control')).toBe('public, max-age=31536000, immutable');

		// No validator means no conditional request and no range: without one a
		// client cannot tell a resume of the same bytes apart from a file that
		// changed underneath it, so a versioned asset is fetched whole or not at
		// all - on the coded representation too.
		expect(serve(immutableEntry, { ifNoneMatch: 'W/"anything"' }).status).toBe('200 OK');
		expect(serve(immutableEntry, { range: 'bytes=0-9' }).status).toBe('200 OK');
		expect(serve(immutableEntry, { acceptEncoding: 'br', range: 'bytes=0-9' }).status).toBe('200 OK');
	});
});

/**
 * One raw HTTP/1.1 exchange. `node:http` (unlike fetch) sends exactly the
 * headers given and never decodes a content-coding, so the bytes returned here
 * are the bytes on the wire - which is the only way to check a partial brotli
 * body and the status line that carries it.
 *
 * @param {number} port
 * @param {string} pathname
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, statusMessage: string, headers: Record<string, any>, body: Buffer }>}
 */
function rawGet(port, pathname, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: '127.0.0.1', port, path: pathname, method: 'GET', headers, agent: false },
			(res) => {
				/** @type {Buffer[]} */
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => resolve({
					status: /** @type {number} */ (res.statusCode),
					statusMessage: res.statusMessage,
					headers: res.headers,
					body: Buffer.concat(chunks)
				}));
			}
		);
		req.on('error', reject);
		req.end();
	});
}

/**
 * Send a hand-written request over a bare socket and return everything the
 * server sent back, unparsed. An HTTP client library normalises the response
 * head, so this is the only view in which the status line itself - the one
 * thing a call recorder cannot see, and the thing a stray write before
 * `writeStatus` destroys - is an assertable string.
 *
 * @param {number} port
 * @param {string[]} requestLines - request line and headers, no terminator
 * @returns {Promise<string>} the head, up to the blank line, as latin1
 */
function rawSocketHead(port, requestLines) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(requestLines.join('\r\n') + '\r\n\r\n');
		});
		socket.setTimeout(10000, () => {
			socket.destroy();
			reject(new Error('no response within 10s'));
		});
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => {
			const text = Buffer.concat(chunks).toString('latin1');
			const blank = text.indexOf('\r\n\r\n');
			resolve(blank < 0 ? text : text.slice(0, blank));
		});
	});
}

describeMaybe('static assets: resume over a real connection', () => {
	let tmpDir = '';
	let port = 0;
	/** @type {any} */
	let listenSocket = null;
	/** @type {any} */
	let uWS;
	/** @type {Buffer} */
	let brBytes;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed for this integration test').toBe(true);

		uWS = (await import('uWebSockets.js')).default;
		const { cacheDir, serveStatic } = await import('./fixture/build/handler/static-assets.js');
		const { staticCache } = await import('./fixture/build/handler/state.js');

		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-static-wire-'));
		brBytes = zlib.brotliCompressSync(Buffer.from(IDENTITY));
		const assetPath = path.join(tmpDir, 'asset.txt');
		fs.writeFileSync(assetPath, IDENTITY);
		fs.writeFileSync(assetPath + '.br', brBytes);
		cacheDir(tmpDir, '/wire-probe', false);
		const entry = staticCache.get('/wire-probe/asset.txt');
		expect(entry, 'the wire probe asset must be in the static cache').toBeTruthy();

		// Invoked exactly as request.js invokes it, so the header reads and the
		// order of writes are the production ones - a status line written after
		// the first header, for instance, is a real wire defect that no recorder
		// can see.
		const app = uWS.App().get('/wire-probe/asset.txt', (res, req) => {
			res.onAborted(() => {});
			serveStatic(
				res, entry,
				req.getHeader('accept-encoding'),
				req.getHeader('if-none-match'),
				false,
				req.getHeader('range'),
				req.getHeader('if-range')
			);
		});

		await new Promise((resolve, reject) => {
			app.listen('127.0.0.1', 0, (socket) => {
				if (!socket) return reject(new Error('uWS failed to listen'));
				listenSocket = socket;
				port = uWS.us_socket_local_port(socket);
				resolve(undefined);
			});
		});
	}, 400000);

	afterAll(() => {
		if (listenSocket) {
			try { uWS.us_listen_socket_close(listenSocket); } catch { /* already closed */ }
		}
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('hands a resumed compressed download bytes that join into the original file', async () => {
		const first = await rawGet(port, '/wire-probe/asset.txt', { 'accept-encoding': 'br' });
		expect(first.status).toBe(200);
		expect(first.statusMessage).toBe('OK');
		expect(first.headers['content-encoding']).toBe('br');
		expect(first.body.equals(brBytes)).toBe(true);

		// The client keeps a prefix and asks for the rest the way a download
		// manager does: a Range, the same Accept-Encoding, no If-Range.
		const held = first.body.subarray(0, first.body.byteLength >> 1);
		const resumed = await rawGet(port, '/wire-probe/asset.txt', {
			'accept-encoding': 'br',
			range: `bytes=${held.byteLength}-`
		});
		expect(resumed.status).toBe(206);
		expect(resumed.statusMessage).toBe('Partial Content');
		expect(resumed.headers['content-encoding']).toBe('br');
		expect(resumed.headers['content-range']).toBe(`bytes ${held.byteLength}-${brBytes.byteLength - 1}/${brBytes.byteLength}`);
		expect(resumed.headers['etag']).toBe(first.headers['etag']);

		const joined = Buffer.concat([held, resumed.body]);
		expect(joined.equals(brBytes)).toBe(true);
		expect(zlib.brotliDecompressSync(joined).toString()).toBe(IDENTITY);
	});

	it('puts the status line and the full header block on the wire', async () => {
		const res = await rawGet(port, '/wire-probe/asset.txt', { 'accept-encoding': 'br' });
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('text/plain');
		expect(res.headers['vary']).toBe('Accept-Encoding');
		expect(res.headers['accept-ranges']).toBe('bytes');
		expect(res.headers['cache-control']).toBe('no-cache');
		expect(res.headers['x-content-type-options']).toBe('nosniff');
		expect(res.headers['date']).toBeTruthy();
		expect(res.headers['etag']).toMatch(/-br"$/);
		expect(Number(res.headers['content-length'])).toBe(brBytes.byteLength);
	});

	it('answers a conditional request for the coded representation with 304', async () => {
		const first = await rawGet(port, '/wire-probe/asset.txt', { 'accept-encoding': 'br' });
		const res = await rawGet(port, '/wire-probe/asset.txt', {
			'accept-encoding': 'br',
			'if-none-match': /** @type {string} */ (first.headers['etag'])
		});
		expect(res.status).toBe(304);
		expect(res.statusMessage).toBe('Not Modified');
		expect(res.headers['etag']).toBe(first.headers['etag']);
		expect(res.headers['vary']).toBe('Accept-Encoding');
		expect(res.headers['cache-control']).toBe('no-cache');
		expect(res.body.byteLength).toBe(0);
	});

	it('opens each response with its own status line', async () => {
		// uWS writes the status line lazily and fills in a default one as soon as
		// any header is written, so a `writeHeader` that gets ahead of
		// `writeStatus` silently pins the response to 200 and re-emits the
		// intended status as a garbage header line. Only the raw head shows it.
		const ok = await rawSocketHead(port, [
			'GET /wire-probe/asset.txt HTTP/1.1',
			'Host: 127.0.0.1',
			'Accept-Encoding: br',
			'Connection: close'
		]);
		expect(ok.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
		expect(ok).not.toMatch(/\r\n2\d\d /);

		const partial = await rawSocketHead(port, [
			'GET /wire-probe/asset.txt HTTP/1.1',
			'Host: 127.0.0.1',
			'Accept-Encoding: br',
			`Range: bytes=${brBytes.byteLength >> 1}-`,
			'Connection: close'
		]);
		expect(partial.split('\r\n')[0]).toBe('HTTP/1.1 206 Partial Content');

		const unsatisfiable = await rawSocketHead(port, [
			'GET /wire-probe/asset.txt HTTP/1.1',
			'Host: 127.0.0.1',
			'Accept-Encoding: br',
			`Range: bytes=${brBytes.byteLength + 1}-`,
			'Connection: close'
		]);
		expect(unsatisfiable.split('\r\n')[0]).toBe('HTTP/1.1 416 Range Not Satisfiable');
	});

	it('refuses an out-of-range resume against the coded length', async () => {
		const res = await rawGet(port, '/wire-probe/asset.txt', {
			'accept-encoding': 'br',
			range: `bytes=${brBytes.byteLength + 1}-`
		});
		expect(res.status).toBe(416);
		expect(res.headers['content-range']).toBe(`bytes */${brBytes.byteLength}`);
	});
});
