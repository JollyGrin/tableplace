/**
 * The /create editor binds tweakpane controls directly to a `GamePackDef`
 * draft, so every optional field needs a concrete value while editing —
 * and empty editing defaults must not leak into exported files (the tbpp
 * validator rejects empty strings). These two functions are that boundary.
 */

import type {
	CardOrientation,
	GamePackDef,
	PackBagDrawMode,
	PackBagItemDef,
	PackCardDef,
	PackDeckDef,
	PackOverlayDef,
	PackPieceDef
} from '$lib/packs/types';
import { PIECE_RADIUS, COUNTER_MAX_DEFAULT, DIE_SIDES_DEFAULT } from '$lib/utils/constants-pieces';
import { CARD_BACK_DEFAULT } from '$lib/packs/standard52';

export const PIECE_COLOR_DEFAULT = '#c8c4b8';

/** A `GamePackDef` with every pane-bound optional field made concrete */
export type EditorCard = PackCardDef & { name: string; orientation: CardOrientation };
export type EditorDeck = Omit<PackDeckDef, 'cards' | 'isFaceUp'> & {
	isFaceUp: boolean;
	cards: EditorCard[];
};
export type EditorPieceState = { face: string; name: string };

/**
 * A bag item flattened for the pane: every field of both item shapes, always
 * present, with `kind` deciding which ones matter. `PackBagItemDef` is a union,
 * and tweakpane binds to a fixed set of properties — a union would mean
 * rebuilding the blades (and losing whatever was typed) on every kind switch.
 * `cleanForExport` narrows it back to the union.
 */
export type EditorBagItem = {
	kind: PackBagItemDef['kind'];
	name: string;
	color: string;
	imageUrl: string;
	radius: number;
	maxValue: number;
	/** card items only */
	code: string;
	face: string;
	back: string;
	orientation: CardOrientation;
};

export type EditorPiece = Omit<
	PackPieceDef,
	'states' | 'contents' | 'drawMode' | 'infinite' | 'snap' | 'model' | 'rotation'
> & {
	color: string;
	imageUrl: string;
	/** models only — the `model:<kit>/<name>` catalog ref */
	model: string;
	radius: number;
	maxValue: number;
	states: EditorPieceState[];
	state: number;
	contents: EditorBagItem[];
	drawMode: PackBagDrawMode;
	infinite: boolean;
	snap: boolean;
	/** snap-point links it usually travels; 0 is "none" and stays out of the file */
	reach: number;
	/** table yaw in degrees; 0 is the default and stays out of the file */
	rotation: number;
};
export type EditorPack = Omit<GamePackDef, 'decks' | 'pieces' | 'overlays'> & {
	decks: EditorDeck[];
	pieces: EditorPiece[];
	overlays: PackOverlayDef[];
};

/** The editor shape of one bag item, whichever half of the union it came from. */
export function withBagItemDefaults(item: PackBagItemDef): EditorBagItem {
	const shared = {
		kind: item.kind,
		name: item.name ?? '',
		code: '',
		face: CARD_BACK_DEFAULT,
		back: '',
		orientation: 'portrait' as CardOrientation
	};
	if (item.kind === 'card') {
		return {
			...shared,
			color: PIECE_COLOR_DEFAULT,
			imageUrl: '',
			radius: PIECE_RADIUS.token,
			maxValue: COUNTER_MAX_DEFAULT,
			code: item.code,
			face: item.face,
			back: item.back ?? '',
			orientation: item.orientation ?? 'portrait'
		};
	}
	return {
		...shared,
		color: item.color ?? PIECE_COLOR_DEFAULT,
		imageUrl: item.imageUrl ?? '',
		radius: item.radius ?? PIECE_RADIUS[item.kind],
		maxValue: item.maxValue ?? COUNTER_MAX_DEFAULT
	};
}

/** Deep-clone a pack and fill every optional field the editor binds to. */
export function withEditorDefaults(pack: GamePackDef): EditorPack {
	return {
		...pack,
		decks: pack.decks.map((deck) => ({
			...deck,
			isFaceUp: deck.isFaceUp ?? false,
			cards: deck.cards.map((card) => ({
				...card,
				name: card.name ?? '',
				orientation: card.orientation ?? 'portrait'
			}))
		})),
		pieces: (pack.pieces ?? []).map((piece) => ({
			...piece,
			color: piece.color ?? PIECE_COLOR_DEFAULT,
			imageUrl: piece.imageUrl ?? '',
			model: piece.model ?? '',
			rotation: piece.rotation ?? 0,
			radius: piece.radius ?? PIECE_RADIUS[piece.kind],
			maxValue: piece.maxValue ?? COUNTER_MAX_DEFAULT,
			states: (piece.states ?? []).map((state) => ({ face: state.face, name: state.name ?? '' })),
			state: piece.state ?? 0,
			sides: piece.sides ?? DIE_SIDES_DEFAULT,
			contents: (piece.contents ?? []).map(withBagItemDefaults),
			drawMode: piece.drawMode ?? 'random',
			infinite: piece.infinite ?? false,
			snap: piece.snap ?? true,
			reach: piece.reach ?? 0,
			position: [...piece.position] as [number, number]
		})),
		overlays: (pack.overlays ?? []).map((overlay) => ({ ...overlay }))
	};
}

