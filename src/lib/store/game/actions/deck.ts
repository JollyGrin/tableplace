import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { gameActions } from '.';
import { gameStore } from '../gameStore.svelte';
import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { collectStackGroup, orderForDeck } from '$lib/utils/transforms/stacking';
import {
	CARD_DRAG_Y,
	CARD_FAN_STEP,
	CARD_HEIGHT,
	CARD_REST_Y,
	CARD_THICKNESS,
	deckHeightForCount
} from '$lib/utils/constants-cards';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';
import { clampToTable } from '$lib/utils/transforms/drop';
import { degrees } from '$lib/utils/constants-rotation';
import type { CardInDeck, GameDTO } from '../types';

function getMyDecks() {
	const myPlayerId = gameActions.getMe()?.id;
	const decks = get(gameStore)?.decks ?? {};
	return Object.entries(decks).filter(([key]) => key.startsWith(`deck:${myPlayerId}:`));
}

type DeckProps = GameDTO['decks']['string'] & {
	deckId?: string;
	position?: [number, number, number];
	rotation?: [number, number, number];
};

/**
 * Shape the deck patch without committing it, so callers that need the deck
 * and other changes in ONE state patch (grouping a pile deletes the loose
 * cards in the same breath) don't have to broadcast two.
 */
function buildDeck(props: DeckProps) {
	const { id, seat = 0 } = gameActions.getMe() ?? {};
	if (!id) {
		console.error('Cannot init deck without a playerId');
		return null;
	}
	const myDecks = getMyDecks();
	// next free index, not just the count — deleted decks would otherwise let a
	// new deck land on a live id and clobber it
	const taken = new Set(myDecks.map(([key]) => key));
	let next = myDecks.length;
	while (taken.has(`deck:${id}:${next}`)) next++;
	const deckId = props?.deckId ?? `deck:${id}:${next}`;
	const mod = props.isFaceUp ? 2 : 0;
	const positions = [
		[8.5 + mod, 0.4, 4.5],
		[8.5 + mod, 0.4, -4.7]
	];

	const rotations = [
		[0, 0, 0],
		[0, DEG2RAD * 180, 0]
	];
	return {
		deckId,
		deck: {
			id: deckId,
			isFaceUp: props.isFaceUp ?? false,
			deckBackImageUrl: props.deckBackImageUrl,
			position: props?.position ?? (positions[seat % positions.length] as [number, number, number]),
			rotation: props.rotation ?? (rotations[seat % rotations.length] as [number, number, number]),
			cards: props.cards
		}
	};
}

function addDeck(props: DeckProps) {
	const built = buildDeck(props);
	if (!built) return;
	gameStore.updateState({ decks: { [built.deckId]: built.deck } });
	return built.deckId;
}

/**
 * Turn the loose stack under a card into a real deck (hotkey `G`).
 *
 * Membership and ordering come from `collectStackGroup`; the pile lands as a
 * deck at its base card's XZ and the loose card entities are deleted in the
 * same patch, so remote clients never see the pile twice. A one-card "stack"
 * is a legal group — a 1-card deck is a perfectly good pile to build on.
 */
function groupStackIntoDeck(cardId?: string) {
	const { isHovered, isDragging } = get(dragStore);
	if (!cardId && isDragging) return; // don't swallow the card you're holding
	const anchorId = cardId ?? isHovered;
	if (!anchorId) return console.error('No cardId provided to group');

	const cards = get(gameStore)?.cards;
	const group = collectStackGroup(cards, anchorId);
	if (!group) return console.error('No stack found to group');
	// a pinned card is never swallowed — not even one lying under the anchor
	if (group.ids.some((memberId) => cards?.[memberId]?.locked)) return;

	return groupIntoDeck(group.ids, group.topId, group.position);
}

/**
 * Loose cards → one deck, in ONE patch that also deletes the cards, so remote
 * clients never see them twice. `ids` run bottom → top; the pile lands at
 * `at`'s XZ. Shared by `G` on a pile and `G` on a selection.
 */
