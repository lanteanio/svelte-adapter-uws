import { createHmac } from 'node:crypto';
import { randomBytes as runtimeRandomBytes } from '../runtime.js';

// Process-local key: opaque references correlate repeated values inside one
// worker lifetime without becoming a stable cross-deployment identifier or a
// reversible unkeyed hash. The key is never exported or written to a log.
const OBSERVABILITY_REFERENCE_KEY = runtimeRandomBytes(32);

/**
 * Describe an externally supplied value without retaining the value itself.
 * String values receive a process-local keyed reference plus size metadata;
 * other values expose only their JavaScript kind. Conversion is deliberately
 * avoided for objects so a hostile getter, Proxy, or toString cannot turn a
 * diagnostic path into an application failure.
 *
 * @param {unknown} value
 * @param {string} [kind='value']
 * @returns {{ dataClass: 'pseudonymous', kind: string, valueType: string, ref?: string, chars?: number, bytes?: number }}
 */
export function privateValueMetadata(value, kind = 'value') {
	const safeKind = /^[a-z][a-z0-9-]{0,31}$/.test(kind) ? kind : 'value';
	if (typeof value !== 'string') {
		return {
			dataClass: 'pseudonymous',
			kind: safeKind,
			valueType: value === null ? 'null' : typeof value
		};
	}
	const digest = createHmac('sha256', OBSERVABILITY_REFERENCE_KEY)
		.update(value, 'utf8')
		.digest('base64url')
		.slice(0, 16);
	return {
		dataClass: 'pseudonymous',
		kind: safeKind,
		valueType: 'string',
		ref: safeKind + ':' + digest,
		chars: value.length,
		bytes: Buffer.byteLength(value, 'utf8')
	};
}
