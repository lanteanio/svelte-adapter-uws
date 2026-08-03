/** Minimal structural connection shape accepted by {@link connectionSessionId}. */
export interface ConnectionSessionSource {
	getUserData(): unknown;
}

/**
 * Read the adapter-generated transport session id for a live connection.
 * Returns `undefined` when the connection has no stamped id or its native
 * handle has already closed. This client-visible resume id is not an
 * application authentication identity.
 */
export declare function connectionSessionId(
	connection: ConnectionSessionSource
): string | undefined;
