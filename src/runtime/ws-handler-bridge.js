// Re-export of the build-generated ws-handler module from a runtime/-root module,
// so handler/* sub-modules can import it via ../ws-handler-bridge.js. The build
// replace-map rewrites the WS_HANDLER placeholder to a root-relative path that
// only resolves correctly from a file at the output root (this bridge), not from
// the deeper handler/ directory.
// Await server initialization before evaluating user modules. A static sibling
// import can run while _init.js is suspended at its top-level await.
import './_init.js';
const wsModule = await import('WS_HANDLER');

export { wsModule };
