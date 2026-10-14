import adapter from 'svelte-adapter-uws';

export default {
	kit: {
		adapter: adapter({
			out: 'build',
			websocket: { handler: 'src/hooks.ws.js' }
		})
	}
};
