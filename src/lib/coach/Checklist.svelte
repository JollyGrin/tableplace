<script lang="ts">
	/**
	 * The "things to try" strip (tableplace-206): a few verbs to try on a new
	 * table, each ticking itself off when you do it. Dismissed with its ×,
	 * remembered in this browser; the `?` reference brings it back. A scenario's
	 * `coach: false` hides it on that table.
	 *
	 * Placement: bottom-left, stacked above the hint bar and the mute switch —
	 * so it clears the hand tray (the bottom sixth of the canvas) and stays in
	 * the left half, which the zoomed preview never enters. Below the `sm`
	 * width the table log's column (w-72, bottom-right) reaches into the left
	 * half, so the strip rises clear of a full log instead.
	 *
	 * Only the × takes a click: the rest is `pointer-events-none`, so it can
	 * never eat a hover or a drag meant for the table beneath it.
	 */
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { tableAllowsCoach } from './table';
	import { checklistItems } from './checklist';
	import { coach, dismissCoach } from './index';

	const ITEMS = checklistItems();

	const shown = $derived(!$coach.dismissed && tableAllowsCoach($gameStore));
	const done = $derived(ITEMS.filter((item) => $coach.done.includes(item.id)).length);
</script>

{#if shown}
	<section
		data-testid="coach"
		aria-label="Things to try"
		class="pointer-events-none fixed bottom-[calc(100vh/6_+_256px)] left-4 z-10 max-w-[min(640px,calc(50vw-24px))] rounded-md bg-black/55 px-2.5 py-1.5 font-sans text-xs text-white/60 select-none sm:bottom-[calc(100vh/6_+_104px)]"
	>
		<header class="mb-1 flex items-center gap-2">
			<b class="font-semibold text-white/90">Things to try</b>
			<span class="text-white/40" data-testid="coach-count">{done}/{ITEMS.length}</span>
			<button
				type="button"
				data-testid="coach-dismiss"
				aria-label="Hide things to try (bring it back with ?)"
				title="Hide — bring it back with ?"
				class="pointer-events-auto ml-auto rounded px-1 leading-4 text-white/50 hover:bg-white/10 hover:text-white"
				onclick={() => dismissCoach()}>×</button
			>
		</header>
		<ul class="flex flex-wrap gap-x-3 gap-y-0.5">
			{#each ITEMS as item (item.id)}
				{@const ticked = $coach.done.includes(item.id)}
				<li
					data-coach-item={item.id}
					data-done={ticked}
					class="flex items-center gap-1.5 leading-5 whitespace-nowrap"
					class:text-white={ticked}
				>
					<span
						aria-hidden="true"
						class="h-2.5 w-2.5 flex-none rounded-full border {ticked
							? 'border-emerald-400 bg-emerald-400'
							: 'border-white/40'}"
					></span>
					<kbd
						class="rounded border border-white/20 bg-white/10 px-1 font-mono text-[11px] leading-4 text-white/90"
						>{item.key}</kbd
					>
					<span class:line-through={ticked} class:opacity-60={ticked}>{item.text}</span>
					<span class="sr-only">{ticked ? '(done)' : ''}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}