function groupIntoDeck(ids: string[], topId: string, at: readonly number[]) {
	const cards = get(gameStore)?.cards;
	// the top card decides the pile's facing: a face-up top becomes a face-up
	// deck (discard-pile style), which also flips the ordering convention —
	// face-up decks draw from the front, facedown ones from the back
	const top = cards?.[topId];
	const isFaceUp = (top?.rotation?.[0] ?? 0) !== 180;
	const ordered = orderForDeck(ids, isFaceUp);
	const deckCards = ordered.map((memberId) => {
		const card = cards?.[memberId];
		return {
			id: memberId,
			faceImageUrl: card?.faceImageUrl ?? '',
			backImageUrl: card?.backImageUrl,
			...(card?.name ? { name: card.name } : {}),
			...(card?.orientation ? { orientation: card.orientation } : {})
		};
	});

	const [baseX = 0, , baseZ = 0] = at;
	const built = buildDeck({
		isFaceUp,
		deckBackImageUrl: top?.backImageUrl,
		// the deck body is centred on its origin, so lift it half its height
		position: [baseX, TABLE_TOP_Y + deckHeightForCount(deckCards.length) / 2, baseZ],
		// card rotation is degrees with z as the yaw Card.svelte applies as -z;
		// deck rotation is radians on the group
		rotation: [0, -(top?.rotation?.[2] ?? 0) * DEG2RAD, 0],
		cards: deckCards as GameDTO['decks']['string']['cards']
	});
	if (!built) return;

	const removals: Record<string, null> = {};
	for (const memberId of ids) removals[memberId] = null;
	gameStore.updateState({
		decks: { [built.deckId]: built.deck },
		cards: removals
	});
	return built.deckId;
}

/**
 * `G` on a selection (tableplace-202): every selected loose card into one
 * deck, wherever they lie. They stack in the order they lie — lowest first,
 * then selection order — and the pile lands where the top one was. Pinned
 * cards and ids that are not loose cards are left out. Returns the deck id,
 * or undefined when there was no card to group.
 */
function groupCardsIntoDeck(ids: readonly string[]) {
	const cards = get(gameStore)?.cards;
	const members = ids
		.filter((id) => cards?.[id] && !cards[id]?.locked)
		.map((id, order) => ({ id, order, y: cards?.[id]?.position?.[1] ?? 0 }))
		.sort((a, b) => a.y - b.y || a.order - b.order)
		.map(({ id }) => id);
	if (!members.length) return;
	const topId = members[members.length - 1];
	return groupIntoDeck(members, topId, cards?.[topId]?.position ?? [0, 0, 0]);
}

/**
 * Cards a single `Shift+G` will spread. A 200-card deck ungrouped would
 * carpet the felt with cards nobody asked for and no cheap way back, so past
 * this the ungroup refuses and says so (see `hotkeys/ungroup.ts`).
 */
export const UNGROUP_MAX_CARDS = 40;

export type UngroupResult =
	| { ok: true; deckId: string; cardIds: string[] }
	| {
			ok: false;
			reason: 'no-deck' | 'not-mine' | 'locked' | 'empty' | 'too-many';
			count?: number;
	  };

export type UngroupRefusal = Extract<UngroupResult, { ok: false }>;

/** Decks belong to the player their id names: `deck:<playerId>:<slot>`. */
export function isDeckOwnedBy(deckId: string, playerId: string | null | undefined): boolean {
	return !!playerId && deckId.startsWith(`deck:${playerId}:`);
}

/**
 * Why `playerId` may not spread `deckId` right now, or null when they may.
 * Pure over the store, so the verb registry can grey the verb out before
 * anyone presses it and `ungroupDeck` refuses with the very same rule.
 */
export function ungroupRefusal(
	deckId: string | null | undefined,
	playerId: string | null | undefined
): UngroupRefusal | null {
	if (!deckId) return { ok: false, reason: 'no-deck' };
	const deck = get(gameStore)?.decks?.[deckId];
	if (!deck) return { ok: false, reason: 'no-deck' };
	if (!isDeckOwnedBy(deckId, playerId)) return { ok: false, reason: 'not-mine' };
	if (deck.locked) return { ok: false, reason: 'locked' };
	const count = deck.cards?.length ?? 0;
	if (count === 0) return { ok: false, reason: 'empty' };
	if (count > UNGROUP_MAX_CARDS) return { ok: false, reason: 'too-many', count };
	return null;
}

/**
 * Reuse the card's own id when nothing on the table holds it — a deck built
 * by `G` still carries the ids its loose cards had, so a round trip lands the
 * same entities — and fall back to a suffixed id when it's taken (the same
 * pack slot spawned twice, or a copy already drawn out).
 */
