import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';
import { dragStore } from '../dragStore.svelte';
import { CARD_REST_Y, CARD_THICKNESS } from '$lib/utils/constants-cards';
import { resolveDrop } from '$lib/utils/transforms/drop';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';

const ME = 'seat0';
const DECK = `deck:${ME}:0`;

const inDeck = (id: string) => ({
	id,
	faceImageUrl: `${id}.png`,
	backImageUrl: 'back.png'
});

/** a facedown 4-card deck at the table centre — top of the pile is `d` */
function seed(isFaceUp = false) {
	gameStore.set({
		players: { [ME]: { id: ME, seat: 0 } },
		decks: {
			[DECK]: {
				id: DECK,
				isFaceUp,
				position: [0, 0.4, 0] as [number, number, number],
				rotation: [0, 0, 0] as [number, number, number],
				cards: [inDeck('a'), inDeck('b'), inDeck('c'), inDeck('d')]
			}
		},
		cards: {}
	});
}

beforeEach(() => {
	localStorage.setItem('myPlayerId', ME);
	dragStore.set({
		isDragging: null,
		isHovered: null,
		isDeckHovered: null,
		isTrayHovered: false
	});
	seed();
});

describe('drawFromTop with a count', () => {
	it('draws N off the top in draw order and shrinks the deck in the same patch', () => {
		const drawn = gameActions.drawFromTop(DECK, 3);
		expect(drawn.map((c) => c.id)).toEqual(['d', 'c', 'b']); // facedown: top = last
		const state = get(gameStore);
		expect(state.decks?.[DECK]?.cards?.map((c) => c.id)).toEqual(['a']);
		expect(Object.keys(state.cards ?? {}).sort()).toEqual(['b', 'c', 'd']);
	});

	it('fans the landings instead of stacking one Y-tower', () => {
		gameActions.drawFromTop(DECK, 3);
		const cards = get(gameStore).cards ?? {};
		const positions = ['d', 'c', 'b'].map((id) => cards[id]?.position ?? [0, 0, 0]);
		// each card lands further down-screen (+Z for seat 0) than the last…
		expect(positions[1][2]).toBeGreaterThan(positions[0][2]);
		expect(positions[2][2]).toBeGreaterThan(positions[1][2]);
		// …and one thickness higher, so overlaps never share a plane
		expect(positions[0][1]).toBe(CARD_REST_Y);
		expect(positions[1][1]).toBeCloseTo(CARD_REST_Y + CARD_THICKNESS);
		expect(positions[2][1]).toBeCloseTo(CARD_REST_Y + 2 * CARD_THICKNESS);
	});

	it('keeps the drawn cards facedown from a facedown deck', () => {
		gameActions.drawFromTop(DECK, 1);
		expect(get(gameStore).cards?.d?.rotation?.[0]).toBe(180);
	});

	it('clamps the count to what the deck holds', () => {
		const drawn = gameActions.drawFromTop(DECK, 9);
		expect(drawn).toHaveLength(4);
		expect(get(gameStore).decks?.[DECK]?.cards).toEqual([]);
	});

	it('returns [] from an empty deck', () => {
		gameStore.updateState({ decks: { [DECK]: { cards: [] } } });
		expect(gameActions.drawFromTop(DECK, 2)).toEqual([]);
	});
});

describe('flipDeck', () => {
	it('toggles isFaceUp, so the former bottom card draws first', () => {
		expect(gameActions.drawFromTop(DECK)[0]?.id).toBe('d'); // facedown top
		gameActions.flipDeck(DECK);
		expect(get(gameStore).decks?.[DECK]?.isFaceUp).toBe(true);
		// physical flip: the old bottom is the new visually-top card
		expect(gameActions.drawFromTop(DECK)[0]?.id).toBe('a');
	});

	it('flips back again', () => {
		gameActions.flipDeck(DECK);
		gameActions.flipDeck(DECK);
		expect(get(gameStore).decks?.[DECK]?.isFaceUp).toBe(false);
		expect(gameActions.drawFromTop(DECK)[0]?.id).toBe('d');
	});

	it('falls back to the hovered deck', () => {
		dragStore.update((s) => ({ ...s, isDeckHovered: DECK }));
		expect(gameActions.flipDeck()).toBe(DECK);
		expect(get(gameStore).decks?.[DECK]?.isFaceUp).toBe(true);
	});

	it('does nothing with no target', () => {
		expect(gameActions.flipDeck()).toBeUndefined();
		expect(get(gameStore).decks?.[DECK]?.isFaceUp).toBe(false);
	});
});

describe('shuffleDeck', () => {
	it('stamps shuffledAt so clients have a change to wiggle on', () => {
		expect(get(gameStore).decks?.[DECK]?.shuffledAt).toBeUndefined();
		gameActions.shuffleDeck(DECK);
		const deck = get(gameStore).decks?.[DECK];
		expect(typeof deck?.shuffledAt).toBe('number');
		// same cards, whatever the order
		expect(deck?.cards?.map((c) => c.id).sort()).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('resolveDrop for a dragged deck', () => {
	it('settles on the felt at half the deck body height, ignoring deck/tray hover', () => {
		const drop = resolveDrop(
			get(gameStore),
			DECK,
			{ x: 3, z: 2 },
			// a dragged deck hovers itself; the tray must not swallow the pile
			{ deckId: DECK, tray: true }
		);
		expect(drop?.kind).toBe('table');
		expect(drop?.position[0]).toBe(3);
		expect(drop?.position[2]).toBe(2);
		expect(drop?.position[1]).toBeGreaterThan(TABLE_TOP_Y);
		expect(drop?.position[1]).toBeLessThan(1);
	});
});
