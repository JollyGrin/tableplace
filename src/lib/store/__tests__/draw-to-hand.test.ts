import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';

const ME = 'p-me';
const OTHER = 'p-other';
const MINE = `deck:${ME}:0`;
const THEIRS = `deck:${OTHER}:0`;
// no player in the lobby owns it: a shared pile, or an unclaimed seat
const SHARED = 'deck:seat3:0';

const inDeck = (id: string) => ({
	id,
	faceImageUrl: `${id}.png`,
	backImageUrl: 'back.png',
	name: id.toUpperCase()
});

function deck(id: string, isFaceUp = false) {
	return {
		id,
		isFaceUp,
		position: [0, 0.4, 0] as [number, number, number],
		rotation: [0, 0, 0] as [number, number, number],
		cards: ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => inDeck(`${id}/${c}`))
	};
}

function seed(isFaceUp = false) {
	gameStore.set({
		players: {
			[ME]: { id: ME, seat: 0, tray: {} },
			[OTHER]: { id: OTHER, seat: 1, tray: {} }
		},
		decks: {
			[MINE]: deck(MINE, isFaceUp),
			[THEIRS]: deck(THEIRS),
			[SHARED]: deck(SHARED)
		},
		cards: {}
	} as never);
}

const hand = () => Object.keys(get(gameStore).players?.[ME]?.tray ?? {});
const deckIds = (id: string) => get(gameStore).decks?.[id]?.cards?.map((c) => c.id) ?? [];

beforeEach(() => {
	localStorage.setItem('myPlayerId', ME);
	seed();
});
afterEach(() => vi.restoreAllMocks());

describe('drawToHand', () => {
	it('moves the top card into the hand and off the deck', () => {
		const result = gameActions.drawToHand(MINE);
		expect(result).toEqual({ ok: true, deckId: MINE, cardIds: [`${MINE}/f`] });
		expect(hand()).toEqual([`${MINE}/f`]);
		expect(deckIds(MINE)).toHaveLength(5);
		expect(Object.keys(get(gameStore).cards ?? {})).toEqual([]); // nothing on the felt
		const card = get(gameStore).players?.[ME]?.tray?.[`${MINE}/f`];
		expect(card).toMatchObject({ faceImageUrl: `${MINE}/f.png`, name: `${MINE}/F`.toUpperCase() });
		expect(card).not.toHaveProperty('position');
	});

	it('draws N in draw order with ONE patch — the wire budget holds at any count', () => {
		const update = vi.spyOn(gameStore, 'updateState');
		gameActions.drawToHand(MINE, 5);
		expect(update).toHaveBeenCalledTimes(1);
		const patch = update.mock.calls[0]![0] as never as Record<string, Record<string, unknown>>;
		// no position anywhere: the wrapper sends it at once, not through the drag throttle
		expect(JSON.stringify(patch)).not.toContain('position');
		expect(hand()).toEqual(['f', 'e', 'd', 'c', 'b'].map((c) => `${MINE}/${c}`));
		expect(deckIds(MINE)).toEqual([`${MINE}/a`]);
	});

	it('takes from the front of a face-up pile', () => {
		seed(true);
		gameActions.drawToHand(MINE, 2);
		expect(hand()).toEqual([`${MINE}/a`, `${MINE}/b`]);
	});

	it('stops at the bottom of the deck, and refuses an empty one', () => {
		gameActions.drawToHand(MINE, 9);
		expect(hand()).toHaveLength(6);
		expect(deckIds(MINE)).toEqual([]);
		expect(gameActions.drawToHand(MINE)).toEqual({ ok: false, reason: 'empty' });
	});

	it("refuses another player's deck and changes nothing", () => {
		const update = vi.spyOn(gameStore, 'updateState');
		expect(gameActions.drawToHand(THEIRS)).toEqual({ ok: false, reason: 'not-yours' });
		expect(update).not.toHaveBeenCalled();
		expect(deckIds(THEIRS)).toHaveLength(6);
	});

	it('deals from a deck no player in the lobby owns', () => {
		expect(gameActions.drawToHand(SHARED).ok).toBe(true);
		expect(hand()).toEqual([`${SHARED}/f`]);
	});

	it('never overwrites a card already in the hand with the same id', () => {
		gameActions.drawToHand(MINE);
		// put the same card back on top and draw it again
		gameStore.updateState({
			decks: { [MINE]: { cards: [...deckIds(MINE).map(inDeck), inDeck(`${MINE}/f`)] } }
		} as never);
		const again = gameActions.drawToHand(MINE);
		expect(again.ok && again.cardIds).toEqual([`${MINE}/f-2`]);
		expect(hand()).toHaveLength(2);
	});
});
