/**
 * Pure pack instantiation: a `GamePackDef` plus a placement in, `GameDTO`
 * entities out. No store, no Svelte, no DOM — `packs/spawn.ts` wraps these and
 * writes the result to the gameStore, `compose/scenario.ts` wraps them and
 * hands the result to whoever asked (a websocket seeder, a test).
 *
 * Packs are templates: nothing here mutates the pack it was handed.
 */

import { PIECE_REST_Y } from '../utils/constants-pieces';
import { composePiece, type Vec3 } from './piece';
import type { GamePackDef, PackDeckDef, PackPieceDef } from '../packs/types';
import type {
	BagItem,
	CardInDeck,
	DeckDTO,
	OverlayDTO,
	PackOrigin,
	PieceDTO
} from '../store/game/types';

export type { Vec3 };

/**
 * `seat0`…`seat3` → 0…3, and undefined for a real player id. Matched by shape
 * rather than imported from scenario.ts, which is the module that *defines*
 * the placeholders and already depends on this one.
 */
export function placeholderSeat(ownerId: string): number | undefined {
	const match = /^seat([0-3])$/.exec(ownerId);
	return match ? Number(match[1]) : undefined;
}

/**
 * The id a pack card is instantiated under, wherever it is instantiated: in a
 * pile (`composePackDeck`) or laid out loose (`spawnPackDeckSpread`). One
 * function because /create reads the grammar BACKWARDS — it turns the card its
 * cursors point at into the id to mark on the table (#109) — and a second copy
 * of the format would silently stop marking anything the day either moved.
 */
export function packCardId(ownerId: string, deckSlot: string, code: string): string {
	return `card:${ownerId}:${deckSlot}-${code}`;
}

/** Reorder in place, Fisher–Yates. The default for a `shuffleOnLoad` deck. */
export function shuffleInPlace<T>(cards: T[], random: () => number = Math.random): T[] {
	for (let i = cards.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[cards[i], cards[j]] = [cards[j], cards[i]];
	}
	return cards;
}

/**
 * How a caller shuffles. Injectable because the browser routes shuffling
 * through `gameActions.shuffleCards` (one shuffle implementation on the
 * client) and a headless composer has no actions object; a seeder that wants a
 * reproducible table passes a seeded generator.
 */
export type ShuffleFn = <T>(cards: T[]) => T[] | undefined | void | null;

/** Options shared by every pack composer. */
type CommonOptions = {
	/** entity owner — `seat0`…`seat3` for scenario content, a player id otherwise */
	ownerId: string;
	/**
	 * Already-resolved `packOrigin.source`: where this pack re-resolves from
	 * ('builtin' | 'local' | URL). Deciding it needs the browser's pack library,
	 * so it is the caller's answer, not this module's.
	 */
	source?: string;
};

function origin(pack: GamePackDef, content: string, source?: string): PackOrigin {
	return { pack: pack.id, content, ...(source ? { source } : {}) };
}

/** Mirrors addDeck's two-seat defaults, but keyed off the OWNER's seat. */
function deckDefaults(seat: number, index: number, isFaceUp: boolean) {
	const x = 8.5 + (isFaceUp ? 2 : 0) + index * 2.5;
	return seat % 2 === 1
		? { position: [x, 0.4, -4.7] as Vec3, rotation: [0, Math.PI, 0] as Vec3 }
		: { position: [x, 0.4, 4.5] as Vec3, rotation: [0, 0, 0] as Vec3 };
}

export type ComposeDeckOptions = CommonOptions & {
	/** the owner's seat; defaults to the `seatN` placeholder's index, else 0 */
	seat?: number;
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
	/** how to shuffle when `shuffle` is set; defaults to Fisher–Yates */
	shuffleWith?: ShuffleFn;
};

/**
 * Instantiate one of a pack's decks. Card ids are `card:<owner>:<slot>-<code>`
 * — the grammar `scenario.ts` reads back when it turns a deck into a placement.
 * Order and shuffling are the CALLER's choice (tbps v2 placements preserve
 * authored order; shuffling is opt-in), never implied.
 */
