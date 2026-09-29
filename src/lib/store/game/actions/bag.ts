/**
 * Bag verbs — draw one item out, put one back.
 *
 * A bag is a `PieceDTO` of kind `'bag'` whose `contents` live in synced game
 * state. Both verbs resolve on the acting client and write the RESULT (the
 * drawn entity plus the bag's new contents) as a single `updateState` patch,
 * the same way `shuffleDeck` does: the randomness happens once, so every client
 * agrees on what came out instead of each rolling its own die. A patch per verb
 * also means remote clients never observe a half-applied draw — no window where
 * the item exists twice, or not at all.
 *
 * Contents are never rendered anywhere; only the remaining count is (see
 * Piece.svelte). They do travel in shared state, so "hidden" is a property of
 * the UI, not of the wire — exactly as it is for a TTS save file.
 */

import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import { buildPiece, slugify, type PieceState } from './piece';
import { bagDrawOffset, PIECE_DEFAULT_RADIUS, PIECE_REST_Y } from '$lib/utils/constants-pieces';
import { CARD_REST_Y } from '$lib/utils/constants-cards';
import { clampToTable } from '$lib/utils/transforms/drop';
import type { BagDrawMode, BagItem, CardDTO, GameDTO } from '../types';

type Vec3 = [number, number, number];
type StateUpdate = Parameters<typeof gameStore.updateState>[0];

/** What a draw produced: the new table entity, and the item it came from. */
export type BagDraw = {
	/** id of the spawned entity — `piece:…` or `card:…` */
	id: string;
	item: BagItem;
};

function bagState(bagId: string) {
	const piece = get(gameStore)?.pieces?.[bagId];
	return piece?.kind === 'bag' ? piece : undefined;
}

/** owner segment of a `kind:owner:slug` id */
function ownerOf(id: string): string {
	return id.split(':')[1] ?? '';
}

/**
 * Which entry the next draw takes. `lifo` is the last one in (the top of the
 * pile), `fifo` the first, `random` any of them — and `random` is the default
 * because that is what a bag of tiles does.
 */
export function pickDrawIndex(count: number, mode: BagDrawMode = 'random'): number {
	if (count <= 0) return -1;
	if (mode === 'lifo') return count - 1;
	if (mode === 'fifo') return 0;
	return Math.floor(Math.random() * count);
}

/**
 * Where the drawn item lands: beside the bag, stepping round a ring so a run of
 * draws fans out instead of piling on one spot. The step comes from how much is
 * already on the table, which changes by one per draw. Clamped to the felt, so
 * a bag at the table edge still puts its items somewhere reachable.
 */
function drawPosition(
	state: Partial<GameDTO> | undefined,
	bag: Partial<PieceState>,
	y: number
): Vec3 {
	const [bx = 0, , bz = 0] = bag.position ?? [];
	const crowding = Object.keys(state?.pieces ?? {}).length + Object.keys(state?.cards ?? {}).length;
	const offset = bagDrawOffset(bag.radius ?? PIECE_DEFAULT_RADIUS, crowding);
	const [x, z] = clampToTable(bx + offset.x, bz + offset.z);
	return [x, y, z];
}

