import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, prerendered } from '../manifest-bridge.js';
import { mimeLookup } from '../utils.js';
import { monotonicNow } from '../runtime.js';
import { counters, staticCache, prerenderedDirStyle, decodeCache } from './state.js';
import { send400 } from './http-helpers.js';

// File extensions that browsers cannot render inline. Serving these with
// Content-Disposition: attachment prompts a download dialog instead of
// showing a blank or error page.
const DOWNLOAD_EXTENSIONS = new Set([
	'.zip', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
	'.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
	'.iso', '.img', '.bin'
]);

// This module sits one level below the runtime payload root (in handler/), but
// the client/ and prerendered/ asset directories the build emits live at that
// root next to the entry, so resolve up one level from this file's own location.
const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recursively walk a directory and call fn for each file.
 * @param {string} dir
 * @param {(relPath: string, absPath: string) => void} fn
 * @param {string} prefix
 */
function walk(dir, fn, prefix = '') {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir)) {
		const abs = path.join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (fs.statSync(abs).isDirectory()) {
			walk(abs, fn, rel);
		} else {
			fn(rel, abs);
		}
	}
}

/**
 * Load a directory into the static cache.
 * @param {string} dir
 * @param {string} urlPrefix
 * @param {boolean} immutable
 */
export function cacheDir(dir, urlPrefix, immutable) {
	walk(dir, (relPath, absPath) => {
		if (relPath.endsWith('.br') || relPath.endsWith('.gz')) return;

		const urlPath = `${urlPrefix}/${relPath}`;
		const contentType = mimeLookup(relPath);
		const buffer = fs.readFileSync(absPath);
		const stat = fs.statSync(absPath);

		/** @type {[string, string][]} */
		const headers = [
			['x-content-type-options', 'nosniff'],
			['vary', 'Accept-Encoding'],
			['accept-ranges', 'bytes']
		];
		let etag = '';
		if (immutable && relPath.startsWith(`${manifest.appPath}/immutable/`)) {
			headers.push(['cache-control', 'public, max-age=31536000, immutable']);
		} else {
			etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
			headers.push(['cache-control', 'no-cache'], ['etag', etag]);
		}

		const ext = path.extname(relPath).toLowerCase();
		if (DOWNLOAD_EXTENSIONS.has(ext)) {
			const basename = path.basename(relPath);
			// Strip characters that are not allowed in a quoted Content-Disposition filename.
			const safe = basename.replace(/["\\]/g, '');
			headers.push(['content-disposition', `attachment; filename="${safe}"`]);
		}

		/** @type {StaticEntry} */
		const entry = { buffer, contentType, etag, headers };

		if (PRECOMPRESS) {
			const brPath = absPath + '.br';
			const gzPath = absPath + '.gz';
			if (fs.existsSync(brPath)) {
				const brBuf = fs.readFileSync(brPath);
				if (brBuf.byteLength < buffer.byteLength) entry.brBuffer = brBuf;
			}
			if (fs.existsSync(gzPath)) {
				const gzBuf = fs.readFileSync(gzPath);
				if (gzBuf.byteLength < buffer.byteLength) entry.gzBuffer = gzBuf;
			}
		}

		staticCache.set(urlPath, entry);

		// Prerendered pages: register clean pathname aliases for the static fast
		// path and tryPrerendered().
		//
		// SvelteKit writes directory-style output (about/index.html) when
		// trailingSlash is 'always', and file-style (about.html) otherwise.
		// builder.prerendered.paths always lists "/about" (no trailing slash).
		//
		// For directory-style pages we register the trailing-slash form in
		// staticCache (served on the fast path) and track the bare path in
		// prerenderedDirStyle so tryPrerendered() can redirect /about -> /about/.
		// For file-style pages we register the bare path (no trailing slash).
		if (!immutable) {
			if (relPath === 'index.html') {
				if (urlPrefix) {
					// Base root with non-empty base: /base/ is canonical
					staticCache.set(urlPrefix + '/', entry);
					prerenderedDirStyle.add(urlPrefix);
				} else {
					// Site root: / is already canonical
					staticCache.set('/', entry);
				}
			} else if (relPath.endsWith('/index.html')) {
				// Directory-style: trailing slash is canonical
				const cleanPath = `${urlPrefix}/${relPath.slice(0, -'/index.html'.length)}`;
				staticCache.set(cleanPath + '/', entry);
				prerenderedDirStyle.add(cleanPath);
			} else if (relPath.endsWith('.html')) {
				// File-style: bare path is canonical
				staticCache.set(`${urlPrefix}/${relPath.slice(0, -'.html'.length)}`, entry);
			}
		}
	});
}

export const clientDir = path.join(__dirname, 'client');

export const prerenderedDir = path.join(__dirname, 'prerendered');

export const _t_static = monotonicNow();

/**
 * Parse an HTTP Range header value for a single byte range.
 * Returns { start, end } (both inclusive) or null when the range is absent,
 * malformed, multi-range, or would be unsatisfiable for the given file size.
 *
 * @param {string} header - Value of the Range header (e.g. "bytes=0-499")
 * @param {number} fileSize - Total number of bytes in the file
 * @returns {{ start: number, end: number } | null}
 */
// parseRange returns:
//   { start, end } - valid range, serve 206
//   null           - syntactically valid but unsatisfiable (start >= fileSize), send 416
//   false          - syntactically invalid, ignore the header and serve full 200
function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	// Multi-range (comma-separated)  - not supported; serve full content instead
	if (spec.includes(',')) return false;

	const dash = spec.indexOf('-');
	if (dash < 0) return false;

	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);

	// Reject tokens with non-digit characters (e.g. "1oops"). RFC 7233 requires
	// range values to be pure integers (1*DIGIT grammar production).
	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;

	let start, end;
	if (rawStart === '') {
		// Suffix range: bytes=-N (last N bytes)
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return false;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			// Open-ended: bytes=N- (from N to EOF)
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}

	if (start >= fileSize) return null; // Syntactically valid but unsatisfiable
	end = Math.min(end, fileSize - 1);
	return { start, end };
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {StaticEntry} entry
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 */
export function serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '') {
	if (entry.etag && ifNoneMatch === entry.etag) {
		res.cork(() => {
			res.writeStatus('304 Not Modified').end();
		});
		return;
	}

	// Range requests are only valid for files with an ETag (mutable assets).
	// Immutable versioned assets (_app/immutable/*) never need range requests.
	// When a Range header is present we always serve the uncompressed bytes so
	// the client gets the correct byte offsets (range + content-encoding don't mix).
	if (rangeHeader && entry.etag) {
		// If-Range: only honour Range if the client's cached ETag matches
		if (!ifRangeHeader || ifRangeHeader === entry.etag) {
			// Multi-range (bytes=0-499,600-700) is not supported. RFC 7233 allows
			// servers to ignore multiple ranges and respond with the full entity.
			if (!rangeHeader.includes(',')) {
				const range = parseRange(rangeHeader, entry.buffer.byteLength);
				if (range === null) {
					// Syntactically valid but start position is beyond EOF
					res.cork(() => {
						res.writeStatus('416 Range Not Satisfiable');
						res.writeHeader('content-range', `bytes */${entry.buffer.byteLength}`);
						res.end();
					});
					return;
				}
				if (range !== false) {
					// Valid range - serve partial content
					const slice = entry.buffer.subarray(range.start, range.end + 1);
					res.cork(() => {
						res.writeStatus('206 Partial Content');
						res.writeHeader('content-type', entry.contentType);
						res.writeHeader('content-range', `bytes ${range.start}-${range.end}/${entry.buffer.byteLength}`);
						res.writeHeader('date', counters.cachedDateHeader);
						for (let i = 0; i < entry.headers.length; i++) {
							res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
						}
						if (headOnly) res.endWithoutBody(slice.byteLength);
						else res.end(slice);
					});
					return;
				}
				// range === false: syntactically invalid - fall through to full 200
			}
			// Multi-range or invalid range  - fall through to full 200 response
		}
		// If-Range mismatch  - fall through to full 200 response
	}

	res.cork(() => {
		let body = entry.buffer;
		if (entry.brBuffer && acceptEncoding.includes('br')) {
			res.writeHeader('content-encoding', 'br');
			body = entry.brBuffer;
		} else if (entry.gzBuffer && acceptEncoding.includes('gzip')) {
			res.writeHeader('content-encoding', 'gzip');
			body = entry.gzBuffer;
		}

		res.writeStatus('200 OK');
		res.writeHeader('content-type', entry.contentType);
		res.writeHeader('date', counters.cachedDateHeader);
		// Pre-computed [key, value] tuples - no Object.entries() allocation per request
		for (let i = 0; i < entry.headers.length; i++) {
			res.writeHeader(entry.headers[i][0], entry.headers[i][1]);
		}
		if (headOnly) {
			res.endWithoutBody(body.byteLength);
		} else {
			res.end(body);
		}
	});
}

