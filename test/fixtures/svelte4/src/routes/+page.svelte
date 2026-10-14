<script>
	import { on, status } from 'svelte-adapter-uws/client';

	export let data;
	const events = on('svelte4-floor');
</script>

<h1>{data.message}</h1>
<p id="status">{$status}</p>
<p id="store">{$events ? JSON.stringify($events) : 'none'}</p>
