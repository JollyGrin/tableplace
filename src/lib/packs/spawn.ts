import { get } from 'svelte/store';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import {
	composePackDeck,
	composePackOverlay,
	composePackPiece,
	packCardId,
	placeholderSeat
} from '$lib/compose/pack';
import { BUILTIN_PACKS, PACK_SOURCE_BUILTIN } from './builtin';
import { hasLibraryPack, PACK_SOURCE_LOCAL } from './library';
import type { SpreadTile } from './spread';
import type { GamePackDef, PackDeckDef } from './types';
import type { CardDTO } from '$lib/store/game/types';

export type SpawnPackOptions = {
	/** entity owner — defaults to the local player (the scenario editor passes `seat0`…`seat3`) */
	ownerId?: string;
	/**
	 * where this pack re-resolves from ('builtin' | 'local' | URL); auto-detected
	 * for builtin packs and for packs held in this browser's library
	 */
	source?: string;
};

type Vec3 = [number, number, number];

export type SpawnDeckOptions = SpawnPackOptions & {
	position?: Vec3;
	rotation?: Vec3;
	isFaceUp?: boolean;
	/**
	 * Explicit card order as pack card codes (deck-array order). Unknown codes
	 * are skipped with a warning; omitted = the pack's declaration order.
	 */
	order?: string[];
	/**
	 * Explicit shuffle opt-in. Scenario loads pass the placement's
	 * `shuffleOnLoad`; plain spawns pass `!isFaceUp` to keep the historical
	 * "facedown decks spawn shuffled" behavior.
	 */
	shuffle?: boolean;
	/** re-save authoring intent: stamped onto the deck so export round-trips it */
	shuffleOnLoad?: boolean;
	/** sideways slot when a pack spawns several decks */
	index?: number;
};

/**
 * Seat of the acting owner — placeholder ids (`seat0`…`seat3`) matched by
 * shape to avoid importing scenario.ts (which imports this package).
 */
function ownerSeat(ownerId: string): number {
	return placeholderSeat(ownerId) ?? get(gameStore)?.players?.[ownerId]?.seat ?? 0;
}

/**
 * Where a scenario should look for this pack again. Builtins re-resolve from
 * the shipped registry; anything in the local library re-resolves from there,
 * which is what makes a pack imported from disk survive a scenario save/load
 * without being hosted anywhere. A pack that is in neither gets no stamp — a
 * scenario referencing it will fail loudly by id rather than silently.
 *
 * The browser's answer to the question `compose/` deliberately doesn't ask:
 * the local library is localStorage, which a headless composer has no access
 * to and no business inventing.
 */
export function packSource(pack: GamePackDef, source?: string): string | undefined {
	if (source) return source;
	if (BUILTIN_PACKS[pack.id]) return PACK_SOURCE_BUILTIN;
	return hasLibraryPack(pack.id) ? PACK_SOURCE_LOCAL : undefined;
}

/**
 * Spawn one of a pack's decks. Shapes the deck with `composePackDeck` — the
 * same pure builder a headless scenario composition uses — and writes it to
 * the gameStore.
 *
 * Written directly rather than via `addDeck`: that helper derives id, seat and
 * position from the LOCAL player, but a pack spawns for an arbitrary owner (a
 * `seatN` placeholder in the scenario editor). One update per deck keeps each
 * card list under the server's websocket read limit.
 */
export function spawnPackDeck(pack: GamePackDef, deck: PackDeckDef, opts: SpawnDeckOptions = {}) {
	const ownerId = opts.ownerId ?? gameActions.getMyId();
	if (!ownerId) return console.error('Cannot spawn a deck without an owner id');

	const composed = composePackDeck(pack, deck, {
		...opts,
		ownerId,
		seat: ownerSeat(ownerId),
		source: packSource(pack, opts.source),
		// one shuffle implementation on the client, whatever spawned the deck
		shuffleWith: (cards) => gameActions.shuffleCards(cards)
	});
	gameStore.updateState({ decks: { [composed.id]: composed.deck } });
}

export type SpawnDeckSpreadOptions = SpawnPackOptions & {
	/** where each card lands — `spreadLayout(pack.decks)[deckIndex]` */
	tiles: SpreadTile[];
};

