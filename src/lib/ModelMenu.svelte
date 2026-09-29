<!--
	The context menu for a `kind: 'model'` piece: right-click a cave section and
	this opens at the pointer with the three verbs a section has — rotate (by
	the grid's 90° step), the per-piece snap toggle, and remove.

	DOM rather than in-scene for exactly PieceStateMenu's reasons: a menu's text
	must stay legible at any camera angle and its pointer must not fight the
	table's drag handling. Rendered once per route, next to the Canvas; the open
	piece lives in `pieceUi`.
-->
<script lang="ts">
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { modelMenu, closeModelMenu } from '$lib/store/pieceUi';
	import { SNAP_GRID_YAW_STEP_DEFAULT } from '$lib/utils/constants-snap';
	import { hotkeyLabel } from '$lib/verbs/registry';

	// printed from the registry, so the footer cannot drift from the binding
	const rotateKeys = `${hotkeyLabel('rotate-cw', 'piece')} / ${hotkeyLabel('rotate-ccw', 'piece')}`;

	const piece = $derived($modelMenu ? $gameStore?.pieces?.[$modelMenu.id] : undefined);
	const snaps = $derived(piece?.snap !== false);

	// the piece can be removed (or claim-renamed) while the menu is up
	$effect(() => {
		if ($modelMenu && (!piece || piece.kind !== 'model')) closeModelMenu();
	});

	function rotate(delta: number) {
		if ($modelMenu) gameActions.rotatePiece($modelMenu.id, delta);
		// stays open: rotating is often repeated, and reopening per 90° is busywork
	}

	function toggleSnap() {
		if ($modelMenu) gameActions.setPieceSnap($modelMenu.id, !snaps);
		closeModelMenu();
	}

	function remove() {
		if ($modelMenu) gameActions.removePiece($modelMenu.id);
		closeModelMenu();
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeModelMenu();
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $modelMenu && piece?.kind === 'model'}
	<!-- click-away catcher, same layering as PieceStateMenu -->
	<div
		class="fixed inset-0 z-40"
		role="presentation"
		onpointerdown={closeModelMenu}
		oncontextmenu={(e) => {
			e.preventDefault();
			closeModelMenu();
		}}
	></div>
	<div
		class="fixed z-50 min-w-44 overflow-hidden rounded-md border border-white/10 bg-gray-900/95 text-sm text-gray-100 shadow-xl"
		style="left: {$modelMenu.x}px; top: {$modelMenu.y}px"
		role="menu"
		tabindex="-1"
		data-testid="model-menu"
	>
		<div class="border-b border-white/10 px-3 py-1.5 text-xs text-gray-400">
			{piece?.name || 'Model'}
		</div>
		<button
			type="button"
			role="menuitem"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
			data-testid="model-menu-rotate-cw"
			onclick={() => rotate(SNAP_GRID_YAW_STEP_DEFAULT)}
		>
			Rotate +{SNAP_GRID_YAW_STEP_DEFAULT}°
		</button>
		<button
			type="button"
			role="menuitem"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
			data-testid="model-menu-rotate-ccw"
			onclick={() => rotate(-SNAP_GRID_YAW_STEP_DEFAULT)}
		>
			Rotate −{SNAP_GRID_YAW_STEP_DEFAULT}°
		</button>
		<button
			type="button"
			role="menuitem"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
			data-testid="model-menu-snap"
			onclick={toggleSnap}
		>
			<span class="w-3 text-emerald-400">{snaps ? '✓' : ''}</span>
			<span>Snap to grid</span>
		</button>
		<button
			type="button"
			role="menuitem"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 hover:bg-white/10"
			data-testid="model-menu-remove"
			onclick={remove}
		>
			Remove
		</button>
		<div class="border-t border-white/10 px-3 py-1.5 text-xs text-gray-500">
			{rotateKeys} — rotate
		</div>
	</div>
{/if}
