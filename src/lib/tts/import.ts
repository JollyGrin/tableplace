/**
 * Orchestrates a TTS Saved Object import: parse → slice sheets →
 * spawn decks/cards into the gameStore via existing actions.
 */

import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { CARD_BACK_DEFAULT } from '$lib/packs';
import { makeSheetRef, prewarmSheetRef } from '$lib/packs/resolve.svelte';
import { CARD_REST_Y } from '$lib/utils/constants-cards';
import { PIECE_REST_Y } from '$lib/utils/constants-pieces';
import { parseSavedObject, type ParsedCard } from './parse';
import { cellToRef } from './to-pack';
import { sliceCell } from './slice';

export type ImportReport = {
	decks: number;
	cards: number;
	pieces: number;
	missingArt: number;
	skipped: string[];
};

function slugify(name: string, fallback: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || fallback;
}

/**
 * Game state carries tiny `sheet:` refs, never image data — each client
 * slices locally at render time, so state survives refresh/sync limits
 * (SPEC §4d). Prewarming here fully resolves + commits every ref before
 * entities hit the store, so local imports paint on first render; the
 * missing-art probe rides along for free.
 */
async function resolveCard(card: ParsedCard): Promise<{
	name: string;
	faceImageUrl: string;
	backImageUrl: string;
	missingArt: boolean;
	sideways: boolean;
}> {
	const faceRef = makeSheetRef({ ...card.face, name: card.name });
	const backRef = makeSheetRef({ ...card.back, name: card.name, back: true });
	const [faceProbe] = await Promise.all([
		sliceCell(card.face),
		prewarmSheetRef(faceRef),
		prewarmSheetRef(backRef)
	]);
	return {
		name: card.name,
		faceImageUrl: faceRef,
		backImageUrl: backRef,
		missingArt: faceProbe === null,
		sideways: card.sideways ?? false
	};
}

export type ImportOptions = {
	/** entity owner id — defaults to the local player (scenario editor passes placeholder seat ids) */
	ownerId?: string;
	/** spawn on the far side of the table, rotated to face that seat (seat 1 setups) */
	mirror?: boolean;
};

/** Import a TTS Saved Object JSON string; spawns onto the current table. */
export async function importTtsFile(text: string, opts: ImportOptions = {}): Promise<ImportReport> {
	const parsed = parseSavedObject(JSON.parse(text));
	const playerId = opts.ownerId ?? gameActions.getMyId();
	if (!playerId) throw new Error('No player id — join a lobby first');
	const m = opts.mirror ? -1 : 1;

	const report: ImportReport = {
		decks: 0,
		cards: 0,
		pieces: 0,
		missingArt: 0,
		skipped: parsed.skipped
	};

	for (const [deckIndex, deck] of parsed.decks.entries()) {
		const resolved = await Promise.all(deck.cards.map(resolveCard));
		report.missingArt += resolved.filter((c) => c.missingArt).length;
		report.cards += resolved.length;

		const slot = slugify(deck.name, `imported-${deckIndex}`);
		// TTS DeckIDs are top-of-deck first; our facedown decks draw from the
		// END of the array, so reverse to preserve the deck's order.
		const cards = resolved
			.map((c, i) => ({
				id: `card:${playerId}:${slot}-${i}`,
				faceImageUrl: c.faceImageUrl,
				backImageUrl: c.backImageUrl,
				...(c.name ? { name: c.name } : {}),
				...(c.sideways ? { orientation: 'landscape' as const } : {})
			}))
			.reverse();

		const firstBack = deck.cards[0]?.back;
		const deckBackRef = firstBack ? makeSheetRef({ ...firstBack, back: true }) : CARD_BACK_DEFAULT;
		if (firstBack) await prewarmSheetRef(deckBackRef);
		gameActions.addDeck({
			id: `deck:${playerId}:${slot}`,
			deckId: `deck:${playerId}:${slot}`,
			isFaceUp: false,
			deckBackImageUrl: deckBackRef,
			cards,
			position: [(8.5 - deckIndex * 2.5) * m, 0.4, 4.5 * m],
			// deck rotation is radians; face the owning seat
			rotation: [0, opts.mirror ? Math.PI : 0, 0]
		});
		report.decks += 1;
	}

	for (const [i, looseCard] of parsed.looseCards.entries()) {
		const c = await resolveCard(looseCard);
		if (c.missingArt) report.missingArt += 1;
		report.cards += 1;
		gameStore.updateState({
			cards: {
				[`card:${playerId}:loose-${slugify(c.name, String(i))}-${i}`]: {
					position: [(4 - i * 1.6) * m, CARD_REST_Y, 1.5 * m],
					// card rotation is in degrees (tap convention); z=180 reads upright from the far seat
					rotation: [0, 0, opts.mirror ? 180 : 0],
					faceImageUrl: c.faceImageUrl,
					backImageUrl: c.backImageUrl,
					...(c.name ? { name: c.name } : {}),
					...(c.sideways ? { orientation: 'landscape' as const } : {})
				}
			}
		});
	}

	// tokens / pawns / counters land at their (mirrored) TTS table positions.
	// TTS stacks health dials exactly on top of their pawn/token — offset
	// counters sideways so they're visible and clickable next to their owner.
	parsed.pieces.forEach((piece, i) => {
		report.pieces += 1;
		const offsetX = piece.kind === 'counter' ? 1.5 : 0;
		// a TTS States object keeps every face; states[0] is the base one, and the
		// state it was saved showing rides along as `state`
		const states = piece.states?.map((s) => ({
			face: cellToRef(s.face, { name: s.name }),
			...(s.name ? { name: s.name } : {})
		}));
		gameStore.updateState({
			pieces: {
				[`piece:${playerId}:${slugify(piece.name, 'piece')}-${i}`]: {
					kind: piece.kind,
					name: piece.name,
					color: piece.color,
					imageUrl: states?.length ? states[0].face : piece.imageUrl,
					...(states?.length ? { states, state: piece.state ?? 0 } : {}),
					radius: piece.radius,
					maxValue: piece.maxValue,
					value: piece.maxValue,
					position: [(piece.position[0] + offsetX) * m, PIECE_REST_Y, piece.position[1] * m],
					rotation: [0, 0, 0]
				}
			}
		});
	});

	return report;
}
