<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { ACESFilmicToneMapping } from 'three';
	import TableScene from '$lib/TableScene.svelte';
	import { handleVerbKeyDown, handleVerbKeyUp } from '$lib/verbs/keyboard';
	import { onMount } from 'svelte';
	import { initWrappers } from '$lib/websocket/storeIntegration';
	import { initWebsocket } from '$lib/websocket';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import RadialMenu from '$lib/RadialMenu.svelte';
	import HintBar from '$lib/hint/HintBar.svelte';
	import HelpOverlay from '$lib/hint/HelpOverlay.svelte';
	import DeckSearchDrawer from '$lib/deckSearch/DeckSearchDrawer.svelte';
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

<!-- every table hotkey is a verb in $lib/verbs/registry.ts — none is bound here -->
<svelte:window on:keydown={handleVerbKeyDown} on:keyup|preventDefault={handleVerbKeyUp} />

<Pane />
<PaneDecks />
<PlayerHud />
<RadialMenu />
<HintBar />
<HelpOverlay />
<DeckSearchDrawer />

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
