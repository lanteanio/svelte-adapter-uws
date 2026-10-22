<script>
	let { data } = $props();
</script>

<h1>deferred shell</h1>
{#await data.later}
	<p>waiting</p>
{:then value}
	<p>{value}</p>
{/await}
