<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { ACESFilmicToneMapping } from 'three';
	import TableScene from '$lib/TableScene.svelte';
	import { ROOM_COLOR } from '$lib/utils/constants-table';
	import { cameraTransforms } from '$lib/utils/transforms/camera';
	import { onMount } from 'svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { disconnect } from '$lib/websocket/connection';
	import CreatePane from './CreatePane.svelte';
	import { togglePreviewLayout } from './preview-layout';
	import { EDITOR_GUTTER, editorPaneWidth } from './column';
	import { isTyping } from '$lib/hotkeys/is-typing';
	import toast from 'svelte-french-toast';

	// same gestures as /setup, so a card pulled out of a preview pile can be
	// inspected (flip) and arranged without leaving the editor
	function handleKeyDown(event: KeyboardEvent) {
		if (isTyping(event.target)) return;
		if (event.code === 'Space') cameraTransforms.togglePreviewHud(true);
		if (event.code === 'KeyF') gameActions.flipCard();
		if (event.code === 'KeyC') cameraTransforms.resetView();
		if (event.code === 'KeyT') gameActions.tapCard();
		if (event.code === 'KeyR') gameActions.tapCard(true);
		if (event.code === 'ArrowUp') gameActions.incrementHeight(0.01);
		if (event.code === 'ArrowDown') gameActions.incrementHeight(-0.01);
		// L for layout — editor-only, the pane's Layout list without reaching for
		// the mouse. Toasted because the pane can be collapsed or dragged away.
		if (event.code === 'KeyL')
			toast(togglePreviewLayout() === 'spread' ? 'Spread: cards side by side' : 'Deck: piles');
	}

	function handleKeyUp(event: KeyboardEvent) {
		if (isTyping(event.target)) return;
		if (event.code === 'Space') cameraTransforms.togglePreviewHud(false);
	}

	let isReady = $state(false);
	onMount(() => {
		// hard-local editor: kill any live socket from a previous /play visit so
		// authoring a pack never broadcasts into a lobby
		disconnect();
		if (!gameActions.getMe()) gameActions.addPlayer();
		isReady = true;
	});
</script>

<svelte:head>
	<title>pack editor — table.place</title>
	<meta name="description" content="Author a table.place game pack (.tbpp.json) locally" />
</svelte:head>

<svelte:window on:keydown={handleKeyDown} on:keyup|preventDefault={handleKeyUp} />

<!--
	Two columns, not a table with windows floating over it: the editor's pane is
	laid out `inline` inside a fixed-width scrolling column, so it can neither
	overlap itself nor cover the felt the preview draws on (#108). Everything
	right of the column belongs to the table, which is what makes the spread
	fully visible and clickable.
-->
<div class="flex h-screen w-screen overflow-clip" style:background-color={ROOM_COLOR}>
	<!--
		The pane's width plus a stable scrollbar gutter, so the pane's right edge
		is never under the scrollbar and never shifts when a folder opens. A flex
		COLUMN, because what is under the pane matters: the tabs are short (File
		is four rows) and the viewport is not, so CreatePane's footer takes the
		remainder with `mt-auto` rather than leaving a dark slab.
	-->
	<div
		class="flex shrink-0 flex-col overflow-y-auto border-r border-black/50 bg-neutral-900 [scrollbar-gutter:stable]"
		style="width: {$editorPaneWidth + EDITOR_GUTTER}px"
	>
		<CreatePane />
	</div>
	<div class="min-w-0 flex-1">
		<Canvas toneMapping={ACESFilmicToneMapping}>
			{#if isReady}
				<!-- no hand in the pack editor: a card dropped into the tray lands in
				     state no pack can represent, and survives every preview respawn -->
				<TableScene hand={false} />
			{/if}
		</Canvas>
	</div>
</div>
