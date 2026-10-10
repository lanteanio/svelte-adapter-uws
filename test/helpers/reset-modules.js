// Application modules must bind to this file's globals and injected runtime.
// Run before the other setup files import their cleanup registries.
import { vi } from 'vitest';

// These process-wide slots deliberately join duplicated production bundles.
// A test file owns a fresh application, so clear them only between files;
// sharing and displacement checks within one file remain unchanged.
for (const key of [
	'adapter-uws.subscription-accounting-hook',
	'adapter-uws.settled-subscription-registries',
	'adapter-uws.derived-topic-prefixes',
	'adapter-uws.plugin-owned-topic-prefixes',
	'svelte-adapter-uws.ingress-registry',
	'svelte-adapter-uws.dashboard-contributors',
	'lantean.operational-event-sink.v1',
	'lantean.operational-event-sink-registry.v1'
]) {
	delete globalThis[Symbol.for(key)];
}
delete globalThis.__uws_dev_platform;
vi.resetModules();