// Bounded cache for decoded URI pathnames. Avoids repeated decodeURIComponent
// calls for the same encoded path. Uses Map insertion order for LRU eviction.
export const DECODE_CACHE_MAX = 256;

/**
 * Decode a URI-encoded pathname, returning a cached result when available.
 * Returns null if the pathname is malformed (invalid percent-encoding).
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePath(pathname) {
	if (!pathname.includes('%')) return pathname;
	let result = decodeCache.get(pathname);
	if (result !== undefined) return result;
	try {
		result = decodeURIComponent(pathname);
	} catch {
		result = null;
	}
	if (decodeCache.size >= DECODE_CACHE_MAX) {
		decodeCache.delete(decodeCache.keys().next().value);
	}
	decodeCache.set(pathname, result);
	return result;
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} pathname
 * @param {string} search
 * @param {string} acceptEncoding
 * @param {string} ifNoneMatch
 * @param {boolean} headOnly
 * @param {string} [rangeHeader]
 * @param {string} [ifRangeHeader]
 * @returns {boolean}
 */
export function tryPrerendered(res, pathname, search, acceptEncoding, ifNoneMatch, headOnly = false, rangeHeader = '', ifRangeHeader = '') {
	const decoded = decodePath(pathname);
	if (decoded === null) {
		send400(res);
		return true;
	}

	if (prerendered.has(decoded)) {
		// Directory-style page: bare path is not canonical, redirect to trailing slash
		if (prerenderedDirStyle.has(decoded)) {
			const location = decoded + '/' + search;
			res.cork(() => {
				res.writeStatus('308 Permanent Redirect');
				res.writeHeader('location', location);
				res.end();
			});
			return true;
		}
		const entry = staticCache.get(decoded);
		if (entry) {
			serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader);
			return true;
		}
	}

	// Check the alternate trailing-slash form
	const alt = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded + '/';
	if (prerendered.has(alt)) {
		// Request has trailing slash, prerendered path doesn't - if the prerendered
		// path is directory-style, the trailing-slash form is canonical: serve it
		if (prerenderedDirStyle.has(alt) && decoded.endsWith('/')) {
			const entry = staticCache.get(decoded);
			if (entry) {
				serveStatic(res, entry, acceptEncoding, ifNoneMatch, headOnly, rangeHeader, ifRangeHeader);
				return true;
			}
		}
		// Otherwise redirect to the prerendered path (the canonical form)
		const location = alt + search;
		res.cork(() => {
			res.writeStatus('308 Permanent Redirect');
			res.writeHeader('location', location);
			res.end();
		});
		return true;
	}

	return false;
}
