/**
 * Bag draws and returns. The properties that matter for multiplayer are here:
 * a draw resolves ONCE and lands in state (so two clients can't disagree about
 * a random result), and each verb writes a SINGLE patch (so no client ever sees
 * the item both on the table and in the bag, or in neither).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';
import { pickDrawIndex } from '../game/actions/bag';
import { CARD_REST_Y } from '$lib/utils/constants-cards';
import { PIECE_REST_Y } from '$lib/utils/constants-pieces';
import type { BagDrawMode, BagItem, GameDTO } from '../game/types';

const OWNER = 'seat0';
const BAG = 'piece:seat0:tile-bag-0';

const ITEMS: BagItem[] = [
	{ kind: 'token', name: 'First', color: '#111111' },
	{ kind: 'counter', name: 'Middle', maxValue: 5 },
	{ kind: 'card', code: 'omen', name: 'Omen', face: 'https://example.com/omen.png' }
];

function seedBag(opts: { contents?: BagItem[]; drawMode?: BagDrawMode; infinite?: boolean } = {}) {
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	gameActions.addPiece('bag', {
		ownerId: OWNER,
		name: 'Tile Bag',
		contents: opts.contents ?? ITEMS,
		drawMode: opts.drawMode,
		infinite: opts.infinite,
		position: [2, PIECE_REST_Y, 3]
	});
	return BAG;
}

const bag = () => get(gameStore).pieces?.[BAG];
const contents = () => bag()?.contents ?? [];

describe('addPiece(bag)', () => {
	beforeEach(() => seedBag());

	it('stores the pool and the draw mode in synced state', () => {
		expect(bag()).toMatchObject({ kind: 'bag', name: 'Tile Bag', drawMode: 'random' });
		expect(contents()).toHaveLength(3);
	});

	it('always writes a contents array, so a hand-spawned bag can be filled', () => {
		gameStore.set({ players: {}, pieces: {} });
		const id = gameActions.addPiece('bag', { ownerId: OWNER });
		expect(get(gameStore).pieces?.[id]?.contents).toEqual([]);
	});

	it('leaves bag state off other kinds', () => {
		const id = gameActions.addPiece('token', { ownerId: OWNER, contents: ITEMS, infinite: true });
		const piece = get(gameStore).pieces?.[id];
		expect(piece?.contents).toBeUndefined();
		expect(piece?.infinite).toBeUndefined();
	});
});

describe('pickDrawIndex', () => {
	it('takes the last item in for lifo and the first for fifo', () => {
		expect(pickDrawIndex(3, 'lifo')).toBe(2);
		expect(pickDrawIndex(3, 'fifo')).toBe(0);
	});

	it('defaults to a random pick within range', () => {
		for (let i = 0; i < 50; i++) {
			const index = pickDrawIndex(3);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(3);
		}
	});

	it('reports an empty bag rather than picking nothing', () => {
		expect(pickDrawIndex(0, 'lifo')).toBe(-1);
	});
});

describe('drawFromBag', () => {
	it('lifo hands back the last item and removes it', () => {
		seedBag({ drawMode: 'lifo' });
		const drawn = gameActions.drawFromBag(BAG);
		expect(drawn?.item).toMatchObject({ kind: 'card', code: 'omen' });
		expect(contents().map((i) => i.name)).toEqual(['First', 'Middle']);
	});

	it('fifo hands back the first item', () => {
		seedBag({ drawMode: 'fifo' });
		expect(gameActions.drawFromBag(BAG)?.item).toMatchObject({ name: 'First' });
		expect(contents().map((i) => i.name)).toEqual(['Middle', 'Omen']);
	});

	it('random draws exactly one item out of the pool', () => {
		seedBag();
		vi.spyOn(Math, 'random').mockReturnValue(0.5); // → index 1 of 3
		const drawn = gameActions.drawFromBag(BAG);
		vi.restoreAllMocks();

		expect(drawn?.item).toMatchObject({ kind: 'counter', name: 'Middle' });
		expect(contents().map((i) => i.name)).toEqual(['First', 'Omen']);
	});

	it('spawns a piece item as a real piece beside the bag', () => {
		seedBag({ contents: [ITEMS[1]], drawMode: 'lifo' });
		const drawn = gameActions.drawFromBag(BAG);
		const piece = get(gameStore).pieces?.[drawn?.id ?? ''];

		expect(drawn?.id.startsWith('piece:seat0:')).toBe(true);
		// a drawn counter arrives full, exactly like a spawned one
		expect(piece).toMatchObject({ kind: 'counter', name: 'Middle', value: 5, maxValue: 5 });
		expect(piece?.position?.[1]).toBe(PIECE_REST_Y);
		// beside the bag, not on top of it
		expect([piece?.position?.[0], piece?.position?.[2]]).not.toEqual([2, 3]);
	});

	it('spawns a card item facedown, keeping the contents hidden until it is flipped', () => {
		seedBag({ contents: [ITEMS[2]], drawMode: 'lifo' });
		const drawn = gameActions.drawFromBag(BAG);
		const card = get(gameStore).cards?.[drawn?.id ?? ''];

		expect(drawn?.id).toBe('card:seat0:tile-bag-omen');
		expect(card).toMatchObject({ faceImageUrl: 'https://example.com/omen.png' });
		expect(card?.rotation?.[0]).toBe(180); // facedown
		expect(card?.position?.[1]).toBe(CARD_REST_Y);
	});

	it('an infinite bag clones instead of emptying', () => {
		seedBag({ contents: [ITEMS[0]], infinite: true, drawMode: 'lifo' });

		const first = gameActions.drawFromBag(BAG);
		const second = gameActions.drawFromBag(BAG);

		expect(contents()).toHaveLength(1);
		expect(first?.id).not.toBe(second?.id); // two distinct pieces on the table
		expect(Object.keys(get(gameStore).pieces ?? {})).toHaveLength(3); // bag + 2 draws
	});

	it('writes the drawn entity and the shrunken bag in ONE patch', () => {
		seedBag({ drawMode: 'lifo' });
		const patches: unknown[] = [];
		const spy = vi.spyOn(gameStore, 'updateState').mockImplementation((update) => {
			patches.push(update);
		});

		gameActions.drawFromBag(BAG);
		spy.mockRestore();

		expect(patches).toHaveLength(1);
		const [patch] = patches as [{ pieces: Record<string, unknown>; cards?: object }];
		expect(patch.pieces[BAG]).toEqual({ contents: [ITEMS[0], ITEMS[1]] });
		expect(Object.keys(patch.cards ?? {})).toHaveLength(1);
	});

	it('refuses an empty bag, a missing bag, and a piece that is not a bag', () => {
		seedBag({ contents: [] });
		expect(gameActions.drawFromBag(BAG)).toBeNull();
		expect(gameActions.drawFromBag('piece:seat0:nope-0')).toBeNull();

		const token = gameActions.addPiece('token', { ownerId: OWNER });
		expect(gameActions.drawFromBag(token)).toBeNull();
	});
});

describe('returnToBag', () => {
	function seedWithToken() {
		seedBag({ contents: [] });
		return gameActions.addPiece('token', {
			ownerId: OWNER,
			name: 'Ember',
			color: '#f97316',
			imageUrl: 'https://example.com/ember.png'
		});
	}

	it('swallows a piece: off the table and into the pool, keeping its fields', () => {
		const token = seedWithToken();

		expect(gameActions.returnToBag(BAG, token)).toBe(true);
		expect(get(gameStore).pieces?.[token]).toBeUndefined();
		expect(contents()).toEqual([
			{
				kind: 'token',
				name: 'Ember',
				color: '#f97316',
				imageUrl: 'https://example.com/ember.png',
				radius: 0.75
			}
		]);
	});

	it('a square token goes in square and comes back out square (tableplace-254)', () => {
		seedBag({ contents: [], drawMode: 'lifo' });
		const tile = gameActions.addPiece('token', {
			ownerId: OWNER,
			name: 'Tile',
			imageUrl: 'https://example.com/tile.png',
			shape: 'square',
			radius: 1
		});
		expect(get(gameStore).pieces?.[tile]?.shape).toBe('square');

		expect(gameActions.returnToBag(BAG, tile)).toBe(true);
		expect(contents()).toEqual([
			{
				kind: 'token',
				name: 'Tile',
				imageUrl: 'https://example.com/tile.png',
				radius: 1,
				shape: 'square'
			}
		]);

		const drawn = gameActions.drawFromBag(BAG);
		expect(get(gameStore).pieces?.[drawn?.id ?? '']).toMatchObject({
			kind: 'token',
			name: 'Tile',
			imageUrl: 'https://example.com/tile.png',
			radius: 1,
			shape: 'square'
		});
	});

	it('never gives a shape to a kind that has none, going in or coming out', () => {
		// a pawn that a stale client sent with `shape` on it
		seedBag({ contents: [{ kind: 'counter', name: 'Dial', maxValue: 5, shape: 'square' }] });
		const drawn = gameActions.drawFromBag(BAG);
		expect(get(gameStore).pieces?.[drawn?.id ?? '']).not.toHaveProperty('shape');

		gameStore.updateState({
			pieces: { 'piece:seat0:pawn-0': { kind: 'pawn', name: 'Pawn', shape: 'square' } }
		});
		expect(gameActions.returnToBag(BAG, 'piece:seat0:pawn-0')).toBe(true);
		expect(contents().at(-1)).not.toHaveProperty('shape');
	});

	it('deletes the entity and grows the bag in ONE patch', () => {
		const token = seedWithToken();
		const patches: unknown[] = [];
		const spy = vi.spyOn(gameStore, 'updateState').mockImplementation((update) => {
			patches.push(update);
		});

		gameActions.returnToBag(BAG, token);
		spy.mockRestore();

		expect(patches).toHaveLength(1);
		const [patch] = patches as [{ pieces: Record<string, unknown> }];
		expect(patch.pieces[token]).toBeNull();
		expect(patch.pieces[BAG]).toMatchObject({ contents: [{ name: 'Ember' }] });
	});

	it('swallows a card, keeping its face and back for the next draw', () => {
		seedBag({ contents: [] });
		gameStore.updateState({
			cards: {
				'card:seat0:loose-omen': {
					faceImageUrl: 'https://example.com/omen.png',
					backImageUrl: 'gen:std52/back',
					position: [0, CARD_REST_Y, 0],
					rotation: [0, 0, 0]
				}
			}
		});

		expect(gameActions.returnToBag(BAG, 'card:seat0:loose-omen')).toBe(true);
		expect(get(gameStore).cards?.['card:seat0:loose-omen']).toBeUndefined();
		expect(contents()).toEqual([
			{
				kind: 'card',
				code: 'loose-omen',
				face: 'https://example.com/omen.png',
				back: 'gen:std52/back'
			}
		]);
	});

	it('appends, so a lifo bag hands back the object that just went in', () => {
		seedBag({ drawMode: 'lifo' });
		const token = gameActions.addPiece('token', { ownerId: OWNER, name: 'Last In' });
		gameActions.returnToBag(BAG, token);

		expect(gameActions.drawFromBag(BAG)?.item).toMatchObject({ name: 'Last In' });
	});

	it('refuses to nest containers, or to swallow itself or an unknown entity', () => {
		seedBag({ contents: [] });
		const other = gameActions.addPiece('bag', { ownerId: OWNER, name: 'Other Bag' });

		expect(gameActions.returnToBag(BAG, other)).toBe(false);
		expect(gameActions.returnToBag(BAG, BAG)).toBe(false);
		expect(gameActions.returnToBag(BAG, 'card:seat0:ghost')).toBe(false);
		expect(gameActions.returnToBag('piece:seat0:not-a-bag-0', other)).toBe(false);
		expect(contents()).toEqual([]);
	});
});

/**
 * The multiplayer property, without a second browser: /play wraps
 * `updateState` so the patch it produces is exactly what goes on the wire
 * (websocket/storeIntegration.ts), and a receiving client applies that same
 * object through `updateStateSilently`. So capturing one client's patch and
 * replaying it into another client's view is the sync path.
 */
