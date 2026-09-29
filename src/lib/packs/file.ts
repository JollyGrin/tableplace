/**
 * tbpp — the table.place pack file format. See docs/packs.md.
 *
 * A pack file is a `GamePackDef` plus an in-band discriminator `"tbpp": 1`.
 * Files are named `<name>.tbpp.json` — plain JSON to every tool, and the
 * discriminator (not the filename) is what identifies the format, so files
 * survive renaming and piping.
 */

import type {
	CardOrientation,
	GamePackDef,
	PackBagCardItem,
	PackBagDrawMode,
	PackBagItemDef,
	PackBagPieceItem,
	PackDeckDef,
	PackCardDef,
	PackPieceDef,
	PackPieceStateDef,
	PackOverlayDef
} from './types';
import { assertReadableSpecVersion, PACK_SPEC_VERSION } from '../formats/spec-version';

export const TBPP_VERSION = 1;
export const PACK_SCHEMA_URL = 'https://table.place/pack.schema.json';

/** The on-disk shape of a `.tbpp.json` file. */
export type PackFile = GamePackDef & {
	/** format discriminator + version */
	tbpp: 1;
	/** optional editor-validation hint; always written on export */
	$schema?: string;
	/**
	 * Semver of the pack spec this document was authored against. Always
	 * written on export; optional on read so files predating spec versioning
	 * still validate and still import.
	 */
	specVersion?: string;
};

export function packFileName(pack: GamePackDef): string {
	return `${pack.name}.tbpp.json`;
}

/** Serialize a pack for download as `<name>.tbpp.json`. */
export function serializePackFile(pack: GamePackDef): string {
	const file: PackFile = {
		$schema: PACK_SCHEMA_URL,
		tbpp: TBPP_VERSION,
		specVersion: PACK_SPEC_VERSION,
		...pack
	};
	return JSON.stringify(file, null, '\t');
}

class ParseError extends Error {}

