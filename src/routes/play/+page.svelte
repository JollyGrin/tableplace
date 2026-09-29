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
	import JournalPanel from '$lib/journal/JournalPanel.svelte';
	import SoundToggle from '$lib/sound/SoundToggle.svelte';
	import { installSound } from '$lib/sound';
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
	import { ROOM_COLOR } from '$lib/utils/constants-table';

	initWrappers();
	// the table only mounts once the relay has us; until then the page says why
	// it is an empty room (the wrapper's shade used to be the only cue, and the
	// scene's own backdrop now paints over the wrapper once connected)
	let connection = $state<'connecting' | 'connected' | 'failed'>('connecting');
	const isConnected = $derived(connection === 'connected');

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
		// table sounds (tableplace-204): silent until the first gesture, and while muted
		const removeSound = installSound();
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
			connection = res ? 'connected' : 'failed';
			if (res) autoClaimSeat(seatParam);
		});
		return removeSound;
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
<JournalPanel />
<SoundToggle />

<!-- a pack or scenario dropped mid-game lands on the live table (and, for a
     pack, in this browser's library) — no detour through /setup -->
<FileDropZone onfile={async (file) => void (await openDroppedFile(file))} />

<div class="h-screen w-screen overflow-clip" style:background-color={ROOM_COLOR}>
	<!-- threlte 8.5 changed the default to AgX, which desaturates the felt to gray -->
	<Canvas toneMapping={ACESFilmicToneMapping}>
		{#if isConnected}
			<TableScene />
		{/if}
	</Canvas>
</div>

<!-- centred so it clears every pane (Settings left, Decks top, Players right) at
     1280x720 and up, and never eats a click meant for the table -->
{#if isTableEmpty || !isConnected}
	<div
		class="pointer-events-none fixed inset-0 flex flex-col items-center justify-center gap-3 font-sans text-sm tracking-widest text-white uppercase"
	>
		{#if connection === 'connecting'}
			<span class="animate-pulse opacity-60"> Connecting to the table… </span>
		{:else if connection === 'failed'}
			<span class="text-amber-300 opacity-90"> Not connected — check Settings › Connection </span>
		{/if}
		{#if isTableEmpty}
			<span class="animate-pulse opacity-40">Spawn a deck to get started</span>
		{/if}
	</div>
{/if}
