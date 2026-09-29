import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import type { GameDTO } from '../types';

function moveCardToTray(cardId: string, playerId: string) {
	const card = get(gameStore)?.cards?.[cardId] as NonNullable<
		GameDTO['cards'][string]
	>;
	return gameStore.updateState({
		cards: { [cardId]: null },
		players: { [playerId]: { tray: { [cardId]: card } } }
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
