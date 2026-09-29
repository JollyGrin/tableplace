import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import type { GameDTO } from '../types';

function moveCardToTray(cardId: string, playerId: string) {
	const card = get(gameStore)?.cards?.[cardId] as NonNullable<GameDTO['cards'][string]>;
	// in a hand the card is the holder's to read — a peek mark means nothing
	// there, and must not ride back out onto the table with it
	const held = { ...card };
	delete held.placedBy;
	return gameStore.updateState({
		cards: { [cardId]: null },
		players: { [playerId]: { tray: { [cardId]: held } } }
	});
}

function moveCardOutOfTray(cardId: string, playerId: string) {
	const card = get(gameStore)?.players?.[playerId]?.tray?.[cardId];
	gameStore.updateState({
		players: { [playerId]: { tray: { [cardId]: null } } }
	});
	return card; // returns card to hoist into cards for dragging
}

export const trayActions = {
	moveCardToTray,
	moveCardOutOfTray
};
