<script lang="ts">
	import { soundEnabled } from './engine';
</script>

<!-- the mute switch (tableplace-204), remembered per browser; the same setting
     as Settings › Keybinds › Sound. Sits above the hint bar, clear of the panes. -->
<button
	type="button"
	data-testid="sound-toggle"
	aria-pressed={!$soundEnabled}
	aria-label={$soundEnabled ? 'Mute table sounds' : 'Unmute table sounds'}
	title={$soundEnabled ? 'Mute table sounds' : 'Unmute table sounds'}
	class="fixed left-4 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white/70 transition-colors select-none hover:bg-black/75 hover:text-white"
	style="bottom: calc(100vh / 6 + 68px)"
	onclick={() => soundEnabled.update((on) => !on)}
>
	<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
		<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke-linejoin="round" />
		{#if $soundEnabled}
			<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke-linecap="round" />
		{:else}
			<path d="M16 9l5 6M21 9l-5 6" stroke-linecap="round" />
		{/if}
	</svg>
</button>
