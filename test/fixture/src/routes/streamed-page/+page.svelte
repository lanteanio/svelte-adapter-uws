<script>
	let { data } = $props();
</script>
<h1>streamed shell</h1>
{#await data.slow}<p>pending page</p>{:then value}<p>{value}</p>{/await}
