// Scrape route for the fixture's metrics variant.
//
// Reads platform.metrics - the SAME registry instance the runtime writes to.
// Importing ../metrics.js here instead would hand back a second, empty registry
// and every counter would read zero, which is exactly the kind of assertion that
// passes while proving nothing.

export function GET({ platform }) {
	const registry = platform?.metrics;
	if (!registry) return new Response('', { status: 503 });
	return new Response(registry.serialize(), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
