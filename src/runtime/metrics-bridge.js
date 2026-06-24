// Re-export of the build-generated metrics-registry module from a runtime/-root
// module, so handler/* sub-modules can import it via ../metrics-bridge.js. The
// build replace-map rewrites the METRICS_REGISTRY placeholder to a root-relative
// path that only resolves correctly from a file at the output root (this
// bridge), not from the deeper handler/ directory. Mirrors ws-handler-bridge.js.
//
// The default export is the user's registry (from `websocket.metrics`), or
// `null` when metrics are not configured.
import metricsRegistry from 'METRICS_REGISTRY';

export { metricsRegistry };
