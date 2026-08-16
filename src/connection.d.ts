import type { Attribution } from './index.js';

/** Minimal structural connection shape accepted by {@link connectionSessionId}. */
export interface ConnectionSessionSource {
	getUserData(): unknown;
}

/**
 * Read a live connection's server-resolved attribution.
 *
 * Returns the frozen `{ tenantId?, principalId?, entitlement? }` object the
 * runtime resolved at open from the handler module's `attribution(user)`
 * export, or `null` for an unattributed connection or a handle whose native
 * side already closed. This is the supported read for app server code and
 * plugins: one settled answer per connection, never re-resolved per call and
 * never derived from the wire.
 */
export declare function attribution(
	connection: ConnectionSessionSource
): Attribution | null;

/**
 * Read the adapter-generated transport session id for a live connection.
 * Returns `undefined` when the connection has no stamped id or its native
 * handle has already closed. This client-visible resume id is not an
 * application authentication identity.
 */
export declare function connectionSessionId(
	connection: ConnectionSessionSource
): string | undefined;
