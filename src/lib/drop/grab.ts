/**
 * Picking something up with no button held — the "carry it" half of the drag
 * pipeline, whose other half is `commitActiveDrag`.
 *
 * A press-and-hold drag cannot move a deck any more: since tableplace-161 the
 * deck's long press belongs to its wheel, and "Move pile" is a wedge on it.
 * That wedge fires on the release that chose it, so there is no button left to
 * hold — the pile has to follow the pointer on its own and land on the next
 * click.
 *
 * Nothing new is invented for that. `dragStart` is what makes an entity follow
 * the pointer (TableScene streams whatever `isDragging` names to the table
 * point on every pointer event, buttons or no buttons), the next release goes
 * through the same `commitActiveDrag` every drop does — snapping, deck
 * stacking, surface rest and all — and Escape still runs `cancelActiveDrag`,
 * which puts the pile back where the origin below says it was. One use, then
 * it is an ordinary settled entity again.
 */

import { get } from 'svelte/store';
import { dragStart } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
import { toastLocked } from '$lib/hotkeys/lock';
import { heldByOther } from '$lib/store/hold';
import { toastHeld } from '$lib/hotkeys/held';

/**
 * Lift `deckId` into a button-free carry.
 *
 * Deferred by a tick on purpose: the wedge that calls this fires from a
 * pointerup, and the window-level release fallback (`commitActiveDrag`, bound
 * in TableScene) is listening for that same event. Starting the carry inside
 * that dispatch would race the two — a drop committed the instant it began.
 * Returns the timer so a caller (a test, an unmounting route) can drop it.
 */
export function grabDeck(deckId: string): ReturnType<typeof setTimeout> | null {
	const deck = get(gameStore)?.decks?.[deckId];
	if (!deck) return null;
	// a pinned pile stays put — say so rather than silently not lifting
	if (deck.locked) {
		toastLocked();
		return null;
	}
	// in another player's hand: theirs until they put it down (tableplace-199)
	const holder = heldByOther(get(gameStore), deckId);
	if (holder) {
		toastHeld(holder);
		return null;
	}
	// the pre-lift position, so Esc returns the pile to where it was standing
	const origin = deck.position as [number, number, number] | undefined;
	return setTimeout(() => {
		// still there? the wheel can outlive the deck it was opened on
		if (!get(gameStore)?.decks?.[deckId]) return;
		dragStart(deckId, CARD_DRAG_Y, origin);
	}, 0);
}
