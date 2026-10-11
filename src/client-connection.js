// Package-internal access for plugins. The client installs its implicit accessor,
// which creates the first connection but never reopens a permanently closed one.
/** @type {{ get: () => ReturnType<typeof import('./client.js').connect> }} */
export const clientConnection = {
	get() { throw new Error('Client connection is not initialized'); }
};
