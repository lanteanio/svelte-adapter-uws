import { canonical_host_aliases, origin, host_header, port_header, protocol_header, is_tls } from './config.js';
import { collectRequestHeaders, isFramingHeader } from '../utils/request-headers.js';
import { originFromHeaders } from '../utils/origin.js';
import { invalidHost } from '../utils/request-target.js';
import { FORBIDDEN_METHODS, send400, send405 } from './http-helpers.js';

export const canonicalRedirectEnabled = canonical_host_aliases.length !== 0;
const aliases = new Set(canonical_host_aliases);
const source = { isTls: is_tls, hostHeader: host_header, portHeader: port_header, protocolHeader: protocol_header };

/**
 * Called only when opted in, after raw target validation and before either
 * static delivery or SSR deduplication. Mounted adapter probes never enter
 * this catch-all. Header collection preserves the existing proxy trust and
 * duplicate rules; unconfigured forwarding headers cannot select an alias.
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {import('uWebSockets.js').HttpRequest} req
 * @param {string} pathname
 * @param {string} query
 * @param {string} method
 * @returns {boolean} whether a response was sent
 */
export function tryCanonicalHostRedirect(res, req, pathname, query, method) {
	const headOnly = method === 'head';
	const headers = {};
	const ambiguous = collectRequestHeaders(req, headers);
	if (ambiguous !== null || !pathname.startsWith('/') || invalidHost(headers.host)) {
		send400(res, headOnly, isFramingHeader(ambiguous));
		return true;
	}
	let authority;
	try {
		const fromHeaders = originFromHeaders(headers, source);
		// Validate port range and IPv6 as well as the shared authority grammar.
		new URL(fromHeaders);
		authority = fromHeaders.slice(fromHeaders.indexOf('://') + 3).toLowerCase();
	} catch {
		send400(res, headOnly);
		return true;
	}
	if (!aliases.has(authority)) return false;
	if (FORBIDDEN_METHODS.has(method)) {
		send405(res, headOnly);
		return true;
	}
	res.cork(() => {
		res.writeStatus('308 Permanent Redirect');
		res.writeHeader('location', origin + pathname + (query ? '?' + query : ''));
		res.endWithoutBody(0);
	});
	return true;
}
