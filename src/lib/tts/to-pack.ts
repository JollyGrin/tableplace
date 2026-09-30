/**
 * TTS parse output → native `GamePackDef`. TTS is an import boundary, not a
 * superset spec: every TTS concept maps into pack primitives here, and TTS
 * fields (CardID math, sprite sheets as first-class objects, Lua) never
 * appear in the tbpp format itself. See docs/packs.md.
 */

import type { GamePackDef, PackBagItemDef, PackDeckDef, PackPieceDef } from '$lib/packs/types';
import { CARD_BACK_DEFAULT } from '$lib/packs/standard52';
import { makeSheetRef } from '$lib/packs/resolve.svelte';
import type { ParsedBagItem, ParsedSavedObject, ParsedCard, SheetCell } from './parse';

export type TtsToPackOptions = {
	id?: string;
	name?: string;
	/** override the lone-deck-means-player heuristic (SPEC §4d) */
	scope?: GamePackDef['scope'];
};

function slugify(name: string, fallback: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || fallback;
}

/** Whole-image cells become plain URLs; real sheet cells become `sheet:` refs. */
export function cellToRef(cell: SheetCell, opts: { name?: string; back?: boolean } = {}): string {
	if (cell.cols === 1 && cell.rows === 1) return cell.url;
	return makeSheetRef({ ...cell, ...opts });
}

function toDeck(
	name: string,
	cards: ParsedCard[],
	slotFallback: string,
	isFaceUp?: boolean,
	locked?: boolean
): PackDeckDef {
	const seen = new Set<string>();
	return {
		slot: slugify(name, slotFallback),
		name,
		back: cards[0] ? cellToRef(cards[0].back, { back: true }) : CARD_BACK_DEFAULT,
		...(isFaceUp !== undefined ? { isFaceUp } : {}),
		// TTS Locked → pinned in place
		...(locked ? { locked: true } : {}),
		cards: cards.map((card, i) => {
			let code = slugify(card.name, `card-${i}`);
			if (seen.has(code)) code = `${code}-${i}`;
			seen.add(code);
			return {
				code,
				...(card.name ? { name: card.name } : {}),
				face: cellToRef(card.face, { name: card.name }),
				// TTS SidewaysCard → the pack's per-card default orientation
				...(card.sideways ? { orientation: 'landscape' as const } : {})
			};
		})
	};
}

/**
 * A parsed bag's contents → pack bag items. Card items are where the sheet
 * cells become refs; `code` is minted from the name the same way a deck's card
 * codes are, and deduped for the same reason (a drawn card's entity id is built
 * from it).
 */
function toBagContents(items: ParsedBagItem[]): PackBagItemDef[] {
	const seen = new Set<string>();
	return items.map((item, i) => {
		// spelled out rather than spread, matching the pieces mapping below: an
		// `undefined` color would survive a spread and ship as a key
		if (item.kind !== 'card') {
			return {
				kind: item.kind,
				name: item.name,
				...(item.color !== undefined ? { color: item.color } : {}),
				...(item.imageUrl !== undefined ? { imageUrl: item.imageUrl } : {}),
				...(item.radius !== undefined ? { radius: item.radius } : {}),
				...(item.maxValue !== undefined ? { maxValue: item.maxValue } : {}),
				...(item.minValue !== undefined ? { minValue: item.minValue } : {})
			};
		}
		let code = slugify(item.name, `item-${i}`);
		if (seen.has(code)) code = `${code}-${i}`;
		seen.add(code);
		return {
			kind: 'card',
			code,
			...(item.name ? { name: item.name } : {}),
			face: cellToRef(item.face, { name: item.name }),
			back: cellToRef(item.back, { back: true }),
			...(item.sideways ? { orientation: 'landscape' as const } : {})
		};
	});
}

/**
 * Convert a parsed TTS Saved Object into a native pack. Loose cards group
 * into a face-up 'loose' deck (a pile is the closest pack primitive);
 * unsupported objects stay behind in `parsed.skipped` — conversion never
 * fails on them.
 */
export function ttsToPack(parsed: ParsedSavedObject, opts: TtsToPackOptions = {}): GamePackDef {
	const name = opts.name ?? parsed.decks[0]?.name ?? 'TTS Import';
	const decks = parsed.decks.map((deck, i) =>
		toDeck(deck.name, deck.cards, `deck-${i}`, undefined, deck.locked)
	);
	if (parsed.looseCards.length > 0) {
		decks.push(toDeck('Loose Cards', parsed.looseCards, 'loose', true));
	}

	const pieces: PackPieceDef[] = parsed.pieces.map((p) => {
		// TTS States → pack states. `states[0]` is the base face, so a multi-state
		// piece's imageUrl is state 0's image, not whichever state it was saved
		// showing — the placement's `state` index carries that instead.
		const states = p.states?.map((s) => ({
			face: cellToRef(s.face, { name: s.name }),
			...(s.name ? { name: s.name } : {})
		}));
		const imageUrl = states?.length ? states[0].face : p.imageUrl;
		return {
			kind: p.kind,
			name: p.name,
			...(p.color !== undefined ? { color: p.color } : {}),
			...(imageUrl !== undefined ? { imageUrl } : {}),
			...(states?.length ? { states } : {}),
			// the state the mod was saved in — recovered from the missing 1..N key
			...(states?.length && p.state ? { state: p.state } : {}),
			...(p.radius !== undefined ? { radius: p.radius } : {}),
			...(p.maxValue !== undefined ? { maxValue: p.maxValue } : {}),
			...(p.minValue !== undefined ? { minValue: p.minValue } : {}),
			...(p.kind === 'bag'
				? {
						contents: toBagContents(p.contents ?? []),
						drawMode: p.drawMode ?? 'random',
						...(p.infinite ? { infinite: true } : {})
					}
				: {}),
			// TTS Locked → pinned in place (a board, a fixed track)
			...(p.locked ? { locked: true } : {}),
			position: p.position
		};
	});

	return {
		id: opts.id ?? `imported:${slugify(name, 'tts')}`,
		name,
		// deck-builder exports carry a lone deck (player pack); anything more is a table setup
		scope: opts.scope ?? (parsed.decks.length === 1 ? 'player' : 'table'),
		decks,
		...(pieces.length > 0 ? { pieces } : {}),
		source: 'tts'
	};
}
