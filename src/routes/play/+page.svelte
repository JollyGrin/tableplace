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
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { ungroupHoveredDeck } from '$lib/hotkeys/ungroup';
	import { shuffleHoveredDeck } from '$lib/hotkeys/shuffle';
	import { startAutoClaim } from '$lib/scenario/autoClaim';
	import Pane from './Pane.svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { randomLobbyName } from '$lib/utils/lobby-name';
	import PaneDecks from './PaneDecks.svelte';
	import PlayerHud from '$lib/hud/PlayerHud.svelte';
	import toast from 'svelte-french-toast';

	function handleKeyDown(event: KeyboardEvent) {
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

	initWrappers();
	let isConnected = $state(false);

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
