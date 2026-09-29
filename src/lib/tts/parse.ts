/**
 * Minimal Tabletop Simulator "Saved Object" parser — pure functions, no DOM.
 * Handles deck-builder exports (e.g. the-unmatched.club): an ObjectStates
 * array containing decks, loose cards, and objects we don't support yet.
 * See SPEC.md §1 and TTS_IMPORT_PLAN.md for the full-save roadmap.
 */

export type TtsSheet = {
	FaceURL: string;
	BackURL: string;
	NumWidth: number;
	NumHeight: number;
	UniqueBack?: boolean;
	BackIsHidden?: boolean;
};

type TtsObject = {
	Name?: string;
	Nickname?: string;
	CardID?: number;
	DeckIDs?: number[];
	CustomDeck?: Record<string, TtsSheet>;
	ContainedObjects?: TtsObject[];
	/**
	 * Alternate states, keyed by 1-based state number — the object itself
	 * occupies the number missing from the sequence. See `statesOrder`.
	 */
	States?: Record<string, TtsObject>;
	Transform?: { posX?: number; posY?: number; posZ?: number; scaleX?: number };
	ColorDiffuse?: { r?: number; g?: number; b?: number };
	CustomImage?: { ImageURL?: string };
	LuaScript?: string;
	/** container settings; `Order` is the LIFO/FIFO/Random draw order */
	Bag?: { Order?: number };
	/** cards/decks: the card rests turned 90° (our `orientation: 'landscape'`) */
	SidewaysCard?: boolean;
	/** pinned in place — our `locked`, one to one */
	Locked?: boolean;
};

export type SheetCell = { url: string; cols: number; rows: number; index: number };

export type ParsedCard = {
	name: string;
	face: SheetCell;
	/** whole image when cols/rows = 1, or a cell of a unique-back sheet */
	back: SheetCell;
	/** TTS `SidewaysCard` — the card rests turned 90° */
	sideways?: boolean;
};

export type ParsedDeck = { name: string; cards: ParsedCard[]; locked?: boolean };

/** One face of a multi-state piece, before face refs exist (see to-pack.ts). */
export type ParsedPieceState = {
	name: string;
	/** whole image (cols/rows = 1) or a sheet cell, exactly like a card face */
	face: SheetCell;
};

export type BagDrawMode = 'random' | 'lifo' | 'fifo';

/**
 * One thing inside a parsed bag. Cards keep their sheet cells, like
 * `ParsedCard` does — turning a cell into a `sheet:`/URL ref is `to-pack`'s
 * job, not the parser's.
 */
export type ParsedBagItem =
	| {
			kind: 'token' | 'pawn' | 'counter';
			name: string;
			color?: string;
			imageUrl?: string;
			radius?: number;
			maxValue?: number;
	  }
	| { kind: 'card'; name: string; face: SheetCell; back: SheetCell; sideways?: boolean };

export type ParsedPiece = {
	kind: 'token' | 'pawn' | 'counter' | 'bag';
	name: string;
	color?: string;
	imageUrl?: string;
	radius?: number;
	maxValue?: number;
	/** every face of a TTS `States` object, in state order; absent when single-state */
	states?: ParsedPieceState[];
	/** index into `states` the object was saved showing */
	state?: number;
	position: [number, number];
	/** bags only */
	contents?: ParsedBagItem[];
	drawMode?: BagDrawMode;
	infinite?: boolean;
	/** TTS `Locked` */
	locked?: boolean;
};

export type ParsedSavedObject = {
	decks: ParsedDeck[];
	looseCards: ParsedCard[];
	pieces: ParsedPiece[];
	/** Nicknames/types of objects not yet importable */
	skipped: string[];
};

