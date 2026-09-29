/**
 * The selection verbs and the box (tableplace-202): F, Q/E, L and G on every
 * selected entity in one patch, and which entities a box takes in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { clearSelection, selectedIds, setSelection } from '$lib/store/selection';
import { flipPatch, lockSelection, rotatePatch, groupSelection } from '../actions';
import { entitiesInRect, rectBetween } from '../boxSelect';

vi.mock('svelte-french-toast', () => ({ default: vi.fn() }));

const A = 'card:me:a';
const B = 'card:me:b';
const D = 'deck:me:0';
const TOKEN = 'piece:me:t';
const MODEL = 'piece:me:m';
const PINNED = 'card:me:pinned';

function seed() {
	gameStore.set({
		players: { me: { id: 'me', seat: 0 } },
		cards: {
			[A]: { position: [0, 0.26, 0], rotation: [0, 0, 0], faceImageUrl: 'a.png' },
			[B]: {
				position: [5, 0.28, 0],
				rotation: [180, 0, 90],
				faceImageUrl: 'b.png',
				placedBy: 'me'
			},
			[PINNED]: { position: [9, 0.26, 0], rotation: [0, 0, 0], faceImageUrl: 'p', locked: true }
		},
		decks: { [D]: { id: D, position: [-4, 0.5, 0], rotation: [0, 0, 0], cards: [] } },
		pieces: {
			[TOKEN]: { position: [0, 0.335, 4], rotation: [0, 0, 0], kind: 'token' },
			[MODEL]: { position: [3, 0.2, 4], rotation: [0, 350, 0], kind: 'model' }
		}
	} as never);
}

beforeEach(() => {
	clearSelection();
	seed();
	vi.spyOn(gameActions, 'getMe').mockReturnValue({ id: 'me', seat: 0 } as never);
});

describe('F on a selection', () => {
	it('turns every card over and flips every deck, in one patch; pieces have no back', () => {
		expect(flipPatch(get(gameStore), [A, B, D, TOKEN, PINNED])).toEqual({
			cards: {
				[A]: { rotation: [180, 0, 0] },
				// face up is public: the peek mark goes, as a single flip does
				[B]: { rotation: [0, 0, 90], placedBy: null }
			},
			decks: { [D]: { isFaceUp: true } }
		});
	});
});

describe('Q/E on a selection', () => {
	it('E turns each thing clockwise by the rotation step, about its own centre', () => {
		const patch = rotatePatch(get(gameStore), [A, B, D, TOKEN, MODEL], 1);
		expect(patch).toMatchObject({
			cards: { [A]: { rotation: [0, 0, 45] }, [B]: { rotation: [180, 0, 135] } },
			// every piece turns by the step now (tableplace-200), a disc token too
			pieces: { [TOKEN]: { rotation: [0, 45, 0] }, [MODEL]: { rotation: [0, 35, 0] } }
		});
		// a deck's yaw is radians with the opposite sign: clockwise 45° is -45°
		const [, y] = patch!.decks![D]!.rotation!;
		expect(y).toBeCloseTo((360 - 45) * DEG2RAD, 9);
	});

	it("uses the table's step", () => {
		gameStore.updateState({ table: { rotationStep: 90 } });
		expect(rotatePatch(get(gameStore), [A], 1)).toEqual({
			cards: { [A]: { rotation: [0, 0, 90] } }
		});
	});

	it('Q is the same turn the other way', () => {
		expect(rotatePatch(get(gameStore), [A], -1)).toEqual({
			cards: { [A]: { rotation: [0, 0, 315] } }
		});
	});

	it('changes nothing — and sends nothing — when nothing selected can turn', () => {
		expect(rotatePatch(get(gameStore), [PINNED], 1)).toBeNull();
	});
});

describe('L on a selection', () => {
	it('pins every member in one patch and lets go of the selection', () => {
		setSelection([A, D, TOKEN]);
		const update = vi.spyOn(gameStore, 'updateState');
		lockSelection(get(selectedIds));
		expect(update).toHaveBeenCalledTimes(1);
		const state = get(gameStore);
		expect([
			state.cards?.[A]?.locked,
			state.decks?.[D]?.locked,
			state.pieces?.[TOKEN]?.locked
		]).toEqual([true, true, true]);
		expect(get(selectedIds)).toEqual([]);
	});
});

describe('G on a selection', () => {
	it('groups the selected cards, wherever they lie, into one deck at the top card', () => {
		const deckId = gameActions.groupCardsIntoDeck([A, B, TOKEN]);
		const state = get(gameStore);
		expect(deckId).toBeTruthy();
		expect(state.cards?.[A]).toBeFalsy();
		expect(state.cards?.[B]).toBeFalsy();
		// the token is not a card: it stays on the table
		expect(state.pieces?.[TOKEN]).toBeTruthy();
		const deck = state.decks?.[deckId as string];
		expect(deck?.cards?.map((c) => c.id).sort()).toEqual([A, B].sort());
		// B lay higher, so B is the top: the pile lands where B was
		expect(deck?.position?.[0]).toBe(5);
	});

	it('refuses a selection with no loose card, and changes nothing', () => {
		const update = vi.spyOn(gameStore, 'updateState');
		groupSelection([D, TOKEN]);
		expect(update).not.toHaveBeenCalled();
	});
});

describe('the box', () => {
	// a flat projection: world x/z straight onto screen x/y, 10 px a unit
	const project = ([x, , z]: [number, number, number]) => ({ x: x * 10, y: z * 10 });

	it('takes in every unpinned card, deck and piece whose centre is inside it', () => {
		const rect = rectBetween({ x: 95, y: 45 }, { x: -45, y: -5 });
		expect(entitiesInRect(get(gameStore), rect, project)).toEqual([A, B, D, TOKEN, MODEL]);
	});

	it('leaves out whatever is outside, and anything pinned inside', () => {
		const rect = rectBetween({ x: -10, y: -10 }, { x: 100, y: 10 });
		expect(entitiesInRect(get(gameStore), rect, project)).toEqual([A, B]);
	});

	it('leaves out what is behind the camera', () => {
		const rect = rectBetween({ x: -1000, y: -1000 }, { x: 1000, y: 1000 });
		expect(entitiesInRect(get(gameStore), rect, () => null)).toEqual([]);
	});
});
