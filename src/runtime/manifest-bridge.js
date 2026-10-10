// Re-export of the build-generated manifest module from a runtime/-root module, so
// handler/* sub-modules can import it via ../manifest-bridge.js (see ws-handler-bridge.js).
import { appPath, prerendered, base } from 'MANIFEST';

export { appPath, prerendered, base };
