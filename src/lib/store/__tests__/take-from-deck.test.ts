import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';

const ME = 'p-me';
const OTHER = 'p-other';
const MINE = `deck:${ME}:0`;
const THEIRS = `deck:${OTHER}:0`;
const SHARED = 'deck:seat3:0';

function deck(id: string, isFaceUp = false) {
	return {
		id,
		isFaceUp,
		position: [0, 0.4, 0] as [number, number, number],
		rotation: [0, 0, 0] as [number, number, number],
		cards: ['a', 'b', 'c'].map((c) => ({
			id: `${id}/${c}`,
			faceImageUrl: `${c}.png`,
			name: c.toUpperCase()
		}))
	};
}

beforeEach(() => {
	localStorage.setItem('myPlayerId', ME);
	gameStore.set({
		players: {
			[ME]: { id: ME, seat: 0, tray: {} },
			[OTHER]: { id: OTHER, seat: 1, tray: {} }
		},
		decks: { [MINE]: deck(MINE), [THEIRS]: deck(THEIRS), [SHARED]: deck(SHARED) },
		cards: {}
	} as never);
});

const deckIds = (id: string) => get(gameStore).decks?.[id]?.cards?.map((c) => c.id) ?? [];

describe('takeFromDeck', () => {
	it('takes a named card from the middle into the hand in one patch', () => {
		const update = vi.spyOn(gameStore, 'updateState');
		const result = gameActions.takeFromDeck(MINE, `${MINE}/b`);
		expect(result).toEqual({ ok: true, deckId: MINE, cardId: `${MINE}/b` });
		expect(update).toHaveBeenCalledTimes(1);
		expect(deckIds(MINE)).toEqual([`${MINE}/a`, `${MINE}/c`]);
		expect(get(gameStore).players?.[ME]?.tray?.[`${MINE}/b`]).toMatchObject({ name: 'B' });
		update.mockRestore();
	});

	it('Shift lays it face-up on the felt', () => {
		gameActions.takeFromDeck(SHARED, `${SHARED}/c`, 'table');
		const card = get(gameStore).cards?.[`${SHARED}/c`];
		expect(card?.rotation?.[0]).toBe(0);
		expect(card?.position).toBeDefined();
		expect(deckIds(SHARED)).toHaveLength(2);
	});

	it("refuses another player's deck and a card that isn't there", () => {
		expect(gameActions.takeFromDeck(THEIRS, `${THEIRS}/a`)).toMatchObject({ reason: 'not-yours' });
		expect(gameActions.takeFromDeck(MINE, 'nope')).toMatchObject({ reason: 'no-card' });
		expect(deckIds(MINE)).toHaveLength(3);
	});
});
