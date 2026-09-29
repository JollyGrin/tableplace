/**
 * A pack is a named, serializable definition of a game's contents —
 * decoupled from live game state. Packs are templates; the gameStore
 * holds the instance. See SPEC.md §4d.
 */

// relative, not `$lib`: these types are a schema-generation root
// (scripts/build-schemas.ts), and that program is compiled without the
// SvelteKit path aliases
import type { DieSides } from '../store/game/types';

/**
 * Which way a card rests when squared up. `'landscape'` cards (e.g. Sorcery
 * TCG sites) render turned 90° everywhere — board, hand, preview — while the
 * persisted rotation state stays orientation-relative, so tap/flip/snap logic
 * never sees the extra quarter turn. Absent means `'portrait'`.
 */
export type CardOrientation = 'portrait' | 'landscape';

export type PackCardDef = {
	/** Stable code within the pack, e.g. 'AS' (ace of spades) */
	code: string;
	name?: string;
	/** Face ref: https url, `sheet:` descriptor, or `gen:` scheme */
	face: string;
	/** default resting orientation; absent = 'portrait' (TTS analog: SidewaysCard) */
	orientation?: CardOrientation;
};

export type PackDeckDef = {
	/** Stable id within the pack, e.g. 'main', 'discard' */
	slot: string;
	name: string;
	/** Face ref for the card back */
	back: string;
	isFaceUp?: boolean;
	/**
	 * Spawns pinned in place (TTS `Locked`): the pile can't be moved, flipped or
	 * ungrouped, but cards still come off its top. `L` unpins it at the table.
	 * Omitted means unlocked.
	 */
	locked?: boolean;
	cards: PackCardDef[];
};

export type PackPieceKind = 'token' | 'pawn' | 'counter' | 'die' | 'bag' | 'model';

/** Order a bag hands its contents out in. TTS analog: the container's Order. */
export type PackBagDrawMode = 'random' | 'lifo' | 'fifo';

/**
 * A piece inside a bag — a `PackPieceDef` without the table position, because
 * a draw is what decides where it lands. Nested bags are deliberately absent:
 * a bag's contents are one level deep.
 */
export type PackBagPieceItem = {
	kind: 'token' | 'pawn' | 'counter';
	name: string;
	/** hex tint; pawns/counters without images render in this color */
	color?: string;
	imageUrl?: string;
	radius?: number;
	/** counters draw at this value */
	maxValue?: number;
};

/** A card inside a bag: the same face-ref grammar cards use, plus its own back. */
export type PackBagCardItem = {
	kind: 'card';
	/** stable id within the bag — the drawn card's entity id is built from it */
	code: string;
	name?: string;
	/** Face ref: https url, `sheet:` descriptor, or `gen:` scheme */
	face: string;
	back?: string;
	/** default resting orientation; absent = 'portrait' */
	orientation?: CardOrientation;
};

/** One thing inside a bag, discriminated on `kind` like pieces are. */
export type PackBagItemDef = PackBagPieceItem | PackBagCardItem;

/**
 * One alternate face of a multi-state piece (the TTS `States` analog: a
 * double-sided tile, an upgrade token, a transformed piece).
 */
export type PackPieceStateDef = {
	/** Face ref: https url, `sheet:` descriptor, or `gen:` scheme */
	face: string;
	/** shown on hover and in the state menu, e.g. 'Damaged' */
	name?: string;
};

export type PackPieceDef = {
	kind: PackPieceKind;
	name: string;
	/** hex tint; pawns/counters/dice without images render in this color */
	color?: string;
	/** token top-face image ref (resolved like card faces) */
	imageUrl?: string;
	/**
	 * Alternate faces the piece can be cycled through in play.
	 *
	 * **`states[0]` is the base face** — the list is the piece's COMPLETE set of
	 * faces, not extra ones added to `imageUrl`. A piece with `states` renders
	 * `states[n].face` and starts at n = 0 (a scenario placement can start it
	 * elsewhere); `imageUrl` is then only a fallback for consumers that ignore
	 * states, and exporters write it equal to `states[0].face`.
	 *
	 * Orthogonal to `kind: 'die'`: a die's faces are procedural geometry, not
	 * images, so it is never a stateful piece and carries no `states`.
	 */
	states?: PackPieceStateDef[];
	/**
	 * Index into `states` the piece spawns showing (default 0). This is the
	 * pack's own default — a TTS import puts the state the mod was saved in
	 * here; a scenario placement's `state` overrides it.
	 */
	state?: number;
	/** world radius of the piece footprint (a die's circumradius) */
	radius?: number;
	/** counters start at this value */
	maxValue?: number;
	/** dice only: how many faces the die has (defaults to 6) */
	sides?: DieSides;
	/**
	 * models only — a `model:<kit>/<name>` catalog ref (the fourth face-ref
	 * scheme). Resolved through the catalog manifest at render time; the pack
	 * carries only the string.
	 */
	model?: string;
	/** table-plane position [x, z] in world units */
	position: [number, number];
	/**
	 * Table yaw in degrees (the piece DTO's `rotation[1]`). Optional and 0 when
	 * absent — added for model sections, honoured for every kind.
	 */
	rotation?: number;
	/**
	 * Whether snap points (and grids) pull this piece's drops. Default `true`;
	 * `false` is the per-piece opt-out — a big room section should snap to the
	 * grid, a loose prop shouldn't.
	 */
	snap?: boolean;
	/**
	 * How many snap-point links this piece usually travels. Advisory: lifted
	 * off a linked snap point, the points within `reach` links glow brighter.
	 * Nothing is blocked. A non-negative whole number; omitted means none.
	 */
	reach?: number;
	/**
	 * Spawns pinned in place (TTS `Locked`) — a board, a fixed track: it can't
	 * be dragged or turned, but still counts, rolls or hands things out. `L`
	 * unpins it at the table. Omitted means unlocked.
	 */
	locked?: boolean;
	/** bags only — what a draw pulls out. Hidden from every player in play. */
	contents?: PackBagItemDef[];
	/** bags only — draw order; defaults to `'random'` */
	drawMode?: PackBagDrawMode;
	/** bags only — a draw clones the item instead of removing it (TTS Infinite_Bag) */
	infinite?: boolean;
};

export type PackOverlayDef = {
	/** board/map image ref */
	imageUrl: string;
	/** width / height of the image */
	ratio: number;
	scale: number;
	/** spawns pinned in place (TTS `Locked`); omitted means unlocked */
	locked?: boolean;
};

export type GamePackDef = {
	id: string;
	name: string;
	/**
	 * 'table' = the shared game, loaded once per lobby by the host (TTS analog: the mod/save).
	 * 'player' = what one player brings, spawned per seat (TTS analog: a Saved Object, e.g. a deck-builder export).
	 */
	scope: 'table' | 'player';
	decks: PackDeckDef[];
	/** tokens/pawns/counters/dice that spawn with the pack */
	pieces?: PackPieceDef[];
	/** board/map images laid on the table */
	overlays?: PackOverlayDef[];
	/** provenance: set by converters (e.g. the TTS importer), absent on native packs */
	source?: 'tts';
};
