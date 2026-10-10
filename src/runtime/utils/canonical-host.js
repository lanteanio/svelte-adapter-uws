import { invalidHost } from './request-target.js';

/**
 * Exact, case-insensitive authorities. Ports stay explicit; no wildcard or
 * suffix matching can redirect an unrelated host. Disabled means no work on
 * the request path and keeps ORIGIN's existing normalization unchanged.
 * @param {string} value
 * @param {string | undefined} origin
 * @returns {string[]}
 */
export function parseCanonicalHostAliases(value, origin) {
	if (!value.trim()) return [];
	let target;
	try { target = new URL(origin ?? ''); } catch { /* diagnosed below */ }
	if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
		target.pathname !== '/' || target.search || target.hash) {
		throw new Error('CANONICAL_HOST_ALIASES requires ORIGIN to be an HTTP(S) origin without credentials, path, query or fragment.');
	}
	const aliases = new Set();
	for (const raw of value.split(',')) {
		const alias = raw.trim().toLowerCase();
		let parsed;
		try { parsed = new URL(target.protocol + '//' + alias); } catch { /* diagnosed below */ }
		if (!alias || invalidHost(alias) || alias.endsWith(':') || !parsed || parsed.username || parsed.password) {
			throw new Error('CANONICAL_HOST_ALIASES must contain comma-separated host authorities with optional numeric ports.');
		}
		if (parsed.origin === target.origin) {
			throw new Error('CANONICAL_HOST_ALIASES must not include the canonical ORIGIN authority.');
		}
		aliases.add(alias);
	}
	return [...aliases];
}
