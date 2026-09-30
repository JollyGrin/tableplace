/**
 * Deck search (tableplace-196): browse a deck in a drawer and take a card.
 *
 * Which deck the drawer is open on is local, render-only state — never
 * patched into `GameDTO`. The table learns only what the moves themselves
 * say: the deck gets shorter, a hand gets longer, and (unless the searcher
 * opts out) the deck shuffles on close, which every client plays as the
 * shuffle wiggle. Nobody else is told which card was taken.
 */

import toast from 'svelte-french-toast';
import { get, writable } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { deckHeightForCount } from '$lib/utils/constants-cards';
import { launchFlights } from '$lib/HUDTray/drawFlight';

/** why someone else's deck refuses — the toast, and the verb's reasonDisabled */
export const SEARCH_NOT_MINE = "That deck isn't yours to search";

/** the deck the drawer is open on, or null when it is closed */
export const searchingDeck = writable<string | null>(null);

/**
 * `/` on a hovered deck, or the wheel's "Search": open the drawer. Same
 * ownership as a draw into the hand — your own decks and table-scoped ones.
 */
export function openDeckSearch(deckId?: string) {
	const id = deckId ?? get(dragStore).isDeckHovered;
	if (!id || !get(gameStore)?.decks?.[id]) return;
	if (!gameActions.canDrawToHand(id)) {
		toast.error(SEARCH_NOT_MINE);
		return;
	}
	searchingDeck.set(id);
	return id;
}

/**
 * Close the drawer. A face-down deck shuffles on the way out unless the
 * searcher unticked it — the order they just saw is no longer the order. A
 * face-up pile (a discard) has no hidden order to protect and never shuffles.
 */
export function closeDeckSearch(shuffle = true) {
	const id = get(searchingDeck);
	searchingDeck.set(null);
	if (!id || !shuffle) return;
	const deck = get(gameStore)?.decks?.[id];
	if (!deck || deck.isFaceUp || !deck.cards?.length) return;
	gameActions.shuffleDeck(id);
}

/**
 * Take one card from the open deck. `to: 'hand'` flies it into your hand like
 * a draw; `'table'` lays it face-up on the felt in front of the deck.
 */
export function takeSearchedCard(deckCardId: string, to: 'hand' | 'table' = 'hand') {
	const id = get(searchingDeck);
	if (!id) return;
	const deck = get(gameStore)?.decks?.[id];
	const result = gameActions.takeFromDeck(id, deckCardId, to);
	if (!result.ok) {
		if (result.reason === 'not-yours') toast.error(SEARCH_NOT_MINE);
		return result;
	}
	if (to === 'hand') {
		const [x = 0, y = 0, z = 0] = deck?.position ?? [];
		launchFlights([result.cardId], [x, y + deckHeightForCount(deck?.cards?.length ?? 0) / 2, z]);
	}
	return result;
}
