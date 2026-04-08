<script>
	import { on, status, connect } from 'svelte-adapter-uws/client';

	let { data } = $props();

	const events = on('test-topic');
</script>

<h1>{data.message}</h1>
<p id="status">{$status}</p>
<p id="event">{$events ? JSON.stringify($events) : 'none'}</p>
