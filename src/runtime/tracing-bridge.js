// Re-export the build-generated tracing provider from a runtime-root module so
// handler submodules can share one provider instance. The adapter build replaces
// TRACING_PROVIDER with the bundled module path. The generated stub exports null
// when tracing is not configured. Source-level tests import runtime modules before
// that replacement exists, so only the exact missing placeholder falls back to
// null; a configured provider's own load error still fails startup.
let tracingProvider = null;
try {
	const loaded = await import('TRACING_PROVIDER');
	tracingProvider = loaded.default ?? null;
} catch (error) {
	const missingPlaceholder = error?.code === 'ERR_MODULE_NOT_FOUND' &&
		String(error?.message ?? '').includes('TRACING_PROVIDER');
	if (!missingPlaceholder) throw error;
}

export { tracingProvider };
