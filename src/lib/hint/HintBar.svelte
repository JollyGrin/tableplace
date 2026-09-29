<script lang="ts">
	import { hint } from './hintStore';
	import { hintBarEnabled } from './hintUi';

	/**
	 * One quiet line, bottom-left: what the pointer can do right now. Read-only
	 * DOM over the canvas — `pointer-events-none` on every node, so it can never
	 * take a hover or a click meant for the table.
	 *
	 * Placement: it sits just above the hand tray (the bottom sixth of the
	 * canvas — HUDTrayScene) and inside the left half, which the zoomed preview
	 * never enters (it is fitted into the right half — HUDPreviewScene).
	 *
	 * Always one line: every part is an unbreakable flex item and the row is one
	 * line tall, so a part that does not fit wraps out of sight whole rather
	 * than breaking mid-phrase. The parts are ordered most useful first.
	 */
</script>

{#if $hintBarEnabled}
	<div
		data-testid="hint-bar"
		class="pointer-events-none fixed left-4 z-10 flex h-7 max-w-[min(640px,calc(50vw-24px))] flex-wrap items-center overflow-hidden rounded-md bg-black/55 px-2.5 font-sans text-xs leading-7 text-white/60 select-none"
		style="bottom: calc(100vh / 6 + 8px)"
		aria-live="polite"
	>
		{#if $hint.name}
			<b class="min-w-0 truncate font-semibold text-white/90">{$hint.name}</b>
		{/if}
		{#each $hint.parts as part, i (i)}
			<span
				class="whitespace-nowrap"
				class:opacity-50={!part.enabled}
				title={part.reason}
				data-hint-verb={part.text}
			>
				{#if $hint.name || i > 0}<span class="px-1.5 text-white/30">·</span>{/if}{#if part.key}<kbd
						class="rounded border border-white/20 bg-white/10 px-1 font-mono text-[11px] leading-4 text-white/90"
						>{part.key}</kbd
					>&nbsp;{/if}<span class:line-through={!part.enabled}>{part.text}</span>
			</span>
		{/each}
	</div>
{/if}
