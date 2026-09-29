<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { ACESFilmicToneMapping } from 'three';
	import TableScene from '$lib/TableScene.svelte';
	import { cameraTransforms } from '$lib/utils/transforms/camera';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { gameActions } from '$lib/store/game/actions';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { ungroupHoveredDeck } from '$lib/hotkeys/ungroup';
	import { shuffleHoveredDeck } from '$lib/hotkeys/shuffle';
	import { cycleHoveredPieceState } from '$lib/hotkeys/piece-state';
	import { rotateHoveredModel } from '$lib/hotkeys/model-rotate';
	import { isTyping } from '$lib/hotkeys/is-typing';
	import { disconnect } from '$lib/websocket/connection';
	import PieceStateMenu from '$lib/PieceStateMenu.svelte';
	import ModelMenu from '$lib/ModelMenu.svelte';
	import RadialMenu from '$lib/RadialMenu.svelte';
	import SetupPane from './SetupPane.svelte';

	function handleKeyDown(event: KeyboardEvent) {
		// a key typed into a pane field is text, not a table command
		if (isTyping(event.target)) return;
		// hover-target routing: a hovered deck takes the key, otherwise it
		// falls through to the hovered-card behavior (mirrors /play)
		const hoveredDeck = get(dragStore).isDeckHovered;
		if (event.code === 'Space') cameraTransforms.togglePreviewHud(true);
		// F flips whatever is under the pointer — the whole deck beats the card
		if (event.code === 'KeyF') {
			if (hoveredDeck) gameActions.flipDeck(hoveredDeck);
			else gameActions.flipCard();
		}
		if (event.code === 'KeyC') cameraTransforms.resetView();
		// T/R turn a hovered model by the grid step; otherwise they tap the card
		if (event.code === 'KeyT' && !rotateHoveredModel(1)) gameActions.tapCard();
		if (event.code === 'KeyR' && !rotateHoveredModel(-1)) gameActions.tapCard(true);
		// Shift+S, not S: W/A/S/D pan the camera (mirrors /play — a held pan key
		// must not shuffle on every repeat)
		if (event.code === 'KeyS' && event.shiftKey) shuffleHoveredDeck();
		// G groups the hovered pile into a deck; Shift+G spreads a hovered deck
		// back into loose cards
		if (event.code === 'KeyG' && event.shiftKey) ungroupHoveredDeck();
		else if (event.code === 'KeyG') gameActions.groupStackIntoDeck();
		// same verb as /play: X shows a hovered piece's next state. Here it also
		// sets what the placement saves as its initial state.
		if (event.code === 'KeyX') cycleHoveredPieceState(event.shiftKey ? -1 : 1);
		if (event.code === 'ArrowUp') gameActions.incrementHeight(0.01);
		if (event.code === 'ArrowDown') gameActions.incrementHeight(-0.01);
		// number keys 1-9 on a hovered deck: draw that many, fanned toward you
		const drawN = /^Digit([1-9])$/.exec(event.code);
		if (drawN && hoveredDeck) gameActions.drawFromTop(hoveredDeck, Number(drawN[1]));
	}

	function handleKeyUp(event: KeyboardEvent) {
		if (isTyping(event.target)) return;
		if (event.code === 'Space') cameraTransforms.togglePreviewHud(false);
	}

	let isReady = $state(false);
	onMount(() => {
		// hard-local editor: kill any live socket from a previous /play visit so
		// arranging a scenario never broadcasts into a lobby
		disconnect();
		if (!gameActions.getMe()) gameActions.addPlayer();
		isReady = true;
	});
</script>

<svelte:head>
	<title>scenario setup — table.place</title>
	<meta name="description" content="Build a reusable game setup locally" />
</svelte:head>

<svelte:window on:keydown={handleKeyDown} on:keyup|preventDefault={handleKeyUp} />

<SetupPane />
<PieceStateMenu />
<ModelMenu />
<RadialMenu />

<div class="h-screen w-screen overflow-clip bg-gray-700">
	<Canvas toneMapping={ACESFilmicToneMapping}>
		{#if isReady}
			<TableScene snapEditing drawToHand={false} />
		{/if}
	</Canvas>
</div>