/** Rewrite dead Steam host + force https (see MULTIPLAYER research: old host is gone) */
export function normalizeAssetUrl(url: string): string {
	return url
		.replace(
			/^https?:\/\/cloud-3\.steamusercontent\.com\//,
			'https://steamusercontent-a.akamaihd.net/'
		)
		.replace(/^http:\/\//, 'https://');
}

/** CardID encoding: sheetKey * 100 + cellIndex */
export function decodeCardId(cardId: number): { sheetKey: string; index: number } {
	return { sheetKey: String(Math.floor(cardId / 100)), index: cardId % 100 };
}

function cardFromId(
	cardId: number,
	customDeck: Record<string, TtsSheet> | undefined,
	name: string,
	sideways?: boolean
): ParsedCard | null {
	const { sheetKey, index } = decodeCardId(cardId);
	const sheet = customDeck?.[sheetKey];
	if (!sheet) return null;
	const face: SheetCell = {
		url: normalizeAssetUrl(sheet.FaceURL),
		cols: sheet.NumWidth,
		rows: sheet.NumHeight,
		index
	};
	const back: SheetCell = sheet.UniqueBack
		? { url: normalizeAssetUrl(sheet.BackURL), cols: sheet.NumWidth, rows: sheet.NumHeight, index }
		: { url: normalizeAssetUrl(sheet.BackURL), cols: 1, rows: 1, index: 0 };
	return { name, face, back, ...(sideways ? { sideways: true } : {}) };
}

function colorToHex(color?: { r?: number; g?: number; b?: number }): string | undefined {
	if (!color) return undefined;
	const channel = (v = 1) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** TTS health dials carry a counter Lua script; the max value is the HP */
export function extractCounterMax(luaScript?: string): number | null {
	const match = luaScript?.match(/MAX_VALUE\s*=\s*(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Put a `States` dict in state order, with `null` marking the object's own
 * slot.
 *
 * TTS keeps the ACTIVE state as the object itself and stores only the others
 * in `States`, keyed by 1-based state number — so the current state is the one
 * number missing from the `1..N` sequence, where N is `keys.length + 1`. That
 * rule (not a `CurrentState` field, which does not exist in saves) is the whole
 * trick to reading states, so it is exported and tested directly.
 *
 * Sparse or out-of-range keys degrade rather than throw: the smallest missing
 * number wins the object's slot, and the remaining keys fill the rest in
 * ascending order.
 */
export function statesOrder(keys: string[]): { order: (string | null)[]; current: number } {
	const sorted = [...keys].sort((a, b) => Number(a) - Number(b));
	const total = sorted.length + 1;
	const present = new Set(sorted);
	let current = total;
	for (let i = 1; i <= total; i++) {
		if (!present.has(String(i))) {
			current = i;
			break;
		}
	}
	const order: (string | null)[] = [];
	let next = 0;
	for (let i = 1; i <= total; i++) order.push(i === current ? null : sorted[next++]);
	return { order, current: current - 1 };
}

/** The image a state shows, if its object class carries one at all. */
function stateFace(obj: TtsObject): SheetCell | null {
	const url = obj.CustomImage?.ImageURL;
	if (url) return { url: normalizeAssetUrl(url), cols: 1, rows: 1, index: 0 };
	// Card / CardCustom: the face is a cell of the deck's sprite sheet
	if (obj.CardID !== undefined) {
		return cardFromId(obj.CardID, obj.CustomDeck, obj.Nickname ?? '')?.face ?? null;
	}
	return null;
}

/**
 * Faces of a multi-state object, one level deep (states-of-states and
 * `ContainedObjects` inside a state are out of scope).
 *
 * Only image-bearing states become faces; a state of another object class
 * (a model, a script-only object) has nothing to render, so it degrades to a
 * `skipped` note and is left out — never fatal, and the current-state index is
 * computed against what survives. Fewer than two surviving faces means the
 * object is not really multi-state, and no states are emitted.
 */
function pieceStates(
	obj: TtsObject,
	skipped: string[]
): { states?: ParsedPieceState[]; state?: number } {
	const keys = Object.keys(obj.States ?? {});
	if (keys.length === 0) return {};

	const { order, current } = statesOrder(keys);
	const states: ParsedPieceState[] = [];
	let state = 0;
	order.forEach((key, i) => {
		const source = key === null ? obj : (obj.States?.[key] ?? {});
		const name = source.Nickname || source.Name || `State ${i + 1}`;
		const face = stateFace(source);
		if (!face) {
			skipped.push(`${name} (state ${i + 1} of ${obj.Nickname || 'unnamed'})`);
			return;
		}
		if (i === current) state = states.length;
		states.push({ name, face });
	});

	return states.length > 1 ? { states, state } : {};
}

function pieceFrom(obj: TtsObject, skipped: string[]): ParsedPiece | null {
	const type = obj.Name ?? '';
	const name = obj.Nickname || type;
	const position: [number, number] = [obj.Transform?.posX ?? 0, -(obj.Transform?.posZ ?? 0)];
	const color = colorToHex(obj.ColorDiffuse);
	const scale = obj.Transform?.scaleX ?? 1;

	if (type === 'Custom_Tile') {
		const imageUrl = obj.CustomImage?.ImageURL
			? normalizeAssetUrl(obj.CustomImage.ImageURL)
			: undefined;
		return {
			kind: 'token',
			name,
			color,
			imageUrl,
			radius: Math.max(0.4, scale),
			...pieceStates(obj, skipped),
			position
		};
	}
	if (type === 'PlayerPawn') {
		return {
			kind: 'pawn',
			name,
			color,
			radius: Math.max(0.3, scale * 0.3),
			...pieceStates(obj, skipped),
			position
		};
	}
	if (type === 'Custom_Model') {
		const maxValue = extractCounterMax(obj.LuaScript);
		if (maxValue !== null) {
			return {
				kind: 'counter',
				name,
				color,
				radius: 0.6,
				maxValue,
				...pieceStates(obj, skipped),
				position
			};
		}
	}
	return null;
}

/** TTS container types: a plain bag, and one whose draws never run it down. */
const BAG_TYPES = new Set(['Bag', 'Infinite_Bag']);

/**
 * TTS stores a container's draw order as `Bag.Order`. The observed encoding is
 * 0 = Random, 1 = LIFO, 2 = FIFO; anything else (a version that adds a mode, a
 * hand-written save) falls back to random, which is both the TTS default and
 * the tbpp one. Never fatal — a wrong guess here costs a draw order, not an
 * import.
 */
export function bagDrawMode(order?: number): BagDrawMode {
	if (order === 1) return 'lifo';
	if (order === 2) return 'fifo';
	return 'random';
}

/**
 * One level of a bag's `ContainedObjects`. Cards and decks flatten into card
 * items (a deck in a bag is just more cards to draw); tiles, pawns and health
 * dials reuse the same mapping loose objects get. Anything else — including a
 * nested container — is left for `skipped`: deep recursion belongs to the
 * importer-envelope work, and dropping it silently would hide content loss.
 */
function bagItemsFrom(bag: TtsObject, skipped: string[]): ParsedBagItem[] {
	const items: ParsedBagItem[] = [];
	for (const child of bag.ContainedObjects ?? []) {
		const type = child.Name ?? 'Unknown';
		const name = child.Nickname || type;

		if ((type === 'Card' || type === 'CardCustom') && child.CardID !== undefined) {
			const card = cardFromId(
				child.CardID,
				child.CustomDeck,
				child.Nickname ?? '',
				child.SidewaysCard
			);
			if (card)
				items.push({
					kind: 'card',
					name: card.name,
					face: card.face,
					back: card.back,
					...(card.sideways ? { sideways: true } : {})
				});
			else skipped.push(`${name} (${type} in bag, unknown sheet)`);
			continue;
		}
		if (type === 'Deck' || type === 'DeckCustom') {
			const contained = child.ContainedObjects ?? [];
			const cards = (child.DeckIDs ?? [])
				.map((cardId, i) =>
					cardFromId(
						cardId,
						child.CustomDeck,
						contained[i]?.Nickname ?? '',
						// per-card flag first; the deck-level flag is TTS's whole-pile default
						contained[i]?.SidewaysCard ?? child.SidewaysCard
					)
				)
				.filter((card): card is ParsedCard => card !== null);
			for (const card of cards) {
				items.push({
					kind: 'card',
					name: card.name,
					face: card.face,
					back: card.back,
					...(card.sideways ? { sideways: true } : {})
				});
			}
			if (cards.length === 0) skipped.push(`${name} (${type} in bag, no readable cards)`);
			continue;
		}

		const piece = pieceFrom(child, skipped);
		if (piece && piece.kind !== 'bag') {
			// A bag item has no `states`: the format keeps a bag's contents one
			// level deep, and multi-state faces would be a second dimension of it.
			// The item still imports on its base face — but say so, rather than
			// letting the other faces disappear quietly.
			if (piece.states?.length) {
				skipped.push(`${piece.name} (${piece.states.length} states, in bag — base face kept)`);
			}
			// no position: it is meaningless inside a bag — the draw picks the spot
			items.push({
				kind: piece.kind,
				name: piece.name,
				...(piece.color !== undefined ? { color: piece.color } : {}),
				...(piece.imageUrl !== undefined ? { imageUrl: piece.imageUrl } : {}),
				...(piece.radius !== undefined ? { radius: piece.radius } : {}),
				...(piece.maxValue !== undefined ? { maxValue: piece.maxValue } : {})
			});
			continue;
		}
		skipped.push(`${name} (${type} in bag)`);
	}
	return items;
}

/** A TTS container → a bag piece, with its one level of contents. */
export function bagFrom(obj: TtsObject, skipped: string[]): ParsedPiece {
	const type = obj.Name ?? 'Bag';
	const color = colorToHex(obj.ColorDiffuse);
	return {
		kind: 'bag',
		name: obj.Nickname || type,
		...(color !== undefined ? { color } : {}),
		radius: Math.max(0.5, obj.Transform?.scaleX ?? 1),
		position: [obj.Transform?.posX ?? 0, -(obj.Transform?.posZ ?? 0)],
		contents: bagItemsFrom(obj, skipped),
		drawMode: bagDrawMode(obj.Bag?.Order),
		...(type === 'Infinite_Bag' ? { infinite: true } : {})
	};
}

/** TTS `Locked` maps straight onto ours; only a pinned object carries it */
function withLocked<T extends { locked?: boolean }>(parsed: T, obj: TtsObject): T {
	return obj.Locked ? { ...parsed, locked: true } : parsed;
}

export function parseSavedObject(json: unknown): ParsedSavedObject {
	const root = json as { ObjectStates?: TtsObject[] };
	const objects = Array.isArray(root?.ObjectStates) ? root.ObjectStates : [];
	const decks: ParsedDeck[] = [];
	const looseCards: ParsedCard[] = [];
	const pieces: ParsedPiece[] = [];
	const skipped: string[] = [];

	for (const obj of objects) {
		const type = obj.Name ?? 'Unknown';
		if (type === 'Deck' || type === 'DeckCustom') {
			const ids = obj.DeckIDs ?? [];
			const contained = obj.ContainedObjects ?? [];
			const cards = ids
				.map((id, i) =>
					cardFromId(
						id,
						obj.CustomDeck,
						contained[i]?.Nickname ?? '',
						// per-card flag first; the deck-level flag is TTS's whole-pile default
						contained[i]?.SidewaysCard ?? obj.SidewaysCard
					)
				)
				.filter((c): c is ParsedCard => c !== null);
			decks.push({
				name: obj.Nickname || `Deck ${decks.length + 1}`,
				cards,
				...(obj.Locked ? { locked: true } : {})
			});
		} else if ((type === 'Card' || type === 'CardCustom') && obj.CardID !== undefined) {
			const card = cardFromId(obj.CardID, obj.CustomDeck, obj.Nickname ?? '', obj.SidewaysCard);
			if (card) looseCards.push(card);
		} else if (BAG_TYPES.has(type)) {
			// a bag always imports, even if every child is unsupported: the empty
			// bag is still the object the author placed, and its children are named
			// in `skipped` rather than lost quietly
			pieces.push(withLocked(bagFrom(obj, skipped), obj));
		} else {
			const piece = pieceFrom(obj, skipped);
			if (piece) pieces.push(withLocked(piece, obj));
			else skipped.push(`${obj.Nickname || 'unnamed'} (${type})`);
		}
	}

	return { decks, looseCards, pieces, skipped };
}
