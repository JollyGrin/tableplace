<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { ACESFilmicToneMapping } from 'three';
	import TableScene from '$lib/TableScene.svelte';
	import { cameraTransforms } from '$lib/utils/transforms/camera';
	import { onMount } from 'svelte';
	import { initWrappers } from '$lib/websocket/storeIntegration';
	import { initWebsocket } from '$lib/websocket';
	import { get } from 'svelte/store';
	import { gameActions } from '$lib/store/game/actions';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { ungroupHoveredDeck } from '$lib/hotkeys/ungroup';
	import { shuffleHoveredDeck } from '$lib/hotkeys/shuffle';
	import { drawHoveredDeckToHand } from '$lib/hotkeys/draw';
	import { cycleHoveredPieceState } from '$lib/hotkeys/piece-state';
	import { rotateHoveredModel } from '$lib/hotkeys/model-rotate';
	import { isTyping } from '$lib/hotkeys/is-typing';
	import PieceStateMenu from '$lib/PieceStateMenu.svelte';
	import ModelMenu from '$lib/ModelMenu.svelte';
	import RadialMenu from '$lib/RadialMenu.svelte';
	import { startAutoClaim } from '$lib/scenario/autoClaim';
	import Pane from './Pane.svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { randomLobbyName } from '$lib/utils/lobby-name';
	import PaneDecks from './PaneDecks.svelte';
	import PlayerHud from '$lib/hud/PlayerHud.svelte';
	import FileDropZone from '$lib/files/FileDropZone.svelte';
	import { openDroppedFile } from '$lib/files/drop';
	import toast from 'svelte-french-toast';

	function handleKeyDown(event: KeyboardEvent) {
		// a key typed into a pane field is text, not a table command — and this
		// table is synced, so a stray G would group a pile for everyone
		if (isTyping(event.target)) return;
		// hover-target routing: a hovered deck takes the key, otherwise it
		// falls through to the hovered-card behavior
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
		// Shift+S, not S: W/A/S/D pan the camera and auto-repeat while held, so a
		// bare contextual S would shuffle-spam the moment you panned toward
		// yourself. The radial menu is shuffle's discoverable home now.
		if (event.code === 'KeyS' && event.shiftKey) shuffleHoveredDeck();
		// G groups the hovered pile into a deck; Shift+G spreads a hovered deck
		// back into loose cards
		if (event.code === 'KeyG' && event.shiftKey) ungroupHoveredDeck();
		else if (event.code === 'KeyG') gameActions.groupStackIntoDeck();
		// X shows a hovered piece's next state (Shift+X the previous one);
		// right-click picks one directly
		if (event.code === 'KeyX') cycleHoveredPieceState(event.shiftKey ? -1 : 1);
		if (event.code === 'ArrowUp') gameActions.incrementHeight(0.01);
		if (event.code === 'ArrowDown') gameActions.incrementHeight(-0.01);
		// number keys 1-9 on a hovered deck: draw that many into your hand
		const drawN = /^Digit([1-9])$/.exec(event.code);
		if (drawN && hoveredDeck) drawHoveredDeckToHand(hoveredDeck, Number(drawN[1]));
	}

	function handleKeyUp(event: KeyboardEvent) {
		if (isTyping(event.target)) return;
		if (event.code === 'Space') cameraTransforms.togglePreviewHud(false);
	}

	initWrappers();
	let isConnected = $state(false);

	// nothing on the felt yet — point at the Decks pane rather than leaving a
	// player staring at bare green. Deliberately not gated on `isConnected`: the
	// hint's job is to be there on the very first paint.
	const isTableEmpty = $derived(Object.keys($gameStore?.decks ?? {}).length === 0);

	// ?seat=N invite links: keep trying to claim that seat's placeholder until
	// it succeeds; a give-up is announced, never silent (see autoClaim.ts)
	function autoClaimSeat(seatParam: string | null) {
		startAutoClaim(seatParam, {
			onClaimed: (seat) => toast(`Seat ${seat} claimed — your decks are ready`),
			onFailed: (seat, reason) =>
				toast.error(
					reason === 'seat-taken'
						? `Seat ${seat} is already taken — click an open seat in the Players list to sit down`
						: `Couldn't claim seat ${seat} — once the table is seeded, click an open seat in the Players list`,
					{ duration: 10000 }
				)
		});
	}

	onMount(() => {
		// no ?lobby means someone hit /play directly — roll a name and pin it into
		// the URL *before* connecting, so a refresh rejoins the same table and the
		// address bar is always a copy-pasteable invite
		let lobbyId = page?.url?.searchParams?.get('lobby') ?? undefined;
		if (!lobbyId) {
			lobbyId = randomLobbyName();
			const url = new URL(page.url);
			url.searchParams.set('lobby', lobbyId);
			replaceState(`${url.pathname}${url.search}${url.hash}`, page.state);
		}
		const serverUrl = page?.url?.searchParams?.get('server') ?? undefined;
		const seatParam = page?.url?.searchParams?.get('seat');
		const connected = initWebsocket(lobbyId, serverUrl);
		connected.then((res) => {
			isConnected = res;
			if (res) autoClaimSeat(seatParam);
		});
	});
</script>

<svelte:head>
	<title>table.place</title>
	<meta name="description" content="A browser-based tabletop simulator" />
</svelte:head>

<svelte:window on:keydown={handleKeyDown} on:keyup|preventDefault={handleKeyUp} />

<Pane />
<PaneDecks />
<PlayerHud />
<PieceStateMenu />
<ModelMenu />
<RadialMenu />

<!-- a pack or scenario dropped mid-game lands on the live table (and, for a
     pack, in this browser's library) — no detour through /setup -->
<FileDropZone onfile={async (file) => void (await openDroppedFile(file))} />

<div
	class="h-screen w-screen overflow-clip transition-all"
	class:bg-gray-800={!isConnected}
	class:bg-gray-700={isConnected}
>
	<!-- threlte 8.5 changed the default to AgX, which desaturates the felt to gray -->
	<Canvas toneMapping={ACESFilmicToneMapping}>
		{#if isConnected}
			<TableScene />
		{/if}
	</Canvas>
</div>

<!-- centred so it clears every pane (Settings left, Decks top, Players right) at
     1280x720 and up, and never eats a click meant for the table -->
{#if isTableEmpty}
	<div class="pointer-events-none fixed inset-0 flex items-center justify-center">
		<span class="animate-pulse font-sans text-sm tracking-widest text-white uppercase opacity-40">
			Spawn a deck to get started
		</span>
	</div>
{/if}
