<script lang="ts">
	import { Button, Pane, Element, TabGroup, TabPage, Point } from 'svelte-tweakpane-ui';
	import { gameActions } from '$lib/store/game/actions';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { spawnPack, STANDARD_52 } from '$lib/packs';
	import PackLibrary from '$lib/packs/PackLibrary.svelte';
	import { importTtsFile } from '$lib/tts/import';
	import toast from 'svelte-french-toast';
	import { showGlobalControls } from '$lib/utils/debug';

	// decided once: a deeplinked game has no use for the pack library / importer (#181)
	const globalControls = showGlobalControls();

	// getMyId() reads localStorage, which a first-time visitor only gets during
	// websocket init — re-read on store changes so decks claimed via an invite
	// link show up without a refresh
	const myDecks = $derived.by(() => {
		const playerId = gameActions.getMyId();
		return Object.keys($gameStore?.decks ?? {}).filter((key) =>
			key.split(':').includes(playerId || '')
		);
	});

	let fileInput: HTMLInputElement | undefined = $state();
	let isImporting = $state(false);

	async function handleImportFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		isImporting = true;
		try {
			const report = await importTtsFile(await file.text());
			const parts = [`Opened ${report.decks} deck(s), ${report.cards} cards`];
			if (report.pieces > 0) parts.push(`${report.pieces} piece(s)`);
			if (report.missingArt > 0)
				parts.push(`${report.missingArt} with dead art links (named placeholders used)`);
			if (report.skipped.length > 0)
				parts.push(`skipped ${report.skipped.length} unsupported objects`);
			toast(parts.join(' — '), { duration: 6000 });
		} catch (error) {
			toast.error(
				`Could not open the deck: ${error instanceof Error ? error.message : 'invalid file'}`
			);
		} finally {
			isImporting = false;
			input.value = '';
		}
	}
</script>

<Pane
	position="draggable"
	title="Decks"
	expanded={false}
	y={0}
	x={310}
	width={300}
	localStoreId="table-decks-v2"
>
	<!-- the "spawn a deck to get started" hint lives on the page, not here: a
	     tweakpane <Element> mounts its DOM in the pane's *container*, so the
	     title bar drew straight through it (#113) -->
	{#if myDecks.length === 0}
		<Button title="Spawn {STANDARD_52.name}" on:click={() => spawnPack(STANDARD_52)} />
	{/if}
	<!-- bringing your own content onto a LIVE table: spawning goes through the
	     ws-wrapped store, so the whole lobby sees it -->
	{#if globalControls}
		<PackLibrary />
		<Button
			title={isImporting ? 'Opening…' : 'Open a TTS deck (.json)'}
			disabled={isImporting}
			on:click={() => fileInput?.click()}
		/>
		<Element>
			<input
				bind:this={fileInput}
				type="file"
				accept=".json,application/json"
				class="hidden"
				onchange={handleImportFile}
			/>
		</Element>
	{/if}
	<TabGroup>
		{#each myDecks as deckId}
			{@const position = $gameStore?.decks?.[deckId]?.position ?? [0, 0, 0]}
			<TabPage title={deckId?.split(':')?.[2] ?? 'Deck'}>
				<Button title="Shuffle {deckId}" on:click={() => gameActions.shuffleDeck(deckId)} />
				<Point
					label="position"
					value={[position[0], position[2]]}
					on:change={(e) => {
						//@ts-expect-error: does exist
						const x = e.detail.value?.x ?? position[0];
						//@ts-expect-error: does exist
						const y = e.detail.value?.y ?? position[2];
						gameStore.updateState({
							decks: { [deckId]: { position: [x, position[1], y] } }
						});
					}}
				/>
			</TabPage>
		{/each}
	</TabGroup>
</Pane>
