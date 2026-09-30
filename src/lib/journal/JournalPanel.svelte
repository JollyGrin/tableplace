<script lang="ts">
	/**
	 * The table log (tableplace-201): the last few actions anyone took, each in
	 * its player's seat colour. Read-only DOM; only the header takes a click,
	 * so the lines can never eat a drag meant for the table beneath them.
	 *
	 * Bottom-right, just above the hand tray (the bottom sixth of the canvas —
	 * HUDTrayScene), clear of the Players pane (top-right) and the hint bar
	 * (bottom-left).
	 */
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { playerColor } from '$lib/hud/players';
	import { journal } from './index';
	import { entryText } from './entry';

	const SHOWN = 8;
	const COLLAPSE_KEY = 'hud:journal:collapsed';

	const log = journal.log;
	const lines = $derived($log.slice(-SHOWN));
	const myId = $derived($gameStore && gameActions.getMyId());

	let collapsed = $state(readCollapsed());

	function readCollapsed() {
		try {
			return localStorage.getItem(COLLAPSE_KEY) === 'true';
		} catch {
			return false;
		}
	}

	function toggle() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSE_KEY, String(collapsed));
		} catch {
			// storage disabled — the toggle still works for this session
		}
	}
</script>

<div
	data-testid="journal"
	class="pointer-events-none fixed right-2 z-40 flex w-72 flex-col items-end gap-1 font-sans text-xs select-none"
	style="bottom: calc(100vh / 6 + 8px)"
>
	{#if !collapsed}
		<ol class="flex w-full flex-col gap-0.5" aria-live="polite">
			{#each lines as line (line.id)}
				{@const color = playerColor(line.actor, $gameStore?.players?.[line.actor]?.seat)}
				<li
					data-journal-line={line.verb}
					data-actor={line.actor}
					class="truncate rounded bg-black/55 px-2 py-0.5 leading-5 text-white/80"
				>
					<b class="font-semibold" style="color: {color}"
						>{line.actor === myId ? 'You' : line.actor}</b
					>
					{entryText(line)}
				</li>
			{/each}
		</ol>
	{/if}
	<button
		type="button"
		onclick={toggle}
		aria-expanded={!collapsed}
		class="pointer-events-auto rounded bg-black/55 px-2 py-0.5 text-[0.65rem] tracking-wide text-white/60 uppercase hover:text-white"
	>
		Log {collapsed ? '▸' : '▾'}
		<span class="normal-case opacity-70">· Ctrl/⌘+Z undo</span>
	</button>
</div>
