import { esc } from '../../runtime/utils/topic.js';

/** Validate developer-supplied names before retaining plugin state. */
export function assertSafeTopic(topic) {
	if (typeof topic !== 'string') throw new TypeError('Topic must be a string');
	try { esc(topic); }
	catch { throw new TypeError('Topic must not contain quotes, backslashes, or control characters'); }
}
