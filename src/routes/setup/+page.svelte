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
	import { disconnect } from '$lib/websocket/connection';
	import SetupPane from './SetupPane.svelte';

	function handleKeyDown(event: KeyboardEvent) {
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
		if (event.code === 'KeyT') gameActions.tapCard();
		if (event.code === 'KeyR') gameActions.tapCard(true);
		if (event.code === 'KeyS') shuffleHoveredDeck();
		// G groups the hovered pile into a deck; Shift+G spreads a hovered deck
		// back into loose cards
		if (event.code === 'KeyG' && event.shiftKey) ungroupHoveredDeck();
		else if (event.code === 'KeyG') gameActions.groupStackIntoDeck();
		if (event.code === 'ArrowUp') gameActions.incrementHeight(0.01);
		if (event.code === 'ArrowDown') gameActions.incrementHeight(-0.01);
		// number keys 1-9 on a hovered deck: draw that many, fanned toward you
		const drawN = /^Digit([1-9])$/.exec(event.code);
		if (drawN && hoveredDeck) gameActions.drawFromTop(hoveredDeck, Number(drawN[1]));
	}

	function handleKeyUp(event: KeyboardEvent) {
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

<div class="h-screen w-screen overflow-clip bg-gray-700">
	<Canvas toneMapping={ACESFilmicToneMapping}>
		{#if isReady}
			<TableScene />
		{/if}
	</Canvas>
</div>
