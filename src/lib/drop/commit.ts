import { get } from 'svelte/store';
import { dragEnd, dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { tableFeatures } from '$lib/store/tableFeatures';
import { resolveDrop } from '$lib/utils/transforms/drop';

/**
 * Ending a drag, in one place.
 *
 * Every release funnels through `commitActiveDrag` — the table mesh's
 * pointerup and the window-level fallback for releases that never reach it
 * (pointer left the canvas, or came up over the HUD). The window listener
 * runs last in the bubble order, so a normal on-table release has already
 * cleared `isDragging` by the time it fires and it no-ops.
 */
export function commitActiveDrag() {
	const {
		isDragging: id,
		intersectionPoint,
		isDeckHovered,
		isTrayHovered,
		noSnap
	} = get(dragStore);
	if (!id) return;

	// resolved by the same pure function the DropIndicator previews with, so
	// what the player saw while dragging is what gets committed — including
	// whether Alt was down (noSnap), which the release writes into the store
	// from the pointer event before calling in, and whether this route has a
	// hand at all. The options must match the indicator's exactly.
	const drop = resolveDrop(
		get(gameStore),
		id,
		intersectionPoint,
		{ deckId: isDeckHovered, tray: isTrayHovered },
		{ noSnap, hand: get(tableFeatures).hand }
	);

	if (drop?.kind === 'tray') {
		gameActions.moveCardToTray(id, gameActions?.getMe()?.id as string);
	} else if (drop?.kind === 'deck' && drop.targetId) {
		gameActions.placeOnTopOfDeck(drop.targetId, id);
	} else if (drop && id.startsWith('piece:')) {
		gameStore.updateState({ pieces: { [id]: { position: drop.position } } });
	} else if (drop && id.startsWith('deck:')) {
		gameStore.updateState({ decks: { [id]: { position: drop.position } } });
	} else if (drop) {
		gameStore.updateState({ cards: { [id]: { position: drop.position } } });
	}

	dragEnd();
}

/**
 * Esc mid-drag: put the entity back where it was picked up and drop the drag.
 * Without a recorded origin (a card drawn out of a deck or tray never had a
 * table position) the next best thing is to let it settle where it floats,
 * which at least never leaves it stuck in the air.
 */
export function cancelActiveDrag() {
	const { isDragging: id, origin } = get(dragStore);
	if (!id) return;

	if (!origin) {
		// settle in place: resolve against the entity's own XZ, not the pointer
		commitActiveDragAtRest(id);
		return;
	}

	if (id.startsWith('piece:')) gameStore.updateState({ pieces: { [id]: { position: origin } } });
	else if (id.startsWith('deck:')) gameStore.updateState({ decks: { [id]: { position: origin } } });
	else gameStore.updateState({ cards: { [id]: { position: origin } } });

	dragEnd();
}

function commitActiveDragAtRest(id: string) {
	const drop = resolveDrop(get(gameStore), id, null);
	if (drop && id.startsWith('piece:'))
		gameStore.updateState({ pieces: { [id]: { position: drop.position } } });
	else if (drop && id.startsWith('deck:'))
		gameStore.updateState({ decks: { [id]: { position: drop.position } } });
	else if (drop) gameStore.updateState({ cards: { [id]: { position: drop.position } } });
	dragEnd();
}
