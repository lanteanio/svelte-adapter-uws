// The transport session slot is deliberately contained behind this accessor.
// Downstream production integrations must not import the broad testing surface
// or couple themselves to adapter-owned userData symbols just to read it.
const SESSION_ID = Symbol.for('adapter-uws.ws.session-id');

// The attribution slot is contained the same way. Both slots resolve through
// `Symbol.for` here rather than an import, because this subpath deliberately
// ships with NO import graph (its contract test pins that): a production
// integration reads per-connection facts without pulling any runtime module.
// The global symbol registry guarantees this is the same slot the runtime's
// open callback stamped, however the runtime was bundled.
const ATTRIBUTION = Symbol.for('adapter-uws.ws.attribution');

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

/**
 * Read a live connection's server-resolved attribution.
 *
 * Returns the frozen `{ tenantId?, principalId?, entitlement? }` object the
 * runtime resolved at open from the handler module's `attribution(user)`
 * export, or `null` for an unattributed connection or a handle whose native
 * side has already closed. One settled answer per connection: the runtime
 * validated and froze it before the app's open hook ran, and it is never
 * derived from the wire.
 *
 * @param {{ getUserData(): unknown }} connection
 * @returns {Readonly<{ tenantId?: string, principalId?: string, entitlement?: string }> | null}
 */
export function attribution(connection) {
	try {
		return /** @type {any} */ (connection.getUserData())?.[ATTRIBUTION] ?? null;
	} catch {
		return null;
	}
}
