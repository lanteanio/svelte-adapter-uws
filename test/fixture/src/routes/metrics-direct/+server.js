// Scrape route that imports the metrics module DIRECTLY from the app graph.
//
// This is the read point the shared-instance contract exists for: the Vite
// plugin bundles the registry into the app's own server graph, so this import
// and the instance the runtime populates (exposed as platform.metrics) are one
// object. Against a build where the registry was bundled standalone instead,
// this route reads a second, empty copy and every adapter counter is missing -
// which is exactly what the suite asserts cannot happen.

import metrics from '../../metrics.js';

export function GET({ url }) {
	// `?bump=1` increments a probe counter THROUGH the app-graph import. Under
	// the shared-instance contract that write is visible on platform.metrics
	// too; two instances would each keep their own probe and the platform read
	// point would never see this one.
	if (url.searchParams.get('bump')) metrics.counter('app_graph_probe_total').inc();
	return new Response(metrics.serialize(), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
