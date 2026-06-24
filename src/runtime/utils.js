// Re-export barrel. Implementation lives in ./utils/*.js, grouped by theme.
// Every name below is the public surface consumed by handler.js, vite.js,
// testing.js, sim.js, and the cursor / groups / presence / crdt / smooth plugins.
// Decomposed from a single 1839-line module; behaviour and exports unchanged.

export * from './utils/mime.js';
export * from './utils/cookies-string.js';
export * from './utils/parse.js';
export * from './utils/backpressure.js';
export * from './utils/epoch.js';
export * from './utils/pressure.js';
export * from './utils/ws-symbols.js';
export * from './utils/caps.js';
export * from './utils/request-id.js';
export * from './utils/upgrade-admission.js';
export * from './utils/metrics.js';
export * from './utils/topic.js';
export * from './utils/origin.js';
export * from './utils/address.js';
export * from './utils/static-headers.js';
export * from './utils/chaos.js';
export * from './utils/assertions.js';
