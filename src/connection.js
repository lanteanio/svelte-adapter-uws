// The transport session slot is deliberately contained behind this accessor.
// Downstream production integrations must not import the broad testing surface
// or couple themselves to adapter-owned userData symbols just to read it.
const SESSION_ID = Symbol.for('adapter-uws.ws.session-id');

/**
 * Read the adapter-generated transport session id for a live connection.
 * Returns undefined when the connection has no stamped id or its native handle
 * has already closed. This id is client-visible resume metadata, not an
 * application authentication identity.
 *
 * @param {{ getUserData(): unknown }} connection
 * @returns {string | undefined}
 */
export function connectionSessionId(connection) {
	try {
		const value = /** @type {any} */ (connection.getUserData())?.[SESSION_ID];
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}
