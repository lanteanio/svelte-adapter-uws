<script>
	import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';

	let canvas = $state();
	let feedSize = $state(0);
	let mounted = $state(false);

	$effect(() => {
		if (!canvas) return;
		const handle = cursor('e2e-board', { canvas, mainThreadFeed: { rate: 20 } });
		const unsub = handle.feed.subscribe((m) => {
			feedSize = m.size;
			window.__cursorFeed = [...m.entries()];
		});
		const teardown = handle.mount();
		mounted = true;
		return () => {
			unsub();
			teardown();
		};
	});
</script>

<h1>cursor canvas</h1>
<p id="mounted">{mounted}</p>
<p id="feed-size">{feedSize}</p>
<canvas
	bind:this={canvas}
	id="cursor-canvas"
	style="width: 400px; height: 300px; border: 1px solid #888"
	width="400"
	height="300"
	onpointermove={(e) => move('e2e-board', { x: e.offsetX, y: e.offsetY })}
></canvas>
