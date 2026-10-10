// - MIME types ------------------------------------------------------------------

export const mimes = {
	"3g2": "video/3gpp2", "3gp": "video/3gpp", "3gpp": "video/3gpp", "3mf": "model/3mf",
	"aac": "audio/aac", "apng": "image/apng", "avif": "image/avif",
	"bin": "application/octet-stream", "bmp": "image/bmp",
	"cjs": "application/node", "css": "text/css; charset=utf-8", "csv": "text/csv; charset=utf-8",
	"eot": "application/vnd.ms-fontobject", "epub": "application/epub+zip",
	"gif": "image/gif", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
	"gz": "application/gzip",
	"heic": "image/heic", "heif": "image/heif", "htm": "text/html; charset=utf-8", "html": "text/html; charset=utf-8",
	"ico": "image/x-icon", "ics": "text/calendar; charset=utf-8",
	"jar": "application/java-archive", "jpeg": "image/jpeg", "jpg": "image/jpeg",
	"js": "text/javascript; charset=utf-8", "json": "application/json", "jsonld": "application/ld+json",
	"map": "application/json", "md": "text/markdown; charset=utf-8", "mid": "audio/midi", "midi": "audio/midi",
	"mjs": "text/javascript; charset=utf-8", "mp3": "audio/mpeg", "mp4": "video/mp4", "mpeg": "video/mpeg",
	"oga": "audio/ogg", "ogg": "audio/ogg", "ogv": "video/ogg", "opus": "audio/ogg",
	"otf": "font/otf",
	"pdf": "application/pdf", "png": "image/png",
	"rtf": "text/rtf",
	"svg": "image/svg+xml", "svgz": "image/svg+xml",
	"tif": "image/tiff", "tiff": "image/tiff", "toml": "application/toml",
	"ts": "video/mp2t", "ttc": "font/collection", "ttf": "font/ttf", "txt": "text/plain; charset=utf-8",
	"vtt": "text/vtt; charset=utf-8",
	"wasm": "application/wasm", "wav": "audio/wav", "weba": "audio/webm",
	"webm": "video/webm", "webmanifest": "application/manifest+json", "webp": "image/webp",
	"woff": "font/woff", "woff2": "font/woff2",
	"xhtml": "application/xhtml+xml", "xml": "text/xml",
	"yaml": "text/yaml; charset=utf-8", "yml": "text/yaml; charset=utf-8", "zip": "application/zip"
};

/**
 * @param {string} name
 * @returns {string}
 */
export function mimeLookup(name) {
	const idx = name.lastIndexOf('.');
	return mimes[idx !== -1 ? name.substring(idx + 1).toLowerCase() : ''] || 'application/octet-stream';
}
