import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';
import { dragStore } from '../dragStore.svelte';
import { UNGROUP_MAX_CARDS } from '../game/actions/deck';
import { CARD_REST_Y, CARD_THICKNESS } from '$lib/utils/constants-cards';

const ME = 'seat0';

const card = (x: number, y: number, z: number, faceUp = false) => ({
	position: [x, y, z] as [number, number, number],
	rotation: [faceUp ? 0 : 180, 0, 0] as [number, number, number],
	faceImageUrl: `${x}-${y}.png`,
	backImageUrl: 'back.png'
});

/** three cards dropped roughly on each other, bottom → top */
function pile(faceUp = false) {
	gameStore.set({
		players: { [ME]: { id: ME, seat: 0 } },
		decks: {},
		cards: {
			middle: card(0.1, CARD_REST_Y + CARD_THICKNESS, 0.1, faceUp),
			top: card(0.2, CARD_REST_Y + 2 * CARD_THICKNESS, 0.2, faceUp),
			bottom: card(0, CARD_REST_Y, 0, faceUp),
			elsewhere: card(9, CARD_REST_Y, 9, faceUp)
		}
	});
}

describe('groupStackIntoDeck', () => {
	beforeEach(() => {
		localStorage.setItem('myPlayerId', ME);
		dragStore.set({
			isDragging: null,
			isHovered: null,
			isDeckHovered: null,
			isTrayHovered: false
		});
		pile();
	});

	it('turns the hovered pile into one deck and deletes the loose cards', () => {
		dragStore.update((s) => ({ ...s, isHovered: 'top' }));
		const deckId = gameActions.groupStackIntoDeck();
		const state = get(gameStore);

		expect(deckId).toBe(`deck:${ME}:0`);
		expect(state.decks?.[deckId as string]?.cards).toHaveLength(3);
		// only the pile is consumed — the card across the table is untouched
		expect(Object.keys(state.cards ?? {})).toEqual(['elsewhere']);
	});

	it('keeps the visual top card on top: drawing returns it first', () => {
		const deckId = gameActions.groupStackIntoDeck('middle') as string;
		expect(gameActions.drawFromTop(deckId)[0]?.id).toBe('top');
		expect(gameActions.drawFromTop(deckId)[0]?.id).toBe('middle');
		expect(gameActions.drawFromTop(deckId)[0]?.id).toBe('bottom');
	});

	it('lands the deck at the base card XZ', () => {
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		const [x, , z] = get(gameStore).decks?.[deckId]?.position ?? [];
		expect([x, z]).toEqual([0, 0]);
	});

	it('makes a face-up pile a face-up deck, drawing the top card first', () => {
		pile(true);
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		const deck = get(gameStore).decks?.[deckId];
		expect(deck?.isFaceUp).toBe(true);
		expect(deck?.cards?.[0].id).toBe('top'); // face-up convention: top is first
		expect(gameActions.drawFromTop(deckId)[0]?.id).toBe('top');
	});

	it('groups a lone card into a 1-card deck', () => {
		const deckId = gameActions.groupStackIntoDeck('elsewhere') as string;
		expect(get(gameStore).decks?.[deckId]?.cards).toHaveLength(1);
		expect(get(gameStore).cards?.elsewhere).toBeUndefined();
	});

	it('does nothing while a card is being held', () => {
		dragStore.update((s) => ({ ...s, isDragging: 'top', isHovered: 'top' }));
		expect(gameActions.groupStackIntoDeck()).toBeUndefined();
		expect(get(gameStore).decks).toEqual({});
	});

	it('does nothing when nothing is hovered', () => {
		expect(gameActions.groupStackIntoDeck()).toBeUndefined();
		expect(get(gameStore).decks).toEqual({});
	});

	it('never reuses a live deck id', () => {
		const first = gameActions.groupStackIntoDeck('elsewhere') as string;
		pile();
		gameStore.updateState({ decks: { [first]: { id: first, cards: [] } } });
		const second = gameActions.groupStackIntoDeck('top') as string;
		expect(second).not.toBe(first);
	});
});

