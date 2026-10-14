import { isMainThread } from 'node:worker_threads';

export function init() {
	if (process.env.CLUSTER_WORKERS && isMainThread) {
		throw new Error('SvelteKit initialized in the cluster coordinator');
	}
}