describe('a draw as the other client sees it', () => {
	function captureDraw(before: Partial<GameDTO>) {
		const patches: unknown[] = [];
		const spy = vi.spyOn(gameStore, 'updateState').mockImplementation((update) => {
			patches.push(update);
		});
		const drawn = gameActions.drawFromBag(BAG);
		spy.mockRestore();
		// rewind to the pre-draw table: this is now client B, which never drew
		gameStore.set(structuredClone(before));
		return { drawn, patch: patches[0] as Parameters<typeof gameStore.updateStateSilently>[0] };
	}

	it('resolves a random draw to the same item on both clients', () => {
		seedBag();
		const before = structuredClone(get(gameStore));

		vi.spyOn(Math, 'random').mockReturnValue(0.5); // client A rolls once
		const { drawn, patch } = captureDraw(before);
		// client B has no dice of its own — and would roll differently if it did
		vi.spyOn(Math, 'random').mockReturnValue(0.99);
		gameStore.updateStateSilently(patch);
		vi.restoreAllMocks();

		expect(drawn?.item).toMatchObject({ name: 'Middle' });
		// same entity, same pool, same badge count on the other side of the wire
		expect(get(gameStore).pieces?.[drawn?.id ?? '']).toMatchObject({ name: 'Middle' });
		expect(contents().map((i) => i.name)).toEqual(['First', 'Omen']);
		expect(gameActions.bagCount(BAG)).toBe(2);
	});

	it('carries a return across too, in one patch', () => {
		seedBag({ contents: [] });
		const token = gameActions.addPiece('token', { ownerId: OWNER, name: 'Ember' });
		const before = structuredClone(get(gameStore));

		const patches: unknown[] = [];
		const spy = vi.spyOn(gameStore, 'updateState').mockImplementation((u) => void patches.push(u));
		gameActions.returnToBag(BAG, token);
		spy.mockRestore();
		gameStore.set(structuredClone(before));

		gameStore.updateStateSilently(
			patches[0] as Parameters<typeof gameStore.updateStateSilently>[0]
		);

		expect(get(gameStore).pieces?.[token]).toBeUndefined();
		expect(gameActions.bagCount(BAG)).toBe(1);
	});
});

describe('bagCount', () => {
	it('counts a finite bag and reports null for an infinite one', () => {
		seedBag();
		expect(gameActions.bagCount(BAG)).toBe(3);

		seedBag({ infinite: true });
		expect(gameActions.bagCount(BAG)).toBeNull();
	});
});
