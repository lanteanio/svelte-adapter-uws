// The boot-warmup request tag, kept in its own leaf module.
//
// A warmup render is tagged by object identity so it cannot be forged from the
// wire (a header any client could send). platform.js reads the tag through
// isWarmupRequest to expose it to app hooks; warmup.js writes it. Keeping the
// WeakSet here - a dependency-free leaf both import - is deliberate: platform.js
// sits inside the sealed byte-copy authority graph, so importing the whole
// warmup module (with its render engine and timers) into that graph would churn
// the graph's syntax seal on every unrelated warmup edit. This module never
// touches a byte and effectively never changes.

/** @type {WeakSet<Request>} */
const warmupRequests = new WeakSet();

/** Tag a request as a synthetic boot-warmup render. */
export function tagWarmupRequest(request) {
	warmupRequests.add(request);
}

/**
 * Whether `request` is a synthetic boot-warmup render rather than a real
 * client request. Tagged by object identity, so a real client cannot forge one.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isWarmupRequest(request) {
	return warmupRequests.has(request);
}
