<script>
	// Rendered per request, and long enough to cross the runtime's compression
	// floor, so a suite can watch the single-chunk SSR lane choose a coding.
	const lines = Array.from({ length: 40 }, (_, index) => index);
</script>

<h1 data-testid="compressible">compressible</h1>
{#each lines as line}
	<p>line {line}: the quick brown fox jumps over the lazy dog</p>
{/each}
