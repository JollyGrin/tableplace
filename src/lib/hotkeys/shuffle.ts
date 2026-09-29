import toast from 'svelte-french-toast';
import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameActions } from '$lib/store/game/actions';

/** why someone else's deck refuses — the toast, and the verb's reasonDisabled */
export const SHUFFLE_NOT_MINE = "That deck isn't yours to shuffle";

/**
 * `Shift+S` on a hovered deck: shuffle it.
 *
 * Ownership matches the pane button and `Shift+G`: only your own decks.
 * No deck under the pointer is silent (a toast on every stray keypress is
 * noise); someone else's deck gets told why nothing happened.
 */
export function shuffleHoveredDeck(deckId?: string) {
	const id = deckId ?? get(dragStore).isDeckHovered;
	if (!id) return;
	if (!gameActions.getMyDecks().some(([key]) => key === id)) {
		toast.error(SHUFFLE_NOT_MINE);
		return;
	}
	gameActions.shuffleDeck(id);
	return id;
}
