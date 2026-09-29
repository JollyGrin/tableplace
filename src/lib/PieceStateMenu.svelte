<!--
	The state picker for a multi-state piece: right-click a piece with two or
	more faces and this opens at the pointer.

	Cycling alone is enough for a two-sided tile, but past that "click three
	times to get back" is not a control — so every state is directly
	selectable. It is DOM rather than in-scene because it is a menu: text has
	to stay legible at any camera angle, and the pointer must not fight the
	table's own drag handling.

	Rendered once per route, next to the Canvas; the open piece lives in
	`pieceUi`, so nothing in the scene has to own it.
-->
<script lang="ts">
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { pieceMenu, closePieceMenu } from '$lib/store/pieceUi';
	import { hotkeyLabel } from '$lib/verbs/registry';

	// printed from the registry, so the footer cannot drift from the binding
	const nextKey = hotkeyLabel('state-next', 'piece');

	const piece = $derived($pieceMenu ? $gameStore?.pieces?.[$pieceMenu.id] : undefined);
	const states = $derived(piece?.states ?? []);
	const current = $derived(gameActions.currentPieceState(piece));

	// a piece can be removed (or its states edited away) while the menu is up
	$effect(() => {
		if ($pieceMenu && states.length < 2) closePieceMenu();
	});

	function select(index: number) {
		if ($pieceMenu) gameActions.setPieceState($pieceMenu.id, index);
		closePieceMenu();
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') closePieceMenu();
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $pieceMenu && states.length > 1}
	<!-- click-away catcher: a full-screen layer under the menu, so the next
	     click anywhere dismisses it without stealing the table's pointer events
	     while it is closed -->
	<div
		class="fixed inset-0 z-40"
		role="presentation"
		onpointerdown={closePieceMenu}
		oncontextmenu={(e) => {
			e.preventDefault();
			closePieceMenu();
		}}
	></div>
	<div
		class="fixed z-50 min-w-40 overflow-hidden rounded-md border border-white/10 bg-gray-900/95 text-sm text-gray-100 shadow-xl"
		style="left: {$pieceMenu.x}px; top: {$pieceMenu.y}px"
		role="menu"
		tabindex="-1"
	>
		<div class="border-b border-white/10 px-3 py-1.5 text-xs text-gray-400">
			{piece?.name || 'Piece'} — states
		</div>
		{#each states as state, index (index)}
			<button
				type="button"
				role="menuitem"
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10 {index ===
				current
					? 'bg-white/5'
					: ''}"
				onclick={() => select(index)}
			>
				<span class="w-3 text-emerald-400">{index === current ? '✓' : ''}</span>
				<span>{state.name || `State ${index + 1}`}</span>
			</button>
		{/each}
		<div class="border-t border-white/10 px-3 py-1.5 text-xs text-gray-500">
			{nextKey} — next state
		</div>
	</div>
{/if}
