/**
 * What the zoomed preview shows: whatever is under the pointer, reduced to one
 * face ref and a caption.
 *
 * Pure over (game state, who I am, what is hovered) so every rule here —
 * which hover wins, what a face-down thing may reveal — is unit-testable
 * without a canvas. `HUDPreviewScene` only draws the answer.
 *
 * Hidden information stays hidden: a face-down card previews its back with no
 * caption, and a face-down deck previews its back with only its count. Your
 * own hand is always shown face up — it is already face up to you in the tray.
 *
 * One exception, the peek (tableplace-193): a face-down card you laid out of
 * your own hand (`placedBy` is you) previews its face, captioned so you know
 * the others see its back. Hidden here means hidden in the UI — the face is
 * in synced state — so the copy never claims more than that.
 */

import { currentPieceState } from '$lib/compose/piece';
import { CARD_BACK_DEFAULT } from '$lib/packs';
import type { GameDTO } from '$lib/store/game/types';

/** Everything that can be under the pointer, one slot per hover source. */
export type PreviewHover = {
	/** a card in my hand tray (HUD, drawn over the table — so it wins) */
	trayCard: string | null;
	/** a loose card on the table */
	card: string | null;
	/** a deck on the table */
	deck: string | null;
	/** a piece on the table */
	piece: string | null;
};

export type PreviewShape = 'card' | 'disc';

export type PreviewTarget = {
	/** the hovered entity's store id */
	id: string;
	/** unresolved face ref (`https://…`, `gen:`, `sheet:`) — resolve at draw time */
	face: string;
	shape: PreviewShape;
	landscape: boolean;
	/** entity name (and state / count); empty when there is nothing safe to say */
	caption: string;
};

/** Is the preview key held, and is nothing being dragged? */
export function isPreviewOpen(state: {
	isPreview?: boolean;
	noSnap?: boolean;
	isDragging: string | null;
}): boolean {
	// Alt doubles as the preview key, but mid-drag it only means "no snap"
	return !state.isDragging && !!(state.isPreview || state.noSnap);
}

/** The caption on a peeked card: it only says who sees it, never that it is safe. */
export const PEEK_CAPTION = 'Only you see this';

function cardCount(n: number): string {
	return n === 1 ? '1 card' : `${n} cards`;
}

export function previewTarget(
	game: Partial<GameDTO> | undefined,
	myPlayerId: string | undefined,
	hover: PreviewHover
): PreviewTarget | null {
	if (!game) return null;

	if (hover.trayCard && myPlayerId) {
		const card = game.players?.[myPlayerId]?.tray?.[hover.trayCard];
		if (card?.faceImageUrl) {
			return {
				id: hover.trayCard,
				face: card.faceImageUrl,
				shape: 'card',
				landscape: card.orientation === 'landscape',
				caption: card.name ?? ''
			};
		}
	}

	if (hover.card) {
		const card = game.cards?.[hover.card];
		if (card) {
			const faceDown = (card.rotation ?? [0])[0] === 180;
			const peek = faceDown && !!myPlayerId && card.placedBy === myPlayerId;
			const hidden = faceDown && !peek;
			const face = hidden ? card.backImageUrl || CARD_BACK_DEFAULT : card.faceImageUrl;
			if (face) {
				const name = hidden ? '' : (card.name ?? '');
				return {
					id: hover.card,
					face,
					shape: 'card',
					landscape: card.orientation === 'landscape',
					caption: peek ? (name ? `${name} · ${PEEK_CAPTION}` : PEEK_CAPTION) : name
				};
			}
		}
	}

	if (hover.deck) {
		const deck = game.decks?.[hover.deck];
		if (deck) {
			const cards = deck.cards ?? [];
			// the face-up top is cards[0] — see Deck.svelte
			const top = deck.isFaceUp ? cards[0] : undefined;
			const count = cardCount(cards.length);
			if (top?.faceImageUrl) {
				return {
					id: hover.deck,
					face: top.faceImageUrl,
					shape: 'card',
					landscape: top.orientation === 'landscape',
					caption: top.name ? `${top.name} · ${count}` : count
				};
			}
			if (!deck.isFaceUp) {
				return {
					id: hover.deck,
					face: deck.deckBackImageUrl || CARD_BACK_DEFAULT,
					shape: 'card',
					landscape: false,
					caption: count
				};
			}
		}
	}

	if (hover.piece) {
		const piece = game.pieces?.[hover.piece];
		// dice and models are geometry, not art — there is no face to zoom
		if (piece && piece.kind !== 'die' && piece.kind !== 'model') {
			const states = piece.states ?? [];
			const index = currentPieceState(piece);
			const face = states.length ? states[index]?.face : piece.imageUrl;
			if (face) {
				const stateName = states.length > 1 ? states[index]?.name : undefined;
				const name = piece.name ?? '';
				return {
					id: hover.piece,
					face,
					shape: 'disc',
					landscape: false,
					caption: stateName ? (name ? `${name} — ${stateName}` : stateName) : name
				};
			}
		}
	}

	return null;
}
