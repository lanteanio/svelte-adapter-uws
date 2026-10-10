const MIN_HTTP_DATE = Date.UTC(1900, 0, 1);

/**
 * Resolve a file validator against the clock snapshot held during indexing.
 * Unrepresentable or future dates are omitted; the raw-mtime ETag stays valid.
 * @param {number} mtimeMs
 * @param {number} indexNowMs
 * @returns {number | undefined}
 */
export function staticLastModifiedTime(mtimeMs, indexNowMs) {
	if (mtimeMs >= MIN_HTTP_DATE && mtimeMs <= indexNowMs) {
		return Math.floor(mtimeMs / 1000) * 1000;
	}
	return undefined;
}
