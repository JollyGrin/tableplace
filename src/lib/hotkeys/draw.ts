import toast from 'svelte-french-toast';
import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { deckHeightForCount } from '$lib/utils/constants-cards';
import { launchFlights } from '$lib/HUDTray/drawFlight';

/**
 * Draw into your hand — a deck click, number keys 1-9, the wheel's "Draw to
 * hand". Shared so the refusal wording is written once and the wheel can
 * never become a more permissive way to take someone's cards.
 *
 * On success the drawn cards are queued to fly from the deck to their slots
 * in the hand (see HUDTray/drawFlight). Nothing under the pointer is silent;
 * another player's deck says why nothing happened.
 */
export function drawHoveredDeckToHand(deckId?: string, count = 1) {
	const id = deckId ?? get(dragStore).isDeckHovered;
	if (!id) return;

	// read before the draw shrinks it: the flight leaves from the old top
	const deck = get(gameStore)?.decks?.[id];
	const result = gameActions.drawToHand(id, count);
	if (!result.ok) {
		if (result.reason === 'not-yours') toast.error("That deck isn't yours to draw from");
		else if (result.reason === 'empty') toast.error('That deck is empty');
		return result;
	}

	const [x = 0, y = 0, z = 0] = deck?.position ?? [];
	// the deck body is centred on its origin: the top face is half its height up
	launchFlights(result.cardIds, [x, y + deckHeightForCount(deck?.cards?.length ?? 0) / 2, z]);
	return result;
}
