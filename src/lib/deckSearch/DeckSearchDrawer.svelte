<script lang="ts">
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { closeDeckSearch, searchingDeck, takeSearchedCard } from './deckSearch';
	import { searchView } from './view';

	/**
	 * The deck search drawer (tableplace-196). Lists the open deck's cards; a
	 * click takes one into your hand, Shift+click lays it face-up on the felt.
	 * Closing shuffles a face-down deck unless "Shuffle" is unticked.
	 *
	 * A 100-card deck is paged, not rendered whole: one page of images at a
	 * time keeps layout and decode cost flat whatever the deck size.
	 */

	const deck = $derived($searchingDeck ? $gameStore?.decks?.[$searchingDeck] : undefined);
	const faceUp = $derived(deck?.isFaceUp ?? false);

	let filter = $state('');
	let page = $state(0);
	let shuffle = $state(true);

	const view = $derived(searchView(deck?.cards ?? [], faceUp, filter, page));

	// every open starts fresh: no filter, first page, Shuffle ticked. Writes
	// only — never reads — the state it resets.
	$effect(() => {
		if (!$searchingDeck) return;
		filter = '';
		page = 0;
		shuffle = true;
	});

	function close() {
		closeDeckSearch(shuffle && !faceUp);
	}

	function onKeyDown(event: KeyboardEvent) {
		if ($searchingDeck && event.key === 'Escape') close();
	}

	// the panel, not the filter: the `/` that opened the drawer is still on its
	// way to a keypress, and a focused field would type it
	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $searchingDeck && deck}
	<!-- the backdrop closes like Esc; it also keeps the pointer off the table -->
	<div
		class="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-16"
		role="presentation"
		onpointerdown={(event) => event.target === event.currentTarget && close()}
	>
		<div
			data-testid="deck-search"
			role="dialog"
			aria-modal="true"
			aria-label="Search deck"
			tabindex="-1"
			use:focusOnMount
			class="flex max-h-full w-full max-w-2xl flex-col rounded-lg bg-neutral-900/95 p-4 font-sans text-sm text-white/80 shadow-xl"
		>
			<header class="mb-2 flex items-center justify-between gap-3">
				<b class="text-base font-semibold text-white">
					{faceUp ? 'Face-up pile' : 'Deck'} · {view.total}
					{view.total === 1 ? 'card' : 'cards'}
				</b>
				<div class="flex items-center gap-3">
					{#if !faceUp}
						<label class="flex items-center gap-1 text-xs text-white/70">
							<input type="checkbox" data-testid="deck-search-shuffle" bind:checked={shuffle} />
							Shuffle
						</label>
					{/if}
					<button
						data-testid="deck-search-close"
						class="rounded border border-white/20 px-2 py-0.5 text-xs text-white/70 hover:bg-white/10"
						onclick={close}
					>
						Close <kbd class="font-mono">Esc</kbd>
					</button>
				</div>
			</header>
			<p class="mb-2 text-xs text-white/50">
				Click a card to take it into your hand; Shift+click lays it face-up on the table. The table
				sees that you searched, not what you took.
			</p>
			<input
				data-testid="deck-search-filter"
				class="mb-2 rounded border border-white/20 bg-black/30 px-2 py-1 text-xs text-white"
				placeholder="Filter by name"
				bind:value={filter}
				oninput={() => (page = 0)}
			/>
			<div class="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2 overflow-auto">
				{#each view.cards as card (card.id)}
					<button
						data-deck-card={card.id}
						title={card.name ?? ''}
						class="flex flex-col items-center gap-1 rounded border border-transparent p-1 hover:border-amber-300"
						onclick={(event) => takeSearchedCard(card.id, event.shiftKey ? 'table' : 'hand')}
					>
						<img
							src={resolveCardImage(card.faceImageUrl, $sheetRefCache) || undefined}
							alt={card.name ?? 'card'}
							class="aspect-[5/7] w-full rounded bg-neutral-700 object-cover"
							class:rotate-90={card.orientation === 'landscape'}
							loading="lazy"
							decoding="async"
						/>
						<span class="w-full truncate text-center text-[10px] text-white/70">
							{card.name ?? ''}
						</span>
					</button>
				{:else}
					<p class="col-span-full py-6 text-center text-xs text-white/50">
						{view.total ? 'No card matches' : 'The deck is empty'}
					</p>
				{/each}
			</div>
			{#if view.pages > 1}
				<footer class="mt-2 flex items-center justify-center gap-3 text-xs">
					<button
						data-testid="deck-search-prev"
						class="rounded border border-white/20 px-2 py-0.5 disabled:opacity-30"
						disabled={view.page === 0}
						onclick={() => (page = view.page - 1)}>Prev</button
					>
					<span>{view.page + 1} / {view.pages}</span>
					<button
						data-testid="deck-search-next"
						class="rounded border border-white/20 px-2 py-0.5 disabled:opacity-30"
						disabled={view.page >= view.pages - 1}
						onclick={() => (page = view.page + 1)}>Next</button
					>
				</footer>
			{/if}
		</div>
	</div>
{/if}