/**
 * Narrow one flat editor bag item back to the exported union: a card keeps the
 * face-ref fields, anything else keeps the piece fields, and neither ships the
 * other's leftovers.
 */
function cleanBagItem(item: PackBagItemDef | EditorBagItem): PackBagItemDef {
	const editor = item as EditorBagItem;
	if (item.kind === 'card') {
		return {
			kind: 'card',
			code: editor.code,
			...(editor.name ? { name: editor.name } : {}),
			face: editor.face,
			...(editor.back ? { back: editor.back } : {}),
			// 'portrait' is the default, so it stays out of the file
			...(editor.orientation === 'landscape' ? { orientation: 'landscape' } : {})
		};
	}
	return {
		kind: item.kind,
		name: editor.name,
		...(editor.color ? { color: editor.color } : {}),
		...(editor.imageUrl ? { imageUrl: editor.imageUrl } : {}),
		...(editor.radius !== undefined ? { radius: editor.radius } : {}),
		...(item.kind === 'counter' && editor.maxValue !== undefined
			? { maxValue: editor.maxValue }
			: {})
	};
}

/**
 * Deep-clone a draft, dropping empty editing defaults so the exported file
 * only carries what the creator actually set (`maxValue` is meaningful on
 * counters only, an unset image URL must not ship as `""`). Kept dumb on
 * purpose — real validation is parsePackFile's job.
 */
export function cleanForExport(draft: GamePackDef): GamePackDef {
	const pieces = (draft.pieces ?? []).map((piece) => {
		// a state with no face is an empty editor row, not authoring intent.
		// Never on a die or a bag: a die's faces are procedural and a bag's is a
		// pouch, so `states` on either is a category error and must not reach the
		// file (see PackPieceDef.states, and `buildPiece`, which drops them at
		// spawn for the same reason).
		const states =
			piece.kind === 'die' || piece.kind === 'bag'
				? []
				: (piece.states ?? [])
						.filter((state) => state.face)
						.map((state) => ({ face: state.face, ...(state.name ? { name: state.name } : {}) }));
		// states[0] IS the base face (see PackPieceDef.states), so imageUrl mirrors
		// it — a consumer that ignores states still shows the right image
		const imageUrl = states[0]?.face ?? piece.imageUrl;
		return {
			kind: piece.kind,
			name: piece.name,
			...(piece.color ? { color: piece.color } : {}),
			...(imageUrl ? { imageUrl } : {}),
			...(states.length ? { states } : {}),
			// 0 is the default, so it stays out of the file
			...(states.length && piece.state ? { state: piece.state } : {}),
			...(piece.radius !== undefined ? { radius: piece.radius } : {}),
			...(piece.kind === 'counter' && piece.maxValue !== undefined
				? { maxValue: piece.maxValue }
				: {}),
			...(piece.kind === 'die' && piece.sides !== undefined ? { sides: piece.sides } : {}),
			// bag fields ship on bags only — a token that was switched to a bag and
			// back must not export the contents it briefly had
			...(piece.kind === 'bag'
				? {
						contents: (piece.contents ?? []).map(cleanBagItem),
						drawMode: piece.drawMode ?? 'random',
						...(piece.infinite ? { infinite: true } : {})
					}
				: {}),
			// the catalog ref ships on models only — a token that was briefly
			// switched to a model and back must not export a stray ref
			...(piece.kind === 'model' && piece.model ? { model: piece.model } : {}),
			// true is the default, so only the opt-out ships
			...(piece.snap === false ? { snap: false } : {}),
			// 0 is "no reach rings", so only a real reach ships
			...(piece.reach && piece.reach > 0 ? { reach: Math.round(piece.reach) } : {}),
			position: [...piece.position] as [number, number],
			// 0 is the default, so only a real yaw ships
			...(piece.rotation ? { rotation: piece.rotation } : {})
		};
	});
	const overlays = (draft.overlays ?? []).map((overlay) => ({ ...overlay }));

	return {
		id: draft.id,
		name: draft.name,
		scope: draft.scope,
		decks: draft.decks.map((deck) => ({
			slot: deck.slot,
			name: deck.name,
			back: deck.back,
			...(deck.isFaceUp ? { isFaceUp: true } : {}),
			cards: deck.cards.map((card) => ({
				code: card.code,
				...(card.name ? { name: card.name } : {}),
				face: card.face,
				// 'portrait' is the default, so it stays out of the file
				...(card.orientation === 'landscape' ? { orientation: 'landscape' as const } : {})
			}))
		})),
		...(pieces.length > 0 ? { pieces } : {}),
		...(overlays.length > 0 ? { overlays } : {}),
		...(draft.source ? { source: draft.source } : {})
	};
}