function fail(path: string, expected: string): never {
	throw new ParseError(`${path} ${expected}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
	if (typeof v !== 'string' || v === '') fail(path, 'must be a non-empty string');
	return v;
}

function num(v: unknown, path: string): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a number');
	return v;
}

function arr(v: unknown, path: string): unknown[] {
	if (!Array.isArray(v)) fail(path, 'must be an array');
	return v;
}

/** Exported so llms-txt.ts can render this list in prose instead of hand-writing it. */
export const CARD_ORIENTATIONS = ['portrait', 'landscape'] as const;

function orientation(v: unknown, path: string): CardOrientation {
	const value = v as CardOrientation;
	if (!CARD_ORIENTATIONS.includes(value)) {
		fail(path, `must be one of ${CARD_ORIENTATIONS.join(', ')}`);
	}
	return value;
}

function parseCard(v: unknown, path: string): PackCardDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	const card: PackCardDef = {
		code: str(v.code, `${path}.code`),
		face: str(v.face, `${path}.face`)
	};
	if (v.name !== undefined) card.name = str(v.name, `${path}.name`);
	if (v.orientation !== undefined) {
		card.orientation = orientation(v.orientation, `${path}.orientation`);
	}
	return card;
}

function parseDeck(v: unknown, path: string): PackDeckDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	const deck: PackDeckDef = {
		slot: str(v.slot, `${path}.slot`),
		name: str(v.name, `${path}.name`),
		back: str(v.back, `${path}.back`),
		cards: arr(v.cards, `${path}.cards`).map((c, i) => parseCard(c, `${path}.cards[${i}]`))
	};
	if (v.isFaceUp !== undefined) deck.isFaceUp = Boolean(v.isFaceUp);
	return deck;
}

/** Exported so llms-txt.ts can render this list in prose instead of hand-writing it. */
export const PIECE_KINDS = ['token', 'pawn', 'counter', 'die', 'bag', 'model'] as const;
const DIE_SIDES = [4, 6, 8, 10, 12, 20] as const;
/**
 * What a bag may contain: the piece kinds that are just an image and a name,
 * plus cards. No `bag` (containers don't nest) and no `die` — a die's shape and
 * roll state have nowhere to live in an item, so a bag is not where one goes.
 *
 * Exported so llms-txt.ts can render this list in prose instead of hand-writing it.
 */
export const BAG_ITEM_KINDS = ['token', 'pawn', 'counter', 'card'] as const;
/** Exported so llms-txt.ts can render this list in prose instead of hand-writing it. */
export const BAG_DRAW_MODES = ['random', 'lifo', 'fifo'] as const;

/**
 * One entry of a bag's `contents`. A `card` item carries the face-ref grammar;
 * anything else is a piece minus its table position. `bag` is rejected here on
 * purpose — nested containers are a separate piece of work (see docs/packs.md).
 */
function parseBagItem(v: unknown, path: string): PackBagItemDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	const kind = v.kind as PackBagItemDef['kind'];
	if (!BAG_ITEM_KINDS.includes(kind)) {
		fail(`${path}.kind`, `must be one of ${BAG_ITEM_KINDS.join(', ')}`);
	}
	if (kind === 'card') {
		const card: PackBagCardItem = {
			kind,
			code: str(v.code, `${path}.code`),
			face: str(v.face, `${path}.face`)
		};
		if (v.name !== undefined) card.name = str(v.name, `${path}.name`);
		if (v.back !== undefined) card.back = str(v.back, `${path}.back`);
		if (v.orientation !== undefined) {
			card.orientation = orientation(v.orientation, `${path}.orientation`);
		}
		return card;
	}
	const item: PackBagPieceItem = { kind, name: str(v.name, `${path}.name`) };
	if (v.color !== undefined) item.color = str(v.color, `${path}.color`);
	if (v.imageUrl !== undefined) item.imageUrl = str(v.imageUrl, `${path}.imageUrl`);
	if (v.radius !== undefined) item.radius = num(v.radius, `${path}.radius`);
	if (v.maxValue !== undefined) item.maxValue = num(v.maxValue, `${path}.maxValue`);
	return item;
}

function parsePieceState(v: unknown, path: string): PackPieceStateDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	const state: PackPieceStateDef = { face: str(v.face, `${path}.face`) };
	if (v.name !== undefined) state.name = str(v.name, `${path}.name`);
	return state;
}

function parsePiece(v: unknown, path: string): PackPieceDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	const kind = v.kind as PackPieceDef['kind'];
	if (!PIECE_KINDS.includes(kind)) fail(`${path}.kind`, `must be one of ${PIECE_KINDS.join(', ')}`);
	const pos = arr(v.position, `${path}.position`);
	if (pos.length !== 2) fail(`${path}.position`, 'must be [x, z]');
	const piece: PackPieceDef = {
		kind,
		name: str(v.name, `${path}.name`),
		position: [num(pos[0], `${path}.position[0]`), num(pos[1], `${path}.position[1]`)]
	};
	if (v.color !== undefined) piece.color = str(v.color, `${path}.color`);
	if (v.imageUrl !== undefined) piece.imageUrl = str(v.imageUrl, `${path}.imageUrl`);
	// like every face ref, a model ref is only checked for being a non-empty
	// string — the catalog manifest is where an unknown ref becomes visible
	if (v.model !== undefined) piece.model = str(v.model, `${path}.model`);
	if (v.rotation !== undefined) piece.rotation = num(v.rotation, `${path}.rotation`);
	if (v.states !== undefined) {
		piece.states = arr(v.states, `${path}.states`).map((s, i) =>
			parsePieceState(s, `${path}.states[${i}]`)
		);
	}
	if (v.state !== undefined) {
		const state = num(v.state, `${path}.state`);
		if (!Number.isInteger(state) || state < 0) {
			fail(`${path}.state`, 'must be a state index (a non-negative integer)');
		}
		piece.state = state;
	}
	if (v.radius !== undefined) piece.radius = num(v.radius, `${path}.radius`);
	if (v.maxValue !== undefined) piece.maxValue = num(v.maxValue, `${path}.maxValue`);
	if (v.sides !== undefined) {
		const sides = num(v.sides, `${path}.sides`) as PackPieceDef['sides'];
		if (!DIE_SIDES.includes(sides as (typeof DIE_SIDES)[number])) {
			fail(`${path}.sides`, `must be one of ${DIE_SIDES.join(', ')}`);
		}
		piece.sides = sides;
	}
	// bag fields are validated wherever they appear rather than only on bags: a
	// stray `contents` on a token is an authoring mistake worth naming, and
	// silently dropping it would hide it
	if (v.contents !== undefined) {
		piece.contents = arr(v.contents, `${path}.contents`).map((item, i) =>
			parseBagItem(item, `${path}.contents[${i}]`)
		);
	}
	if (v.drawMode !== undefined) {
		const mode = v.drawMode as PackBagDrawMode;
		if (!BAG_DRAW_MODES.includes(mode)) {
			fail(`${path}.drawMode`, `must be one of ${BAG_DRAW_MODES.join(', ')}`);
		}
		piece.drawMode = mode;
	}
	if (v.infinite !== undefined) piece.infinite = Boolean(v.infinite);
	if (v.snap !== undefined) piece.snap = Boolean(v.snap);
	if (v.reach !== undefined) {
		const reach = num(v.reach, `${path}.reach`);
		if (!Number.isInteger(reach) || reach < 0) fail(`${path}.reach`, 'must be a whole number ≥ 0');
		piece.reach = reach;
	}
	return piece;
}

function parseOverlay(v: unknown, path: string): PackOverlayDef {
	if (!isRecord(v)) fail(path, 'must be an object');
	return {
		imageUrl: str(v.imageUrl, `${path}.imageUrl`),
		ratio: num(v.ratio, `${path}.ratio`),
		scale: num(v.scale, `${path}.scale`)
	};
}

/**
 * Parse + validate a `.tbpp.json` file. Throws an Error with a
 * human-readable message pointing at the offending field.
 */
export function parsePackFile(text: string): GamePackDef {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ParseError('Not valid JSON');
	}
	if (!isRecord(raw)) throw new ParseError('Not a pack file: expected a JSON object');
	if (raw.tbpp === undefined) {
		throw new ParseError('Not a table.place pack: missing the `"tbpp": 1` marker');
	}
	if (raw.tbpp !== TBPP_VERSION) {
		throw new ParseError(
			`Unsupported pack version ${JSON.stringify(raw.tbpp)} — this app reads tbpp ${TBPP_VERSION}`
		);
	}
	// validate against what the DOCUMENT declares, not against our own version
	assertReadableSpecVersion(raw.specVersion, PACK_SPEC_VERSION, 'pack');

	const scope = raw.scope;
	if (scope !== 'table' && scope !== 'player') fail('scope', `must be 'table' or 'player'`);

	const pack: GamePackDef = {
		id: str(raw.id, 'id'),
		name: str(raw.name, 'name'),
		scope,
		decks: arr(raw.decks, 'decks').map((d, i) => parseDeck(d, `decks[${i}]`))
	};
	if (raw.pieces !== undefined) {
		pack.pieces = arr(raw.pieces, 'pieces').map((p, i) => parsePiece(p, `pieces[${i}]`));
	}
	if (raw.overlays !== undefined) {
		pack.overlays = arr(raw.overlays, 'overlays').map((o, i) => parseOverlay(o, `overlays[${i}]`));
	}
	if (raw.source === 'tts') pack.source = 'tts';
	return pack;
}
