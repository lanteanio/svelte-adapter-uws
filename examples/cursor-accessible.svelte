<script>
	import { onDestroy } from 'svelte';
	import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
	import {
		cursorColor,
		cursorName,
		cursorShape,
		describeBoardPosition,
		hasFiniteCursorPosition,
		summarizeCursorRosterChange
	} from './cursor-accessibility.js';

	const topic = 'board:accessible-example';
	const cells = [
		{ id: 'ideas', label: 'Ideas', x: 0, y: 0, width: 200, height: 240 },
		{ id: 'building', label: 'Building', x: 200, y: 0, width: 200, height: 240 },
		{ id: 'review', label: 'Review', x: 400, y: 0, width: 200, height: 240 }
	];
	const cursors = cursor(topic);

	let board;
	let announcement = '';
	let previous = null;
	let cursorMotionVisible = true;

	const unsubscribe = cursors.subscribe((current) => {
		const summary = summarizeCursorRosterChange(previous, current);
		if (summary) announcement = summary;
		previous = new Map(current);
	});
	onDestroy(unsubscribe);

	function sharePosition(position) {
		move(topic, position);
	}

	function moveToCell(cell) {
		sharePosition({
			x: cell.x + cell.width / 2,
			y: cell.y + cell.height / 2
		});
	}

	function moveFromPointer(event) {
		const bounds = board.getBoundingClientRect();
		sharePosition({
			x: event.clientX - bounds.left,
			y: event.clientY - bounds.top
		});
	}

	function toggleCursorMotion() {
		cursorMotionVisible = !cursorMotionVisible;
	}
</script>

<p id="cursor-instructions">
	Move the pointer over a column, or use Tab to focus a column. Focus and
	pointer input both publish through the same cursor channel. Use the cursor
	motion control to hide the animated layer without hiding the board or its
	collaborator roster.
</p>

<button
	type="button"
	aria-controls="remote-cursor-layer"
	on:click={toggleCursorMotion}
>
	{cursorMotionVisible ? 'Pause remote cursor motion' : 'Show remote cursors'}
</button>

<section
	bind:this={board}
	class="board"
	aria-labelledby="board-heading"
	aria-describedby="cursor-instructions"
>
	<h2 id="board-heading" class="visually-hidden">Project board</h2>
	{#each cells as cell (cell.id)}
		<button
			type="button"
			class="cell"
			on:focus={() => moveToCell(cell)}
			on:click={() => moveToCell(cell)}
			on:pointermove={moveFromPointer}
		>
			<span class="cell-title">{cell.label}</span>
		</button>
	{/each}

	<div id="remote-cursor-layer" class="cursor-layer" aria-hidden="true">
		{#if cursorMotionVisible}
			{#each [...$cursors] as [key, { user, data }] (key)}
				{#if hasFiniteCursorPosition(data)}
					<div
						class="remote-cursor"
						style="left: {data.x}px; top: {data.y}px"
					>
						<span
							class="marker {cursorShape(key)}"
							style="background: {cursorColor(user, key)}"
						></span>
						<span class="cursor-label">{cursorName(user, key)}</span>
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</section>

<section aria-labelledby="collaborators-heading">
	<h2 id="collaborators-heading">Collaborators</h2>
	<p class="visually-hidden" aria-live="polite" aria-atomic="true">
		{announcement}
	</p>
	<ul>
		{#each [...$cursors] as [key, { user, data }] (key)}
			<li>
				<span
					class="roster-marker marker {cursorShape(key)}"
					style="background: {cursorColor(user, key)}"
					aria-hidden="true"
				></span>
				{cursorName(user, key)}, {cursorShape(key)},
				{describeBoardPosition(data, cells)}
			</li>
		{/each}
	</ul>
</section>

<style>
	.board {
		position: relative;
		display: grid;
		grid-template-columns: repeat(3, 200px);
		width: 600px;
		height: 240px;
	}

	.cell {
		border: 1px solid currentColor;
		background: transparent;
		color: inherit;
	}

	.cell:focus-visible {
		outline: 3px solid currentColor;
		outline-offset: -5px;
	}

	.cell-title {
		font-weight: 700;
	}

	.cursor-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.remote-cursor {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		pointer-events: none;
		transform: translate(0.4rem, -50%);
	}

	.cursor-label {
		padding: 0.1rem 0.3rem;
		background: Canvas;
		color: CanvasText;
	}

	.marker {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		border: 2px solid CanvasText;
	}

	.circle {
		border-radius: 50%;
	}

	.diamond {
		transform: rotate(45deg);
	}

	.triangle {
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}

	.roster-marker {
		margin-inline-end: 0.4rem;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.remote-cursor {
			animation: none;
			transition: none;
		}
	}
</style>
