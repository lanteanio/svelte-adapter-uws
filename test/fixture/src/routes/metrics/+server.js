// Scrape route for the fixture's metrics variant.
//
// Reads platform.metrics - the runtime-populated read point, which works on
// every build shape. The sibling metrics-direct route reads the module by
// import instead; the two agreeing is the shared-instance contract the plugin
// provides, and only holds because the plugin bundles the registry into the
// app graph. This route stays on platform.metrics so the platform read point
// keeps its own coverage.

export function GET({ platform }) {
	const registry = platform?.metrics;
	if (!registry) return new Response('', { status: 503 });
	return new Response(registry.serialize(), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
