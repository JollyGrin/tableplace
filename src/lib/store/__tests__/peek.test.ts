/**
 * Peek (tableplace-193): a card laid face-down out of a hand remembers who laid
 * it (`placedBy`), so that player's preview can show its face. The mark is a
 * display rule only; what these tests pin is when it goes away — flipped face
 * up, taken into any hand, or swallowed by a pile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';

vi.mock('svelte-french-toast', () => ({
	default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}));

const { gameActions } = await import('$lib/store/game/actions');
const { hintFor } = await import('$lib/hint/hint');

const game = () => get(gameStore)!;
const placed = (x: number) => ({
	position: [x, 0.26, 0] as [number, number, number],
	rotation: [180, 0, 0] as [number, number, number],
	faceImageUrl: 'https://x/face.png',
	name: 'Placed',
	placedBy: 'p1'
});

beforeEach(() => {
	gameStore.set({
		players: {
			p1: { id: 'p1', seat: 0, joinTimestamp: 0, tray: {}, metadata: {} },
			p2: { id: 'p2', seat: 1, joinTimestamp: 0, tray: {}, metadata: {} }
		},
		cards: { 'card:p1:a': placed(0) },
		decks: {
			'deck:p2:0': {
				id: 'deck:p2:0',
				position: [5, 0.4, 5],
				rotation: [0, 0, 0],
				cards: [{ id: 'c0', faceImageUrl: '' }]
			}
		}
	} as never);
});

describe('placedBy is cleared', () => {
	it('when the card is flipped face up — and not before', () => {
		gameActions.flipCard('card:p1:a');
		expect(game().cards?.['card:p1:a']).not.toHaveProperty('placedBy');
		// flipping it back down on the table is not a play from a hand
		gameActions.flipCard('card:p1:a');
		expect(game().cards?.['card:p1:a']?.rotation?.[0]).toBe(180);
		expect(game().cards?.['card:p1:a']).not.toHaveProperty('placedBy');
	});

	it('when another player takes it into their hand, and it stays gone when played again', () => {
		gameActions.moveCardToTray('card:p1:a', 'p2');
		const held = game().players?.p2?.tray?.['card:p1:a'];
		expect(held).toMatchObject({ faceImageUrl: 'https://x/face.png' });
		expect(held).not.toHaveProperty('placedBy');
	});

	it('when it goes onto a pile', () => {
		gameActions.placeOnTopOfDeck('deck:p2:0', 'card:p1:a');
		const top = game().decks?.['deck:p2:0']?.cards?.at(-1);
		expect(top?.id).toBe('card:p1:a');
		expect(top).not.toHaveProperty('placedBy');
	});
});

describe('the hint bar follows the preview', () => {
	it('names the card to its placer only', () => {
		const hint = (playerId: string) =>
			hintFor({
				game: game(),
				actor: { playerId },
				targets: [{ kind: 'card', id: 'card:p1:a' }, { kind: 'table' }],
				dragging: null,
				dropKind: null
			});
		expect(hint('p1').name).toBe('Placed');
		expect(hint('p2').name).not.toContain('Placed');
	});
});

describe('scenarios', () => {
	it("keep a seat's mark, drop a real player's, and hand the seat's to whoever claims it", async () => {
		const { saveScenario, claimSeat, ensureSeatPlaceholder } = await import(
			'$lib/scenario/scenario'
		);
		localStorage.clear();
		gameStore.set({
			players: {},
			cards: {
				'card:p1:a': placed(0),
				'card:seat0:b': { ...placed(1), placedBy: 'seat0' },
				// a seat-0 play lying on someone else's side still follows the seat
				'card:seat1:c': { ...placed(2), placedBy: 'seat0' }
			}
		} as never);
		ensureSeatPlaceholder(0);

		const saved = saveScenario('peek').state?.cards ?? {};
		expect(saved['card:p1:a']).not.toHaveProperty('placedBy');
		expect(saved['card:seat0:b']?.placedBy).toBe('seat0');

		localStorage.setItem('myPlayerId', 'joiner');
		expect(claimSeat(0)).toBe(true);
		expect(game().cards?.['card:joiner:b']?.placedBy).toBe('joiner');
		expect(game().cards?.['card:seat1:c']?.placedBy).toBe('joiner');
		expect(game().cards).not.toHaveProperty('card:seat0:b');
	});
});
