/**
 * The box selection and the group drag it leads (tableplace-202): who can be
 * selected, what a drag of a selected entity carries, and the one patch a
 * pointer move writes for the lot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import {
	carriedIds,
	carryPatch,
	dragActions,
	dragStart,
	dragStore,
	isCarried
} from '$lib/store/dragStore.svelte';
import {
	addToSelection,
	clearSelection,
	isSelectClick,
	selectedIds,
	setSelection,
	toggleSelected
} from '$lib/store/selection';
import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
import { PIECE_DRAG_Y } from '$lib/utils/constants-pieces';
import { TABLE_HALF_X } from '$lib/utils/constants-table';

const A = 'card:me:a';
const B = 'card:me:b';
const T = 'piece:me:t';
const D = 'deck:me:0';
const PINNED = 'piece:me:pinned';

function seed() {
	gameStore.set({
		players: {},
		cards: {
			[A]: { position: [0, 0.26, 0], rotation: [0, 0, 0], faceImageUrl: 'a.png' },
			[B]: { position: [2, 0.26, 1], rotation: [0, 0, 0], faceImageUrl: 'b.png' }
		},
		decks: { [D]: { id: D, position: [-3, 0.5, 0], rotation: [0, 0, 0], cards: [] } },
		pieces: {
			[T]: { position: [1, 0.335, -2], rotation: [0, 0, 0], kind: 'token' },
			[PINNED]: { position: [4, 0.335, 0], rotation: [0, 0, 0], kind: 'token', locked: true }
		}
	});
}

beforeEach(() => {
	dragActions.reset();
	clearSelection();
	seed();
});

describe('selecting', () => {
	it('never selects a locked entity, by box or by click', () => {
		setSelection([A, PINNED, T]);
		expect(get(selectedIds)).toEqual([A, T]);
		expect(toggleSelected(PINNED)).toBe(false);
		expect(get(selectedIds)).toEqual([A, T]);
	});

	it('Shift+click toggles one entity in and out', () => {
		expect(toggleSelected(B)).toBe(true);
		expect(toggleSelected(D)).toBe(true);
		expect(get(selectedIds)).toEqual([B, D]);
		expect(toggleSelected(B)).toBe(false);
		expect(get(selectedIds)).toEqual([D]);
	});

	it('a Shift box adds to what is selected, without doubling anything', () => {
		setSelection([A]);
		addToSelection([A, B]);
		expect(get(selectedIds)).toEqual([A, B]);
	});

	it('drops a member that is pinned or removed afterwards, by anyone', () => {
		setSelection([A, B, T]);
		gameStore.updateState({ cards: { [A]: { locked: true } } });
		gameStore.updateState({ cards: { [B]: null } });
		expect(get(selectedIds)).toEqual([T]);
	});

	it('Shift selects unless the entity already owns Shift+click; Ctrl and Cmd always do', () => {
		const press = (mods: Partial<MouseEvent>) => ({
			button: 0,
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			...mods
		});
		expect(isSelectClick(press({ shiftKey: true }))).toBe(true);
		expect(isSelectClick(press({ shiftKey: true }), true)).toBe(false);
		expect(isSelectClick(press({ ctrlKey: true }), true)).toBe(true);
		expect(isSelectClick(press({ metaKey: true }), true)).toBe(true);
		expect(isSelectClick(press({}))).toBe(false);
		expect(isSelectClick(press({ button: 2, shiftKey: true }))).toBe(false);
	});
});

describe('a drag of a selected entity carries the selection', () => {
	it('carries every other member at its offset from the one grabbed', () => {
		setSelection([A, B, T]);
		dragStart(A, CARD_DRAG_Y, [0, 0.26, 0]);
		const drag = get(dragStore);
		expect(carriedIds(drag)).toEqual([A, B, T]);
		expect(drag.group?.map((m) => [m.id, m.offset])).toEqual([
			[B, [2, 1]],
			[T, [1, -2]]
		]);
		expect(isCarried(drag, T)).toBe(true);
		expect(isCarried(drag, D)).toBe(false);
	});

	it('writes the whole group in ONE patch, each at its own drag height', () => {
		setSelection([A, B, T]);
		dragStart(A, CARD_DRAG_Y, [0, 0.26, 0]);
		expect(carryPatch(get(dragStore), 5, 5)).toEqual({
			cards: {
				[A]: { position: [5, CARD_DRAG_Y, 5] },
				[B]: { position: [7, CARD_DRAG_Y, 6] }
			},
			pieces: { [T]: { position: [6, PIECE_DRAG_Y, 3] } }
		});
	});

	it('clamps each member to the felt on its own', () => {
		setSelection([A, B]);
		dragStart(A, CARD_DRAG_Y, [0, 0.26, 0]);
		const patch = carryPatch(get(dragStore), TABLE_HALF_X, 0);
		const [bx] = patch?.cards?.[B]?.position ?? [];
		const [ax] = patch?.cards?.[A]?.position ?? [];
		// B sits 2 to the right of A: pushed past the edge, it stops at the same clamp
		expect(bx).toBe(ax);
		expect(bx!).toBeLessThan(TABLE_HALF_X);
	});

	it('grabbing something outside the selection lets go of it and drags one', () => {
		setSelection([A, B]);
		dragStart(T, PIECE_DRAG_Y, [1, 0.335, -2]);
		expect(get(dragStore).group).toEqual([]);
		expect(get(selectedIds)).toEqual([]);
	});

	it('a card drawn off a deck (no table origin) leaves the selection alone', () => {
		setSelection([A, B]);
		dragStart('card:me:drawn', CARD_DRAG_Y);
		expect(get(dragStore).group).toEqual([]);
		expect(get(selectedIds)).toEqual([A, B]);
	});

	it('a lone selected entity drags on its own', () => {
		setSelection([A]);
		dragStart(A, CARD_DRAG_Y, [0, 0.26, 0]);
		expect(get(dragStore).group).toEqual([]);
		expect(carryPatch(get(dragStore), 1, 1)).toEqual({
			cards: { [A]: { position: [1, CARD_DRAG_Y, 1] } }
		});
	});
});
