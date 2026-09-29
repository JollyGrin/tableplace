import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { lastMoved } from '../lastMoved';
import { gameStore } from '../game/gameStore.svelte';

describe('lastMoved', () => {
	beforeEach(() => lastMoved.set(null));

	it('records the last entity a local patch moved', () => {
		gameStore.updateState({ pieces: { 'piece:p1:a': { position: [1, 0, 1] } } } as never);
		expect(get(lastMoved)).toEqual({ kind: 'piece', id: 'piece:p1:a' });
		gameStore.updateState({ cards: { 'card:p1:x': { position: [2, 0, 2] } } } as never);
		expect(get(lastMoved)).toEqual({ kind: 'card', id: 'card:p1:x' });
	});

	it('ignores patches that move nothing, deletions, and peers', () => {
		gameStore.updateState({ decks: { 'deck:p1:0': { position: [0, 0, 0] } } } as never);
		gameStore.updateState({ cards: { 'card:p1:x': { isFlipped: true } } } as never);
		gameStore.updateState({ cards: { 'card:p1:y': null } } as never);
		// a peer's patch arrives on the silent path
		gameStore.updateStateSilently({ pieces: { 'piece:p2:b': { position: [5, 0, 5] } } } as never);
		expect(get(lastMoved)).toEqual({ kind: 'deck', id: 'deck:p1:0' });
	});
});