export function composePackDeck(
	pack: GamePackDef,
	deck: PackDeckDef,
	opts: ComposeDeckOptions
): { id: string; deck: Partial<DeckDTO> } {
	const defs = opts.order
		? opts.order
				.map((code) => {
					const def = deck.cards.find((c) => c.code === code);
					if (!def)
						console.warn(`[compose] unknown card code '${code}' in ${pack.id}/${deck.slot}`);
					return def;
				})
				.filter((def) => def !== undefined)
		: deck.cards;

	let cards: CardInDeck[] = defs.map((card) => ({
		id: packCardId(opts.ownerId, deck.slot, card.code),
		faceImageUrl: card.face,
		backImageUrl: deck.back,
		...(card.name ? { name: card.name } : {}),
		...(card.orientation === 'landscape' ? { orientation: card.orientation } : {})
	}));
	if (opts.shuffle) {
		const shuffle = opts.shuffleWith ?? shuffleInPlace;
		cards = (shuffle(cards) as CardInDeck[] | undefined | null) ?? cards;
	}

	const isFaceUp = opts.isFaceUp ?? deck.isFaceUp ?? false;
	const seat = opts.seat ?? placeholderSeat(opts.ownerId) ?? 0;
	const defaults = deckDefaults(seat, opts.index ?? 0, isFaceUp);
	const id = `deck:${opts.ownerId}:${deck.slot}`;
	return {
		id,
		deck: {
			id,
			isFaceUp,
			deckBackImageUrl: deck.back,
			cards,
			position: opts.position ?? defaults.position,
			rotation: opts.rotation ?? defaults.rotation,
			packOrigin: origin(pack, deck.slot, opts.source),
			...(opts.shuffleOnLoad !== undefined ? { shuffleOnLoad: opts.shuffleOnLoad } : {})
		}
	};
}

/**
 * A pack bag item and a live bag item are the same shape by design — the pack
 * says what is in the bag, the store holds that same list as the bag's state.
 * Cloned per spawn so two bags from one pack never share an array.
 */
function bagContents(def: PackPieceDef): BagItem[] {
	return (def.contents ?? []).map((item) => ({ ...item }) as BagItem);
}

export type ComposePackPieceOptions = CommonOptions & {
	/** the owner's seat; decides which way the pack's authored position mirrors */
	seat?: number;
	position?: Vec3;
	rotation?: Vec3;
	value?: number;
	/** multi-state pieces: which authored state to start on (default 0) */
	state?: number;
	/** piece ids already on the table, so a repeated name gets the next `-n` */
	taken?: ReadonlySet<string>;
};

/**
 * Instantiate one of a pack's pieces (by index into `pack.pieces`).
 * Returns undefined — after saying so — for an index the pack doesn't have.
 */
export function composePackPiece(
	pack: GamePackDef,
	index: number,
	opts: ComposePackPieceOptions
): { id: string; piece: Partial<PieceDTO> } | undefined {
	const def = pack.pieces?.[index];
	if (!def) {
		console.error(`[compose] ${pack.id} has no piece[${index}]`);
		return undefined;
	}

	// pack piece positions are authored for seat 0; mirror for the far side
	const seat = opts.seat ?? placeholderSeat(opts.ownerId) ?? 0;
	const m = seat % 2 === 1 ? -1 : 1;
	return composePiece(def.kind, {
		ownerId: opts.ownerId,
		taken: opts.taken,
		name: def.name,
		color: def.color,
		// states[0] IS the base face (see PackPieceDef.states), so a piece that
		// declares states never falls back to imageUrl
		imageUrl: def.states?.length ? def.states[0].face : def.imageUrl,
		states: def.states,
		// the placement's choice wins over the pack's own default
		state: opts.state ?? def.state,
		radius: def.radius,
		maxValue: def.maxValue,
		sides: def.sides,
		model: def.model,
		snap: def.snap,
		reach: def.reach,
		value: opts.value,
		...(def.kind === 'bag'
			? { contents: bagContents(def), drawMode: def.drawMode, infinite: def.infinite }
			: {}),
		position: opts.position ?? [def.position[0] * m, PIECE_REST_Y, def.position[1] * m],
		// the authored yaw is degrees in the piece's rotation[1] slot (see
		// applySnapRotation's conventions); mirrored seats add a half turn so a
		// section authored facing seat 0 faces its owner
		rotation:
			opts.rotation ??
			(def.rotation !== undefined ? [0, def.rotation + (m === -1 ? 180 : 0), 0] : undefined),
		packOrigin: origin(pack, String(index), opts.source)
	});
}

export type ComposeOverlayOptions = Omit<CommonOptions, 'ownerId'> & {
	/** accepted and ignored: overlays are table-scoped, keyed by pack */
	ownerId?: string;
	position?: Vec3;
	rotation?: Vec3;
	scale?: number;
};

/**
 * Instantiate one of a pack's overlays (by index into `pack.overlays`).
 * Table-scoped — `claimSeat` never renames an overlay, so its id is keyed by
 * pack rather than by owner.
 */
export function composePackOverlay(
	pack: GamePackDef,
	index: number,
	opts: ComposeOverlayOptions = {}
): { id: string; overlay: Partial<OverlayDTO> } | undefined {
	const def = pack.overlays?.[index];
	if (!def) {
		console.error(`[compose] ${pack.id} has no overlay[${index}]`);
		return undefined;
	}
	const id = `overlay:${pack.id}:${index}`;
	return {
		id,
		overlay: {
			id,
			imageUrl: def.imageUrl,
			ratio: def.ratio,
			scale: opts.scale ?? def.scale,
			position: opts.position ?? [0, 0.255, 0],
			rotation: opts.rotation ?? [0, 0, 0],
			packOrigin: origin(pack, String(index), opts.source)
		}
	};
}