function allocateCardId(preferred: string, fallback: string, taken: Set<string>) {
	const base = preferred || fallback;
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/**
 * Spread a deck back into loose cards (hotkey `Shift+G` on a hovered deck) —
 * the exact inverse of `groupStackIntoDeck`.
 *
 * The cards land at the deck's XZ, one `CARD_THICKNESS` apart in Y with the
 * deck's top card on top, and the deck is deleted in the SAME patch as the
 * cards are created, so remote clients never see both at once. Ownership
 * matches shuffle: only your own decks.
 */
function ungroupDeck(deckId?: string): UngroupResult {
	const id = deckId ?? get(dragStore).isDeckHovered;
	const refusal = ungroupRefusal(id, gameActions.getMe()?.id);
	const deck = id ? get(gameStore)?.decks?.[id] : undefined;
	if (refusal || !id || !deck) return refusal ?? { ok: false, reason: 'no-deck' };
	const deckCards = deck.cards ?? [];

	const isFaceUp = deck.isFaceUp ?? false;
	// orderForDeck is its own inverse: fed the deck's array it hands back the
	// bottom→top order the loose stack had before `G` swallowed it
	const bottomToTop = orderForDeck(deckCards, isFaceUp);

	const [x = 0, , z = 0] = deck.position ?? [];
	// deck rotation is radians of yaw on the group; card rotation is degrees
	// with z as the yaw Card.svelte applies as -z. Rounded so repeated
	// group/ungroup round trips can't drift the tap angle.
	const yaw = Math.round((-(deck.rotation?.[1] ?? 0) / DEG2RAD) * 1e6) / 1e6;

	const taken = new Set(Object.keys(get(gameStore)?.cards ?? {}));
	const cards: Record<string, GameDTO['cards'][string]> = {};
	const cardIds: string[] = [];

	bottomToTop.forEach((card, index) => {
		const cardId = allocateCardId(card.id, `${id}:card-${index}`, taken);
		taken.add(cardId);
		cardIds.push(cardId);
		cards[cardId] = {
			faceImageUrl: card.faceImageUrl ?? '',
			...(card.backImageUrl || deck.deckBackImageUrl
				? { backImageUrl: card.backImageUrl ?? (deck.deckBackImageUrl as string) }
				: {}),
			...(card.name ? { name: card.name } : {}),
			...(card.orientation ? { orientation: card.orientation } : {}),
			position: [x, CARD_REST_Y + index * CARD_THICKNESS, z],
			// a face-up deck spreads to face-up cards; 180 on x is facedown
			rotation: [isFaceUp ? 0 : 180, 0, yaw]
		};
	});

	gameStore.updateState({ decks: { [id]: null }, cards });
	return { ok: true, deckId: id, cardIds };
}

/**
 * Center-to-center distance from the deck to the first drawn card: one card
 * length plus a sliver of felt, so the landing clears the deck's footprint.
 */
const DRAW_LANDING_DISTANCE = CARD_HEIGHT + 0.2;

/**
 * Draw `count` cards off the top of the deck (click = 1, number keys 1-9)
 * and land them on the table between the deck and the drawer's seat.
 *
 * Follows LIFO (Last In First Out):
 * when facedown (like a deck of cards), the top card = cards.length - 1;
 * when faceup (like a visible discard pile), the top card = cards[0].
 *
 * The landings cascade down-screen one CARD_FAN_STEP apart with a thickness
 * of Y between them — the hover-fan look, not one Y-tower — first-drawn
 * nearest the deck. Deck shrink and table cards go in ONE patch, so remote
 * clients never see the cards in both places (and last-write-wins concurrency
 * stays a single-patch problem).
 *
 * Returns the drawn cards, first drawn (the old top) first.
 * */
function drawFromTop(id: string, count = 1): CardInDeck[] {
	const deck = get(gameStore)?.decks?.[id];
	const available = deck?.cards;
	if (!available || available.length === 0) {
		console.error('Cannot draw from an empty deck');
		return [];
	}

	const isFaceUp = deck.isFaceUp ?? false;
	const remaining = [...available];
	const drawn: CardInDeck[] = [];
	for (let i = 0; i < Math.min(count, available.length); i++) {
		const card = isFaceUp ? remaining.shift() : remaining.pop();
		if (card) drawn.push(card);
	}

	// "down-screen" for the drawer: +Z for seat 0, rotating with the seat —
	// the same frame fanOffset uses. Card yaw is degrees applied as -z.
	const seatYaw = degrees[gameActions.getMySeat()] ?? 0;
	const rotZ = -seatYaw / DEG2RAD;
	const [deckX = 0, , deckZ = 0] = deck.position ?? [];
	const taken = new Set(Object.keys(get(gameStore)?.cards ?? {}));
	const cards: Record<string, GameDTO['cards'][string]> = {};

	drawn.forEach((card, index) => {
		const distance = DRAW_LANDING_DISTANCE + index * CARD_FAN_STEP;
		const [x, z] = clampToTable(
			deckX + Math.sin(seatYaw) * distance,
			deckZ + Math.cos(seatYaw) * distance
		);
		const cardId = allocateCardId(card.id, `${id}:draw-${index}`, taken);
		taken.add(cardId);
		cards[cardId] = {
			faceImageUrl: card.faceImageUrl ?? '',
			...(card.backImageUrl || deck.deckBackImageUrl
				? { backImageUrl: card.backImageUrl ?? (deck.deckBackImageUrl as string) }
				: {}),
			...(card.name ? { name: card.name } : {}),
			...(card.orientation ? { orientation: card.orientation } : {}),
			position: [x, CARD_REST_Y + index * CARD_THICKNESS, z],
			// a face-up deck deals face-up cards; 180 on x is facedown
			rotation: [isFaceUp ? 0 : 180, 0, rotZ]
		};
	});

	gameStore.updateState({ decks: { [id]: { cards: remaining } }, cards });
	return drawn;
}

export type DrawToHandResult =
	| { ok: true; deckId: string; cardIds: string[] }
	| { ok: false; reason: 'no-deck' | 'not-yours' | 'empty' | 'no-player' };

/**
 * Whose hand may a deck deal into? Deck ids encode their owner
 * (`deck:<owner>:<slot>`). Your own decks deal to you; a deck whose owner is
 * not a player in the lobby — a shared pile, an unclaimed seat — is
 * table-scoped and deals to whoever draws. Another player's deck does not.
 */
function canDrawToHand(
	deckId: string,
	playerId: string | null | undefined = gameActions.getMyId()
) {
	if (!playerId) return false;
	const owner = deckId.split(':')[1];
	if (owner === playerId) return true;
	return !get(gameStore)?.players?.[owner ?? ''];
}

/**
 * Draw `count` cards off the top of the deck into the drawer's hand (a deck
 * click, number keys 1-9) — the tray, not the felt. Same top-of-deck
 * convention as drawFromTop; the drawn cards append to the hand in draw order.
 *
 * Deck shrink and hand growth are ONE patch whatever the count, so `5` costs
 * one message against the relay's rate limit, and remote clients never see a
 * card in both places. Nothing here carries a position, so it goes out
 * immediately rather than through the drag throttle.
 */
function drawToHand(id: string, count = 1): DrawToHandResult {
	const deck = get(gameStore)?.decks?.[id];
	if (!deck) return { ok: false, reason: 'no-deck' };
	const playerId = gameActions.getMyId();
	const player = playerId ? get(gameStore)?.players?.[playerId] : undefined;
	if (!playerId || !player) return { ok: false, reason: 'no-player' };
	if (!canDrawToHand(id, playerId)) return { ok: false, reason: 'not-yours' };
	const available = deck.cards ?? [];
	if (available.length === 0) return { ok: false, reason: 'empty' };

	const isFaceUp = deck.isFaceUp ?? false;
	const remaining = [...available];
	// a card id can already be live on the table or in the hand (the same pack
	// slot spawned twice) — the hand is keyed by id, so a clash would overwrite
	const taken = new Set([
		...Object.keys(get(gameStore)?.cards ?? {}),
		...Object.keys(player.tray ?? {})
	]);
	const tray: Record<string, Partial<GameDTO['cards'][string]>> = {};
	const cardIds: string[] = [];
	for (let i = 0; i < Math.min(count, available.length); i++) {
		const card = isFaceUp ? remaining.shift() : remaining.pop();
		if (!card) break;
		const { id: deckCardId, ...body } = card;
		const cardId = allocateCardId(deckCardId, `${id}:draw-${i}`, taken);
		taken.add(cardId);
		cardIds.push(cardId);
		tray[cardId] = {
			...body,
			faceImageUrl: body.faceImageUrl ?? '',
			...(body.backImageUrl || deck.deckBackImageUrl
				? { backImageUrl: body.backImageUrl ?? (deck.deckBackImageUrl as string) }
				: {})
		};
	}

	gameStore.updateState({
		decks: { [id]: { cards: remaining } },
		players: { [playerId]: { tray } }
	} as Partial<GameDTO>);
	return { ok: true, deckId: id, cardIds };
}

export type TakeFromDeckResult =
	| { ok: true; deckId: string; cardId: string }
	| { ok: false; reason: 'no-deck' | 'not-yours' | 'no-card' | 'no-player' };

/**
 * Take one named card out of a deck, wherever it sits in the pile — deck
 * search (tableplace-196). `to: 'hand'` puts it in your hand like a draw;
 * `to: 'table'` lays it face-up on the felt in front of the deck, where
 * drawFromTop would land a draw.
 *
 * The card is picked by its deck-card id, so a remote reorder between opening
 * the search and clicking can't hand you a different card. Same ownership as
 * drawToHand — your own decks and table-scoped ones — and the same single
 * patch, deck shrink and destination together.
 */
function takeFromDeck(
	id: string,
	deckCardId: string,
	to: 'hand' | 'table' = 'hand'
): TakeFromDeckResult {
	const deck = get(gameStore)?.decks?.[id];
	if (!deck) return { ok: false, reason: 'no-deck' };
	const playerId = gameActions.getMyId();
	const player = playerId ? get(gameStore)?.players?.[playerId] : undefined;
	if (!playerId || !player) return { ok: false, reason: 'no-player' };
	if (!canDrawToHand(id, playerId)) return { ok: false, reason: 'not-yours' };
	const available = deck.cards ?? [];
	const index = available.findIndex((card) => card.id === deckCardId);
	if (index < 0) return { ok: false, reason: 'no-card' };

	const remaining = [...available];
	const [card] = remaining.splice(index, 1);
	const { id: takenId, ...body } = card!;
	const taken = new Set([
		...Object.keys(get(gameStore)?.cards ?? {}),
		...Object.keys(player.tray ?? {})
	]);
	const cardId = allocateCardId(takenId, `${id}:search-0`, taken);
	const faces = {
		...body,
		faceImageUrl: body.faceImageUrl ?? '',
		...(body.backImageUrl || deck.deckBackImageUrl
			? { backImageUrl: body.backImageUrl ?? (deck.deckBackImageUrl as string) }
			: {})
	};

	if (to === 'hand') {
		gameStore.updateState({
			decks: { [id]: { cards: remaining } },
			players: { [playerId]: { tray: { [cardId]: faces } } }
		} as Partial<GameDTO>);
		return { ok: true, deckId: id, cardId };
	}

	const seatYaw = degrees[gameActions.getMySeat()] ?? 0;
	const [deckX = 0, , deckZ = 0] = deck.position ?? [];
	const [x, z] = clampToTable(
		deckX + Math.sin(seatYaw) * DRAW_LANDING_DISTANCE,
		deckZ + Math.cos(seatYaw) * DRAW_LANDING_DISTANCE
	);
	gameStore.updateState({
		decks: { [id]: { cards: remaining } },
		cards: {
			[cardId]: {
				...faces,
				position: [x, CARD_REST_Y, z],
				// face-up whatever the pile: you picked it by its face
				rotation: [0, 0, -seatYaw / DEG2RAD]
			}
		}
	});
	return { ok: true, deckId: id, cardId };
}

/**
 * Draw the top card straight into an in-flight drag (tableplace-103): the
 * card spawns already airborne — at the pointer's table point, at
 * CARD_DRAG_Y, the height every drag floats at — so the caller can hand it
 * the live gesture (`dragStart(cardId)`) in the same tick and the card is
 * under the pointer on its very first frame. Deck shrink and card creation
 * are ONE patch, same as drawFromTop, so remote clients never see the card
 * in both places.
 *
 * Returns the allocated table card id, or null when the deck has nothing to
 * draw (the caller falls back to moving the pile).
 */
function drawIntoDrag(id: string, at?: [number, number]): string | null {
	const deck = get(gameStore)?.decks?.[id];
	const available = deck?.cards;
	if (!available || available.length === 0) return null;

	const isFaceUp = deck.isFaceUp ?? false;
	const remaining = [...available];
	const card = isFaceUp ? remaining.shift() : remaining.pop();
	if (!card) return null;

	const [deckX = 0, , deckZ = 0] = deck.position ?? [];
	const [x, z] = clampToTable(at?.[0] ?? deckX, at?.[1] ?? deckZ);
	const seatYaw = degrees[gameActions.getMySeat()] ?? 0;
	const taken = new Set(Object.keys(get(gameStore)?.cards ?? {}));
	const cardId = allocateCardId(card.id, `${id}:draw-0`, taken);

	gameStore.updateState({
		decks: { [id]: { cards: remaining } },
		cards: {
			[cardId]: {
				faceImageUrl: card.faceImageUrl ?? '',
				...(card.backImageUrl || deck.deckBackImageUrl
					? { backImageUrl: card.backImageUrl ?? (deck.deckBackImageUrl as string) }
					: {}),
				...(card.name ? { name: card.name } : {}),
				...(card.orientation ? { orientation: card.orientation } : {}),
				position: [x, CARD_DRAG_Y, z],
				// a face-up deck deals face-up cards; 180 on x is facedown — same
				// conventions as drawFromTop, yawed toward the drawer's seat
				rotation: [isFaceUp ? 0 : 180, 0, -seatYaw / DEG2RAD]
			}
		}
	});
	return cardId;
}

/**
 * Flip the whole deck like a physical pile (hotkey `F` on a hovered deck).
 *
 * Toggling `isFaceUp` IS the flip: drawFromTop's ordering convention
 * (facedown top = last element, face-up top = first) means the former
 * bottom card becomes the new top with no array surgery — exactly what
 * turning a real pile over does.
 */
function flipDeck(deckId?: string) {
	const id = deckId ?? get(dragStore).isDeckHovered;
	if (!id) return;
	const deck = get(gameStore)?.decks?.[id];
	if (!deck || deck.locked) return;
	gameStore.updateState({ decks: { [id]: { isFaceUp: !(deck.isFaceUp ?? false) } } });
	return id;
}

type Card = NonNullable<GameDTO['decks'][string]['cards']>[number];
function placeOnTopOfDeck(deckId: string, cardId: string) {
	const _card = get(gameStore)?.cards?.[cardId]; // grab card from table
	if (!_card) return console.error('Card not found');

	const { position, rotation, ...card } = { ..._card, id: cardId };
	card.id = cardId;
	if (!card.faceImageUrl) return console.error('No card faceImageUrl found');

	// get current deck
	const { cards, isFaceUp } = get(gameStore)?.decks?.[deckId] ?? {};
	if (!cards) return console.error('No cards found in deck');

	isFaceUp ? cards.unshift(card as Card) : cards.push(card as Card);
	return gameStore.updateState({
		cards: { [cardId]: null },
		decks: { [deckId]: { cards } }
	});
}

/**
 * How many cards are in the deck
 * */
function getDeckLength(id: string) {
	return get(gameStore)?.decks?.[id]?.cards?.length ?? 0;
}

function shuffleCards(cards: any[]) {
	if (!cards || cards.length === 0) return console.error('No cards to shuffle');
	for (let i = cards.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[cards[i], cards[j]] = [cards[j], cards[i]];
	}
	return cards;
}

//   /**
//    * Shuffle deck using the Fisher-Yates shuffle
//    */
export function shuffleDeck(deckId: string) {
	const deck = get(gameStore)?.decks?.[deckId];
	const cards = deck?.cards;
	if (!cards || cards.length === 0) return console.error('No cards to shuffle');
	const shuffledCards = shuffleCards(cards);
	if (!shuffledCards || shuffledCards.length === 0) return console.log('Error shuffling');
	return gameStore.updateState({
		// shuffledAt rides the same patch as the reorder: the new card order is
		// invisible from the back, the changed timestamp is what every client's
		// Deck.svelte turns into the wiggle
		decks: { [deckId]: { cards: shuffledCards, shuffledAt: Date.now() } }
	});
}

export const deckActions = {
	addDeck,
	groupStackIntoDeck,
	groupCardsIntoDeck,
	ungroupDeck,
	drawFromTop,
	drawToHand,
	canDrawToHand,
	takeFromDeck,
	drawIntoDrag,
	flipDeck,
	getDeckLength,
	getMyDecks,
	placeOnTopOfDeck,
	shuffleDeck,
	shuffleCards
};
