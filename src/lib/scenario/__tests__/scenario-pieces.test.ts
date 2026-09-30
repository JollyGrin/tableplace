/**
 * Hand-spawned pieces have to survive the whole scenario pipeline:
 * /setup spawn → save → load → export/import → seed a lobby → claim the seat.
 * The last step is why addPiece follows the `kind:owner:slug` id convention.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import {
	applyScenario,
	claimSeat,
	ensureSeatPlaceholder,
	getScenario,
	importScenarioFromText,
	saveScenario,
	seatPlaceholderId
} from '../scenario';

function buildSeatZeroTable() {
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	ensureSeatPlaceholder(0);
	const owner = seatPlaceholderId(0);
	return {
		token: gameActions.addPiece('token', {
			ownerId: owner,
			name: 'Objective',
			imageUrl: 'https://example.com/objective.png'
		}),
		counter: gameActions.addPiece('counter', { ownerId: owner, name: 'HP', maxValue: 25 })
	};
}

describe('scenario round-trip with hand-spawned pieces', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('saves and reloads pieces', () => {
		const { token, counter } = buildSeatZeroTable();
		const before = get(gameStore).pieces;
		saveScenario('pieces-test');

		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		applyScenario(getScenario('pieces-test')!);

		const after = get(gameStore).pieces ?? {};
		expect(after).toEqual(before);
		expect(after[token]).toMatchObject({ imageUrl: 'https://example.com/objective.png' });
		expect(after[counter]).toMatchObject({ value: 25, maxValue: 25 });
	});

	it('keeps a counter minimum through save + load, and through the file', () => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		ensureSeatPlaceholder(0);
		const dial = gameActions.addPiece('counter', {
			ownerId: seatPlaceholderId(0),
			name: 'Dial',
			minValue: 3,
			maxValue: 17
		});
		gameActions.incrementCounter(dial, -100);
		const saved = saveScenario('minimum-test');

		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		applyScenario(getScenario('minimum-test')!);
		expect(get(gameStore).pieces?.[dial]).toMatchObject({ value: 3, minValue: 3, maxValue: 17 });
		// and the reloaded counter still stops at its floor
		gameActions.incrementCounter(dial, -1);
		expect(get(gameStore).pieces?.[dial]?.value).toBe(3);

		const reimported = importScenarioFromText(JSON.stringify(saved, null, '\t'));
		expect(reimported.state.pieces?.[dial]).toMatchObject({ value: 3, minValue: 3, maxValue: 17 });
	});

	it('keeps a square token square through save + load, the file, and a bag (tableplace-254)', () => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		ensureSeatPlaceholder(0);
		const owner = seatPlaceholderId(0);
		const plaque = gameActions.addPiece('token', {
			ownerId: owner,
			name: 'Plaque',
			imageUrl: 'https://example.com/plaque.png',
			shape: 'square',
			radius: 1
		});
		const chip = gameActions.addPiece('token', { ownerId: owner, name: 'Chip' });
		const bag = gameActions.addPiece('bag', {
			ownerId: owner,
			name: 'Pool',
			drawMode: 'lifo',
			contents: [
				{ kind: 'token', name: 'Marker' },
				{ kind: 'token', name: 'Tile', shape: 'square', imageUrl: 'https://example.com/tile.png' }
			]
		});
		// a disc carries no field at all — absent is what "disc" is on the wire
		expect(get(gameStore).pieces?.[chip]).not.toHaveProperty('shape');
		const saved = saveScenario('shape-test');

		const check = (pieces: NonNullable<ReturnType<typeof get<typeof gameStore>>>['pieces']) => {
			expect(pieces?.[plaque]).toMatchObject({ kind: 'token', shape: 'square', radius: 1 });
			expect(pieces?.[chip]).not.toHaveProperty('shape');
			expect(pieces?.[bag]?.contents).toEqual([
				{ kind: 'token', name: 'Marker' },
				{ kind: 'token', name: 'Tile', shape: 'square', imageUrl: 'https://example.com/tile.png' }
			]);
		};

		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		applyScenario(getScenario('shape-test')!);
		check(get(gameStore).pieces);
		check(importScenarioFromText(JSON.stringify(saved, null, '\t')).state.pieces);

		// and the reloaded bag still hands out a square tile
		const drawn = gameActions.drawFromBag(bag);
		expect(get(gameStore).pieces?.[drawn!.id]).toMatchObject({ name: 'Tile', shape: 'square' });
	});

	it('survives an export/import of the scenario file', () => {
		buildSeatZeroTable();
		const saved = saveScenario('pieces-file');
		// exportScenarioToFile just serializes the scenario
		const reimported = importScenarioFromText(JSON.stringify(saved, null, '\t'));
		expect(reimported.state.pieces).toEqual(saved.state.pieces);
	});

	it('renames piece owners onto the player who claims the seat', () => {
		const { token, counter } = buildSeatZeroTable();
		const spawned = get(gameStore).pieces ?? {};
		saveScenario('pieces-claim');

		// a fresh lobby: my player joins, the preset is seeded, I claim seat 0
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
		localStorage.setItem('myPlayerId', 'player9');
		gameActions.addPlayer('player9');
		applyScenario(getScenario('pieces-claim')!);
		expect(claimSeat(0)).toBe(true);

		const pieces = get(gameStore).pieces ?? {};
		expect(Object.keys(pieces).sort()).toEqual(['piece:player9:hp-0', 'piece:player9:objective-0']);
		// state rides along unchanged; only the owner segment moved
		expect(pieces['piece:player9:objective-0']).toEqual(spawned[token]);
		expect(pieces['piece:player9:hp-0']).toEqual(spawned[counter]);
		expect(get(gameStore).players?.player9?.seat).toBe(0);
	});
});