/** `card:<owner>:<bag>-<code>`, suffixed if a card by that id is already out. */
function nextCardId(taken: Set<string>, owner: string, bagSlug: string, code: string): string {
	const base = `card:${owner}:${bagSlug}-${code}`;
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/**
 * Draw one item out of a bag and spawn it beside the bag.
 *
 * Returns the draw, or null when there is nothing to draw (not a bag, empty,
 * or no owner to spawn for). An infinite bag keeps its contents and clones the
 * item instead — so it never empties.
 */
function drawFromBag(bagId: string): BagDraw | null {
	const state = get(gameStore);
	const bag = bagState(bagId);
	if (!bag) return null;

	const contents = bag.contents ?? [];
	const index = pickDrawIndex(contents.length, bag.drawMode);
	if (index < 0) return null;
	const item = contents[index];

	const owner = ownerOf(bagId);
	// contents survive an infinite draw untouched; a finite one loses the entry
	const remaining = bag.infinite ? contents : contents.filter((_, i) => i !== index);
	const update: { pieces: Record<string, unknown>; cards?: Record<string, Partial<CardDTO>> } = {
		pieces: { [bagId]: { contents: remaining } }
	};

	let id: string;
	if (item.kind === 'card') {
		const bagSlug = slugify(bag.name ?? 'bag', 'bag');
		id = nextCardId(new Set(Object.keys(state?.cards ?? {})), owner, bagSlug, item.code);
		update.cards = {
			[id]: {
				faceImageUrl: item.face,
				...(item.back ? { backImageUrl: item.back } : {}),
				...(item.name ? { name: item.name } : {}),
				...(item.orientation ? { orientation: item.orientation } : {}),
				position: drawPosition(state, bag, CARD_REST_Y),
				// facedown (180 on x, matching Card.svelte): the bag's contents were
				// hidden, so the draw doesn't reveal them — F turns it over
				rotation: [180, 0, 0]
			}
		};
	} else {
		const built = buildPiece(item.kind, {
			ownerId: owner || undefined,
			name: item.name,
			color: item.color,
			imageUrl: item.imageUrl,
			radius: item.radius,
			maxValue: item.maxValue,
			position: drawPosition(state, bag, PIECE_REST_Y)
		});
		if (!built) return null;
		id = built.id;
		update.pieces[id] = built.piece;
	}

	gameStore.updateState(update as StateUpdate);
	return { id, item };
}

/**
 * Put a table entity back into a bag: the entity is deleted and appended to the
 * bag's contents in one patch, so it is never on the table and in the bag at
 * once. Appended (not prepended) because contents are in insertion order — a
 * lifo bag hands back what went in last.
 *
 * Refuses a bag (containers don't nest — see docs/packs.md), a die (there is no
 * die item in `contents`: its `sides`, face and roll state have nowhere to
 * live, so swallowing one would quietly turn it into a token on the way out),
 * and anything the store doesn't know about. Returns whether the return
 * happened, so a caller can leave the entity where it is when it didn't.
 */
function returnToBag(bagId: string, entityId: string): boolean {
	if (entityId === bagId) return false;
	const state = get(gameStore);
	const bag = bagState(bagId);
	if (!bag) return false;

	const update: {
		pieces: Record<string, unknown>;
		cards?: Record<string, null>;
	} = { pieces: {} };
	let item: BagItem;

	if (entityId.startsWith('piece:')) {
		const piece = state?.pieces?.[entityId];
		// a model is refused like a die: `contents` has no item that could carry
		// its catalog ref, so swallowing a cave section would turn it into a token
		if (!piece || piece.kind === 'bag' || piece.kind === 'die' || piece.kind === 'model')
			return false;
		item = {
			kind: piece.kind ?? 'token',
			name: piece.name ?? 'Token',
			...(piece.color ? { color: piece.color } : {}),
			...(piece.imageUrl ? { imageUrl: piece.imageUrl } : {}),
			...(piece.radius !== undefined ? { radius: piece.radius } : {}),
			...(piece.maxValue !== undefined ? { maxValue: piece.maxValue } : {})
		};
		update.pieces[entityId] = null;
	} else {
		const card = state?.cards?.[entityId];
		if (!card?.faceImageUrl) return false;
		item = {
			kind: 'card',
			// the slug half of `card:<owner>:<slug>` is the closest thing the card
			// has to a code, and it is what a re-draw will build its id from again
			code: entityId.split(':').slice(2).join(':') || 'card',
			face: card.faceImageUrl,
			...(card.backImageUrl ? { back: card.backImageUrl } : {}),
			...(card.name ? { name: card.name } : {}),
			...(card.orientation ? { orientation: card.orientation } : {})
		};
		update.cards = { [entityId]: null };
	}

	update.pieces[bagId] = { contents: [...(bag.contents ?? []), item] };
	gameStore.updateState(update as StateUpdate);
	return true;
}

/** Remaining count, or null for an infinite bag (which never runs down). */
function bagCount(bagId: string): number | null {
	const bag = bagState(bagId);
	if (!bag) return 0;
	return bag.infinite ? null : (bag.contents ?? []).length;
}

export const bagActions = {
	drawFromBag,
	returnToBag,
	bagCount
};