describe('ungroupDeck', () => {
	beforeEach(() => {
		localStorage.setItem('myPlayerId', ME);
		dragStore.set({
			isDragging: null,
			isHovered: null,
			isDeckHovered: null,
			isTrayHovered: false
		});
		pile();
	});

	/** ids of the spread-out pile, bottom → top by resting height */
	function looseBottomToTop() {
		return Object.entries(get(gameStore).cards ?? {})
			.filter(([id]) => id !== 'elsewhere') // the card across the table, never part of the pile
			.sort(([, a], [, b]) => (a?.position?.[1] ?? 0) - (b?.position?.[1] ?? 0))
			.map(([id]) => id);
	}

	it('spreads the hovered deck back into loose cards at its XZ', () => {
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		dragStore.update((s) => ({ ...s, isDeckHovered: deckId }));

		const result = gameActions.ungroupDeck();
		const state = get(gameStore);

		expect(result).toMatchObject({ ok: true, deckId });
		// deck gone and cards back in ONE patch — never both at once
		expect(state.decks?.[deckId]).toBeUndefined();
		expect(looseBottomToTop()).toEqual(['bottom', 'middle', 'top']);
		// stacked at the deck's XZ, one thickness apart, bottom card on the felt
		expect(state.cards?.bottom?.position).toEqual([0, CARD_REST_Y, 0]);
		expect(state.cards?.middle?.position).toEqual([0, CARD_REST_Y + CARD_THICKNESS, 0]);
		expect(state.cards?.top?.position).toEqual([0, CARD_REST_Y + 2 * CARD_THICKNESS, 0]);
	});

	it('round-trips losslessly: G → Shift+G → G gives the same deck', () => {
		const firstId = gameActions.groupStackIntoDeck('top') as string;
		const first = structuredClone(get(gameStore).decks?.[firstId]);

		expect(gameActions.ungroupDeck(firstId).ok).toBe(true);
		const secondId = gameActions.groupStackIntoDeck('top') as string;
		const second = get(gameStore).decks?.[secondId];

		expect(second?.cards).toEqual(first?.cards);
		expect(second?.isFaceUp).toBe(first?.isFaceUp);
		expect(second?.position).toEqual(first?.position);
		expect(second?.rotation).toEqual(first?.rotation);
	});

	it('round-trips a face-up pile too, keeping the top card drawable first', () => {
		pile(true);
		const firstId = gameActions.groupStackIntoDeck('top') as string;
		const first = structuredClone(get(gameStore).decks?.[firstId]);
		expect(first?.isFaceUp).toBe(true);

		gameActions.ungroupDeck(firstId);
		// face-up deck spreads to face-up cards
		expect(get(gameStore).cards?.top?.rotation?.[0]).toBe(0);
		expect(looseBottomToTop()).toEqual(['bottom', 'middle', 'top']);

		const secondId = gameActions.groupStackIntoDeck('top') as string;
		const second = get(gameStore).decks?.[secondId];
		expect(second?.cards).toEqual(first?.cards);
		expect(gameActions.drawFromTop(secondId)[0]?.id).toBe('top');
	});

	it('spreads a facedown deck to facedown cards', () => {
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		gameActions.ungroupDeck(deckId);
		expect(get(gameStore).cards?.top?.rotation?.[0]).toBe(180);
	});

	it('allocates a fresh id when the deck card id is already on the table', () => {
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		// a card with the same id turns up on the table (drawn copy, re-spawned pack)
		gameStore.updateState({ cards: { top: card(5, CARD_REST_Y, 5) } });

		const result = gameActions.ungroupDeck(deckId);
		expect(result.ok).toBe(true);
		expect(result.ok && result.cardIds).toContain('top-2');
		// the pre-existing card is left where it was
		expect(get(gameStore).cards?.top?.position).toEqual([5, CARD_REST_Y, 5]);
	});

	it('refuses a deck that is not mine', () => {
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		const deck = get(gameStore).decks?.[deckId];
		gameStore.updateState({
			decks: { [deckId]: null, 'deck:someone-else:0': { ...deck, id: 'deck:someone-else:0' } }
		});
		expect(gameActions.ungroupDeck('deck:someone-else:0')).toEqual({
			ok: false,
			reason: 'not-mine'
		});
	});

	it('refuses an empty deck instead of deleting it', () => {
		const deckId = gameActions.addDeck({ cards: [] } as never) as string;
		expect(gameActions.ungroupDeck(deckId)).toEqual({ ok: false, reason: 'empty' });
		expect(get(gameStore).decks?.[deckId]).toBeDefined();
	});

	it('refuses to carpet the table above the card cap', () => {
		const cards = Array.from({ length: UNGROUP_MAX_CARDS + 1 }, (_, i) => ({
			id: `bulk-${i}`,
			faceImageUrl: 'f.png'
		}));
		const deckId = gameActions.addDeck({ cards } as never) as string;
		expect(gameActions.ungroupDeck(deckId)).toEqual({
			ok: false,
			reason: 'too-many',
			count: UNGROUP_MAX_CARDS + 1
		});
		expect(get(gameStore).decks?.[deckId]?.cards).toHaveLength(UNGROUP_MAX_CARDS + 1);
	});

	it('does nothing when no deck is hovered', () => {
		expect(gameActions.ungroupDeck()).toEqual({ ok: false, reason: 'no-deck' });
	});

	it('keeps the tap angle across a round trip', () => {
		gameStore.updateState({
			cards: {
				bottom: { rotation: [180, 0, 90] },
				middle: { rotation: [180, 0, 90] },
				top: { rotation: [180, 0, 90] }
			}
		});
		const deckId = gameActions.groupStackIntoDeck('top') as string;
		gameActions.ungroupDeck(deckId);
		expect(get(gameStore).cards?.top?.rotation).toEqual([180, 0, 90]);
	});
});
