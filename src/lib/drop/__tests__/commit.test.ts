/**
 * What a release actually writes (tableplace-96).
 *
 * `resolveDrop` decides the landing and is unit-tested next to the stacking
 * math; this covers the other half — that the commit writes exactly that
 * landing, and that a snap point with an authored yaw is the *only* case where
 * a drop puts a rotation on the wire. Both clients end up on the same transform
 * because this one patch is what the relay carries; nothing about snapping is
 * synced separately.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { commitActiveDrag } from '../commit';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { dragActions, dragStart, dragStore } from '$lib/store/dragStore.svelte';
import { CARD_REST_Y, deckHeightForCount } from '$lib/utils/constants-cards';
import { PIECE_REST_Y } from '$lib/utils/constants-pieces';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';
import type { GameDTO } from '$lib/store/game/types';

const CARD = 'card:me:a';
const PIECE = 'piece:me:t';
const DECK = 'deck:me:main';
const DECK_SIZE = 20;

/** a table holding one card, one token, one deck, and two snap points */
function seed(snapPoints: NonNullable<GameDTO['snapPoints']>) {
	gameStore.set({
		players: {},
		decks: {
			[DECK]: {
				id: DECK,
				position: [0, 2, 0],
				rotation: [0, 0, 0],
				cards: Array.from({ length: DECK_SIZE }, (_, i) => ({
					id: `c${i}`,
					faceImageUrl: 'f.png'
				}))
			}
		},
		cards: { [CARD]: { position: [0, 2, 0], rotation: [0, 0, 0], faceImageUrl: 'f.png' } },
		pieces: { [PIECE]: { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'token', name: 'T' } },
		snapPoints
	});
}

/** release `id` with the pointer over (x, z) */
function release(id: string, x: number, z: number) {
	dragStart(id, 2);
	// the table raycast the drop resolves against, as TableScene publishes it
	dragStore.update((state) => ({ ...state, intersectionPoint: { x, z } as never }));
	commitActiveDrag();
}

describe('commitActiveDrag with authored snap points', () => {
	beforeEach(() => {
		dragActions.reset();
		vi.restoreAllMocks();
		seed({
			'snap:0': { id: 'snap:0', position: [6, 3], radius: 1, rotation: 90 },
			'snap:1': { id: 'snap:1', position: [-6, 3], radius: 1 }
		});
	});

	it('lands a card on the point and turns it to the authored yaw', () => {
		release(CARD, 6.4, 3.2);
		expect(get(gameStore).cards?.[CARD]).toMatchObject({
			position: [6, CARD_REST_Y, 3],
			rotation: [0, 0, 90]
		});
	});

	it('lands a token on the point at piece rest height', () => {
		release(PIECE, 6.4, 3);
		expect(get(gameStore).pieces?.[PIECE]).toMatchObject({
			position: [6, PIECE_REST_Y, 3],
			rotation: [0, 90, 0]
		});
	});

	it('lands a whole dragged deck on the point, turned in radians', () => {
		// the composition of tableplace-88 (drag a deck) with this ticket: the
		// deck's own resting half-height survives, the point decides XZ and yaw
		release(DECK, 6.4, 3.1);
		const deck = get(gameStore).decks?.[DECK];
		expect([deck?.position?.[0], deck?.position?.[2]]).toEqual([6, 3]);
		expect(deck?.position?.[1]).toBeCloseTo(TABLE_TOP_Y + deckHeightForCount(DECK_SIZE) / 2);
		expect(deck?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
	});

	it('writes no rotation when the point authored none', () => {
		const patch = vi.spyOn(gameStore, 'updateState');
		release(CARD, -6.4, 3);
		expect(patch).toHaveBeenCalledWith({
			cards: { [CARD]: { position: [-6, CARD_REST_Y, 3], heldBy: null } }
		});
	});

	it('writes no rotation for an ordinary drop, so nothing unchanged goes on the wire', () => {
		const patch = vi.spyOn(gameStore, 'updateState');
		release(CARD, 1, 1);
		expect(patch).toHaveBeenCalledWith({
			cards: { [CARD]: { position: [1, CARD_REST_Y, 1], heldBy: null } }
		});
	});

	it('leaves the drag cleared afterwards, snapped or not', () => {
		release(CARD, 6, 3);
		expect(get(dragStore).isDragging).toBeNull();
	});

	it('ignores the points entirely when Alt was held at release', () => {
		dragStart(CARD, 2);
		dragStore.update((state) => ({
			...state,
			intersectionPoint: { x: 6.4, z: 3 } as never,
			noSnap: true
		}));
		commitActiveDrag();
		expect(get(gameStore).cards?.[CARD]).toMatchObject({
			position: [6.4, CARD_REST_Y, 3],
			rotation: [0, 0, 0]
		});
	});
});
