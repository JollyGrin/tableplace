/**
 * A group drop (tableplace-202): every member resolves its own landing, the
 * group lands on the table only, one patch goes out, and Esc puts the lot
 * back where it was picked up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { cancelActiveDrag, commitActiveDrag } from '../commit';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { carryPatch, dragActions, dragStart, dragStore } from '$lib/store/dragStore.svelte';
import { clearSelection, setSelection } from '$lib/store/selection';
import { resolveGroupDrop } from '$lib/utils/transforms/group-drop';
import { CARD_DRAG_Y, CARD_REST_Y, CARD_THICKNESS } from '$lib/utils/constants-cards';
import { PIECE_REST_Y } from '$lib/utils/constants-pieces';

const A = 'card:me:a';
const B = 'card:me:b';
const T = 'piece:me:t';
const DECK = 'deck:me:0';

function seed() {
	gameStore.set({
		players: {},
		cards: {
			[A]: { position: [0, CARD_REST_Y, 0], rotation: [0, 0, 0], faceImageUrl: 'a.png' },
			[B]: { position: [3, CARD_REST_Y, 0], rotation: [0, 0, 0], faceImageUrl: 'b.png' }
		},
		decks: {
			[DECK]: {
				id: DECK,
				position: [10, 0.5, 0],
				rotation: [0, 0, 0],
				cards: [{ id: 'c0', faceImageUrl: 'c.png' }]
			}
		},
		pieces: { [T]: { position: [0, PIECE_REST_Y, 3], rotation: [0, 0, 0], kind: 'token' } },
		snapPoints: { 'snap:0': { id: 'snap:0', position: [8, 3], radius: 1 } }
	});
}

/** grab `lead` out of the selection and carry the group so the lead is over (x, z) */
function carryTo(lead: string, origin: [number, number, number], x: number, z: number) {
	dragStart(lead, CARD_DRAG_Y, origin);
	const patch = carryPatch(get(dragStore), x, z);
	if (patch) gameStore.updateState(patch);
	dragStore.update((state) => ({ ...state, intersectionPoint: { x, z } as never }));
}

beforeEach(() => {
	dragActions.reset();
	clearSelection();
	vi.restoreAllMocks();
	seed();
});

describe('commitActiveDrag with a group', () => {
	it('moves every member by the same delta, each at its own rest height', () => {
		setSelection([A, B, T]);
		carryTo(A, [0, CARD_REST_Y, 0], 2, -4);
		commitActiveDrag();
		const state = get(gameStore);
		expect(state.cards?.[A]?.position).toEqual([2, CARD_REST_Y, -4]);
		expect(state.cards?.[B]?.position).toEqual([5, CARD_REST_Y, -4]);
		expect(state.pieces?.[T]?.position).toEqual([2, PIECE_REST_Y, -1]);
		expect(get(dragStore).isDragging).toBeNull();
		expect(get(dragStore).group).toEqual([]);
	});

	it('carries a face-down card and its peek mark as they are: a move is not a flip', () => {
		gameStore.updateState({ cards: { [B]: { rotation: [180, 0, 0], placedBy: 'me' } } });
		setSelection([A, B]);
		carryTo(A, [0, CARD_REST_Y, 0], 2, -4);
		commitActiveDrag();
		expect(get(gameStore).cards?.[B]).toMatchObject({
			position: [5, CARD_REST_Y, -4],
			rotation: [180, 0, 0],
			placedBy: 'me'
		});
	});

	it('never carries a locked entity, even one pinned after it was selected', () => {
		setSelection([A, B, T]);
		gameStore.updateState({ pieces: { [T]: { locked: true } } });
		carryTo(A, [0, CARD_REST_Y, 0], 2, -4);
		commitActiveDrag();
		expect(get(gameStore).pieces?.[T]?.position).toEqual([0, PIECE_REST_Y, 3]);
		expect(get(gameStore).cards?.[B]?.position).toEqual([5, CARD_REST_Y, -4]);
	});

	it('sends the whole landing as ONE patch', () => {
		setSelection([A, B, T]);
		carryTo(A, [0, CARD_REST_Y, 0], 2, -4);
		const update = vi.spyOn(gameStore, 'updateState');
		commitActiveDrag();
		expect(update).toHaveBeenCalledTimes(1);
		expect(Object.keys(update.mock.calls[0][0].cards ?? {})).toEqual([A, B]);
		expect(Object.keys(update.mock.calls[0][0].pieces ?? {})).toEqual([T]);
	});

	it('each member resolves its own snap point', () => {
		setSelection([A, T]);
		// T rides 3 below A; carrying A to (8, 0) puts T at (8, 3): on the point
		carryTo(A, [0, CARD_REST_Y, 0], 8, 0.2);
		commitActiveDrag();
		const state = get(gameStore);
		expect(state.pieces?.[T]?.position).toEqual([8, PIECE_REST_Y, 3]);
		expect(state.cards?.[A]?.position).toEqual([8, CARD_REST_Y, 0.2]);
	});

	it('never lands on a hovered deck — a group lands on the table', () => {
		setSelection([A, B]);
		carryTo(A, [0, CARD_REST_Y, 0], 10, 0);
		dragStore.update((state) => ({ ...state, isDeckHovered: DECK }));
		commitActiveDrag();
		const state = get(gameStore);
		expect(state.cards?.[A]).toBeTruthy();
		expect(state.decks?.[DECK]?.cards).toHaveLength(1);
	});

	it('Esc puts every member back where it was picked up, in one patch', () => {
		setSelection([A, B, T]);
		carryTo(A, [0, CARD_REST_Y, 0], 2, -4);
		const update = vi.spyOn(gameStore, 'updateState');
		cancelActiveDrag();
		expect(update).toHaveBeenCalledTimes(1);
		const state = get(gameStore);
		expect(state.cards?.[A]?.position).toEqual([0, CARD_REST_Y, 0]);
		expect(state.cards?.[B]?.position).toEqual([3, CARD_REST_Y, 0]);
		expect(state.pieces?.[T]?.position).toEqual([0, PIECE_REST_Y, 3]);
	});
});

describe('resolveGroupDrop', () => {
	it('a selected pile lands as a pile: lowest first, each resting on the last', () => {
		const high = CARD_REST_Y + CARD_THICKNESS;
		const state = {
			cards: {
				[A]: { position: [4, CARD_DRAG_Y, 4], rotation: [0, 0, 0], faceImageUrl: 'a' },
				[B]: { position: [4, CARD_DRAG_Y, 4], rotation: [0, 0, 0], faceImageUrl: 'b' }
			}
		} as never;
		// B was on top of A when they were picked up; the lead is the top card
		const landed = resolveGroupDrop(state, B, { x: 4, z: 4 }, [
			{ id: A, origin: [0, CARD_REST_Y, 0] }
		]);
		const at = Object.fromEntries(landed.map(([id, drop]) => [id, drop.position[1]]));
		// the lead resolves first, against the table without the group: the felt
		expect(at[B]).toBeCloseTo(CARD_REST_Y);
		// …and the other then rests on it — never on a member still floating
		expect(at[A]).toBeCloseTo(high);
	});

	it('skips a member that no longer exists', () => {
		const state = {
			cards: { [A]: { position: [0, CARD_DRAG_Y, 0], rotation: [0, 0, 0], faceImageUrl: 'a' } }
		} as never;
		const landed = resolveGroupDrop(state, A, { x: 0, z: 0 }, [
			{ id: 'card:me:gone', origin: [0, 0, 0] }
		]);
		expect(landed.map(([id]) => id)).toEqual([A]);
	});
});
