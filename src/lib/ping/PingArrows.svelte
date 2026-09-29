<script lang="ts">
	/**
	 * Edge arrows for pings outside this view (tableplace-198): one chevron per
	 * off-screen ping, on the rim of the view, pointing at it in the pinger's
	 * colour. Positions come from PingRipples.svelte, which owns the camera.
	 * Never takes the pointer.
	 */
	import { pingArrows } from '$lib/ping';
</script>

{#each $pingArrows as arrow (arrow.key)}
	<div
		class="pointer-events-none fixed z-40"
		style="left: {arrow.x}px; top: {arrow.y}px; transform: translate(-50%, -50%) rotate({arrow.angle}deg); color: {arrow.color}"
		data-ping-arrow={arrow.key}
		aria-hidden="true"
	>
		<svg width="30" height="30" viewBox="-15 -15 30 30" class="drop-shadow">
			<path
				d="M 12 0 L -8 -10 L -3 0 L -8 10 Z"
				fill="currentColor"
				stroke="rgba(0,0,0,0.55)"
				stroke-width="1.5"
				stroke-linejoin="round"
			/>
		</svg>
	</div>
{/each}
