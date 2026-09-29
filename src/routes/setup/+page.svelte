<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { ACESFilmicToneMapping } from 'three';
	import TableScene from '$lib/TableScene.svelte';
	import { handleVerbKeyDown, handleVerbKeyUp } from '$lib/verbs/keyboard';
	import { onMount } from 'svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { disconnect } from '$lib/websocket/connection';
	import RadialMenu from '$lib/RadialMenu.svelte';
	import SetupPane from './SetupPane.svelte';

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

<!-- every table hotkey is a verb in $lib/verbs/registry.ts — none is bound here -->
<svelte:window on:keydown={handleVerbKeyDown} on:keyup|preventDefault={handleVerbKeyUp} />

<SetupPane />
<RadialMenu />

<div class="h-screen w-screen overflow-clip bg-gray-700">
	<Canvas toneMapping={ACESFilmicToneMapping}>
		{#if isReady}
			<TableScene snapEditing drawToHand={false} />
		{/if}
	</Canvas>
</div>
