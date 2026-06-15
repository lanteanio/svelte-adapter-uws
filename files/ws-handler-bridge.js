// Re-export of the build-generated ws-handler module from a files/-root module,
// so handler/* sub-modules can import it via ../ws-handler-bridge.js. The build
// replace-map rewrites the WS_HANDLER placeholder to a root-relative path that
// only resolves correctly from a file at the output root (this bridge), not from
// the deeper handler/ directory.
import * as wsModule from 'WS_HANDLER';

export { wsModule };
