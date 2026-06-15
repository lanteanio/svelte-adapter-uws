import { esc } from '../utils.js';
import { envelopePrefixCache } from './state.js';

// Cache for pre-built envelope prefixes. Repeated publishes to the same
// topic+event (e.g. platform.topic('chat').created()) reuse the prefix
// instead of rebuilding it from 4 string concatenations each time.
export const ENVELOPE_CACHE_MAX = 256;

/**
 * Build or retrieve the JSON envelope prefix for a topic+event pair.
 * @param {string} topic
 * @param {string} event
 * @returns {string} e.g. '{"topic":"chat","event":"created","data":'
 */
export function envelopePrefix(topic, event) {
	const key = topic + '\0' + event;
	let prefix = envelopePrefixCache.get(key);
	if (prefix === undefined) {
		prefix = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
		if (envelopePrefixCache.size >= ENVELOPE_CACHE_MAX) {
			envelopePrefixCache.delete(envelopePrefixCache.keys().next().value);
		}
		envelopePrefixCache.set(key, prefix);
	}
	return prefix;
}