/**
 * Spawn one of a pack's decks as loose, face-up cards on a grid instead of a
 * pile — the /create preview's Spread mode.
 *
 * Same card ids as `spawnPackDeck`, so `clearPreview`'s `:preview:` sweep
 * keeps working and a spread respawn replaces exactly what the last one put
 * down. Face-up regardless of the deck's `isFaceUp`: the point of a spread is
 * to see the faces, and `isFaceUp` stays the durable start-face for play.
 * Positions come from the caller because the grid is a function of the WHOLE
 * pack (decks stack into blocks), not of one deck. No `packOrigin` either:
 * a loose CardDTO has nowhere to carry it, and a spread is inspection only.
 *
 * Returns the card ids it wrote, in tile order, so a caller can map a card on
 * the table back to the tile (and the pack card) it came from.
 */
export function spawnPackDeckSpread(deck: PackDeckDef, opts: SpawnDeckSpreadOptions): string[] {
	const ownerId = opts.ownerId ?? gameActions.getMyId();
	if (!ownerId) {
		console.error('Cannot spawn a spread without an owner id');
		return [];
	}

	const ids: string[] = [];
	const cards: Record<string, Partial<CardDTO>> = {};
	for (const tile of opts.tiles) {
		const id = packCardId(ownerId, deck.slot, tile.card.code);
		ids.push(id);
		cards[id] = {
			faceImageUrl: tile.card.face,
			...(deck.back ? { backImageUrl: deck.back } : {}),
			...(tile.card.name ? { name: tile.card.name } : {}),
			...(tile.card.orientation === 'landscape' ? { orientation: tile.card.orientation } : {}),
			position: tile.position,
			rotation: [0, 0, 0]
		};
	}
	// one update per deck, matching spawnPackDeck: keeps each patch small
	if (ids.length) gameStore.updateState({ cards });
	return ids;
}

export type SpawnPieceOptions = SpawnPackOptions & {
	position?: Vec3;
	rotation?: Vec3;
	value?: number;
	/** multi-state pieces: which authored state to start on (default 0) */
	state?: number;
};

/** Spawn one of a pack's pieces (by index into `pack.pieces`). */
export function spawnPackPiece(pack: GamePackDef, index: number, opts: SpawnPieceOptions = {}) {
	const ownerId = opts.ownerId ?? gameActions.getMyId();
	if (!ownerId) return console.error('Cannot spawn a piece without an owner id');

	const composed = composePackPiece(pack, index, {
		...opts,
		ownerId,
		seat: ownerSeat(ownerId),
		source: packSource(pack, opts.source),
		taken: new Set(Object.keys(get(gameStore)?.pieces ?? {}))
	});
	if (!composed) return;
	gameStore.updateState({ pieces: { [composed.id]: composed.piece } });
}

export type SpawnOverlayOptions = SpawnPackOptions & {
	position?: Vec3;
	rotation?: Vec3;
	scale?: number;
};

/** Spawn one of a pack's overlays (by index into `pack.overlays`). */
export function spawnPackOverlay(pack: GamePackDef, index: number, opts: SpawnOverlayOptions = {}) {
	const composed = composePackOverlay(pack, index, {
		...opts,
		source: packSource(pack, opts.source)
	});
	if (!composed) return;
	gameStore.updateState({ overlays: { [composed.id]: composed.overlay } });
}

/**
 * Spawn a pack's full contents onto the table for an owner.
 * Packs are templates — this instantiates cards into the gameStore and never
 * mutates the pack itself. Facedown decks spawn shuffled (historical /play
 * behavior); scenario loads use spawnPackDeck directly with explicit order.
 */
export function spawnPack(pack: GamePackDef, opts: SpawnPackOptions = {}) {
	const ownerId = opts.ownerId ?? gameActions.getMyId();
	if (!ownerId) return console.error('Cannot spawn a pack without a playerId');

	pack.decks.forEach((deck, index) => {
		const isFaceUp = deck.isFaceUp ?? false;
		spawnPackDeck(pack, deck, { ...opts, ownerId, index, isFaceUp, shuffle: !isFaceUp });
	});
	pack.pieces?.forEach((_, index) => spawnPackPiece(pack, index, { ...opts, ownerId }));
	pack.overlays?.forEach((_, index) => spawnPackOverlay(pack, index, { ...opts, ownerId }));
}
