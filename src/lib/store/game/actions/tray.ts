import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import {
	handOrderOf,
	handOrderPatch,
	moveInOrder,
	nextHandOrder,
	validHandPlayFace
} from '$lib/utils/hand';
import type { GameDTO, HandPlayFace } from '../types';

/**
 * Take a table card into `playerId`'s hand — at the right-hand end, or at
 * `index` (where it was dropped on the fan), renumbering the rest in the
 * same patch.
 */
function moveCardToTray(cardId: string, playerId: string, index?: number) {
	const card = get(gameStore)?.cards?.[cardId] as NonNullable<GameDTO['cards'][string]>;
	const tray = get(gameStore)?.players?.[playerId]?.tray;
	// in a hand the card is the holder's to read — a peek mark means nothing
	// there, and must not ride back out onto the table with it
	const held: Partial<GameDTO['cards'][string]> = { ...card, handOrder: nextHandOrder(tray) };
	delete held.placedBy;
	const order = index === undefined ? null : moveInOrder(handOrderOf(tray), cardId, index);
	const renumbered = order ? handOrderPatch({ ...tray, [cardId]: held }, order) : {};
	return gameStore.updateState({
		cards: { [cardId]: null },
		players: {
			[playerId]: {
				tray: {
					...renumbered,
					[cardId]: { ...held, ...renumbered[cardId] }
				}
			}
		}
	} as unknown as Partial<GameDTO>);
}

function moveCardOutOfTray(cardId: string, playerId: string) {
	const card = get(gameStore)?.players?.[playerId]?.tray?.[cardId];
	gameStore.updateState({
		players: { [playerId]: { tray: { [cardId]: null } } }
	});
	if (!card) return card;
	// the hand's sort key means nothing on the table
	const loose = { ...card };
	delete loose.handOrder;
	return loose; // returns card to hoist into cards for dragging
}

/**
 * Move one card of `playerId`'s hand to `index`, left to right (a drag along
 * the fan). One patch of sort keys; nothing is sent when the order stands.
 */
function reorderHand(playerId: string, cardId: string, index: number) {
	const tray = get(gameStore)?.players?.[playerId]?.tray;
	if (!tray?.[cardId]) return;
	const patch = handOrderPatch(tray, moveInOrder(handOrderOf(tray), cardId, index));
	if (!Object.keys(patch).length) return;
	gameStore.updateState({ players: { [playerId]: { tray: patch } } } as Partial<GameDTO>);
}

/** Set (or with null, clear back to face-down) the face a hand play lands on. */
function setHandPlayFace(face: HandPlayFace | null) {
	if (face !== null && validHandPlayFace(face) === undefined) return;
	gameStore.updateState({ table: { handPlayFace: face } } as Parameters<
		typeof gameStore.updateState
	>[0]);
}

export const trayActions = {
	moveCardToTray,
	moveCardOutOfTray,
	reorderHand,
	setHandPlayFace
};
