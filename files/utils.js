// -- MIME types ------------------------------------------------------------------

export const mimes = {
	"3g2": "video/3gpp2", "3gp": "video/3gpp", "3gpp": "video/3gpp", "3mf": "model/3mf",
	"aac": "audio/aac", "apng": "image/apng", "avif": "image/avif",
	"bin": "application/octet-stream", "bmp": "image/bmp",
	"cjs": "application/node", "css": "text/css", "csv": "text/csv",
	"eot": "application/vnd.ms-fontobject", "epub": "application/epub+zip",
	"gif": "image/gif", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
	"gz": "application/gzip",
	"heic": "image/heic", "heif": "image/heif", "htm": "text/html", "html": "text/html",
	"ico": "image/x-icon", "ics": "text/calendar",
	"jar": "application/java-archive", "jpeg": "image/jpeg", "jpg": "image/jpeg",
	"js": "text/javascript", "json": "application/json", "jsonld": "application/ld+json",
	"map": "application/json", "md": "text/markdown", "mid": "audio/midi", "midi": "audio/midi",
	"mjs": "text/javascript", "mp3": "audio/mpeg", "mp4": "video/mp4", "mpeg": "video/mpeg",
	"oga": "audio/ogg", "ogg": "audio/ogg", "ogv": "video/ogg", "opus": "audio/ogg",
	"otf": "font/otf",
	"pdf": "application/pdf", "png": "image/png",
	"rtf": "text/rtf",
	"svg": "image/svg+xml", "svgz": "image/svg+xml",
	"tif": "image/tiff", "tiff": "image/tiff", "toml": "application/toml",
	"ts": "video/mp2t", "ttc": "font/collection", "ttf": "font/ttf", "txt": "text/plain",
	"vtt": "text/vtt",
	"wasm": "application/wasm", "wav": "audio/wav", "weba": "audio/webm",
	"webm": "video/webm", "webmanifest": "application/manifest+json", "webp": "image/webp",
	"woff": "font/woff", "woff2": "font/woff2",
	"xhtml": "application/xhtml+xml", "xml": "text/xml",
	"yaml": "text/yaml", "yml": "text/yaml", "zip": "application/zip"
};

/**
 * @param {string} name
 * @returns {string}
 */
export function mimeLookup(name) {
	const idx = name.lastIndexOf('.');
	return mimes[idx !== -1 ? name.substring(idx + 1).toLowerCase() : ''] || 'application/octet-stream';
}

// -- splitCookiesString -------------------------------------------------------
// Adapted from set-cookie-parser (https://github.com/nfriedly/set-cookie-parser)
// Copyright (c) Nathan Friedly - MIT License
// -----------------------------------------------------------------------------

export function splitCookiesString(cookiesString) {
	if (Array.isArray(cookiesString)) return cookiesString;
	if (typeof cookiesString !== 'string') return [];

	const cookiesStrings = [];
	let pos = 0;
	let start, ch, lastComma, nextStart, cookiesSeparatorFound;

	function skipWhitespace() {
		while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) pos++;
		return pos < cookiesString.length;
	}

	function notSpecialChar() {
		ch = cookiesString.charAt(pos);
		return ch !== '=' && ch !== ';' && ch !== ',';
	}

	while (pos < cookiesString.length) {
		start = pos;
		cookiesSeparatorFound = false;

		while (skipWhitespace()) {
			ch = cookiesString.charAt(pos);
			if (ch === ',') {
				lastComma = pos;
				pos++;
				skipWhitespace();
				nextStart = pos;
				while (pos < cookiesString.length && notSpecialChar()) pos++;
				if (pos < cookiesString.length && cookiesString.charAt(pos) === '=') {
					cookiesSeparatorFound = true;
					pos = nextStart;
					cookiesStrings.push(cookiesString.substring(start, lastComma));
					start = pos;
				} else {
					pos = lastComma + 1;
				}
			} else {
				pos++;
			}
		}

		if (!cookiesSeparatorFound || pos >= cookiesString.length) {
			cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
		}
	}

	return cookiesStrings;
}

// -- Helpers -----------------------------------------------------------------

/**
 * @param {string} value
 * @returns {number}
 */
export function parse_as_bytes(value) {
	const str = value.trim();
	const last = str[str.length - 1]?.toUpperCase();
	// Strip trailing 'B' (e.g. "512KB" -> "512K")
	const normalized = last === 'B' ? str.slice(0, -1) : str;
	const suffix = normalized[normalized.length - 1]?.toUpperCase();
	const multiplier =
		{ K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[suffix] ?? 1;
	return Number(multiplier !== 1 ? normalized.slice(0, -1) : normalized) * multiplier;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function parse_origin(value) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	let url;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. ORIGIN must be a valid URL with http:// or https:// protocol.`,
			{ cause: error }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			`Invalid ORIGIN: '${trimmed}'. Only http:// and https:// protocols are supported.`
		);
	}
	return url.origin;
}
