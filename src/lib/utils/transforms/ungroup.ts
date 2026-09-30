/**
 * The one definition of "ungrouped": what a pile's cards are once they lie
 * loose on the felt. `Shift+G` (`actions/deck.ts` ungroupDeck) spreads a live
 * deck with it, and the scenario composer (`compose/pack.ts`) lays a `loose`
 * deck placement down with it, so the two can't drift apart.
 *
 * Pure, relative imports only, no three.js: the composer runs headless.
 */

import type { CardDTO, CardInDeck, DeckDTO } from '../../store/game/types';
import { CARD_REST_Y, CARD_THICKNESS } from '../constants-card-rest';

/**
 * Cards a single ungroup will spread. A 200-card deck ungrouped would carpet
 * the felt with cards nobody asked for and no cheap way back, so past this
 * `Shift+G` refuses and says so (see `hotkeys/ungroup.ts`), and so does a
 * scenario placement that asks for the deck `loose`.
 */
export const UNGROUP_MAX_CARDS = 40;

const DEG2RAD = Math.PI / 180;

/**
 * Re-order a bottom→top stack into a deck's `cards` array.
 *
 * The deck ordering convention (see `actions/deck.ts` drawFromTop): a
 * facedown deck's top card is the LAST element, a face-up pile's is the
 * FIRST. Either way the card that was on top of the loose stack must be the
 * card the deck draws first.
 *
 * A reverse is its own inverse, so this maps both ways: feed it a deck's
 * `cards` and it hands back the bottom→top order to spread them out in
 * (`ungroupedCards`). Generic on the element so the ungroup can re-order the
 * `CardInDeck` objects, not just their ids.
 */
export function orderForDeck<T>(items: T[], isFaceUp: boolean): T[] {
	return isFaceUp ? [...items].reverse() : [...items];
}

/** the parts of a deck that decide where and how its cards lie once loose */
export type UngroupablePile = Partial<
	Pick<DeckDTO, 'cards' | 'isFaceUp' | 'deckBackImageUrl' | 'position' | 'rotation' | 'locked'>
>;

/**
 * A pile's cards as loose cards, bottom → top, each beside the deck entry it
 * came from (the caller decides the id).
 *
 * They lie at the pile's XZ, one `CARD_THICKNESS` apart in Y with the pile's
 * top card on top. A face-up pile spreads to face-up cards, and the pile's yaw
 * becomes each card's. A pinned pile spreads to pinned cards — `Shift+G` never
 * gets that far (it refuses a locked deck), a scenario placement does.
 */
export function ungroupedCards(pile: UngroupablePile): { from: CardInDeck; card: CardDTO }[] {
	const isFaceUp = pile.isFaceUp ?? false;
	const [x = 0, , z = 0] = pile.position ?? [];
	// deck rotation is radians of yaw on the group; card rotation is degrees
	// with z as the yaw Card.svelte applies as -z. Rounded so repeated
	// group/ungroup round trips can't drift the tap angle; `|| 0` keeps a
	// squared-up pile from spreading to a yaw of -0.
	const yaw = Math.round((-(pile.rotation?.[1] ?? 0) / DEG2RAD) * 1e6) / 1e6 || 0;

	// orderForDeck is its own inverse: fed the deck's array it hands back the
	// bottom→top order the loose stack had before `G` swallowed it
	return orderForDeck(pile.cards ?? [], isFaceUp).map((from, index) => ({
		from,
		card: {
			faceImageUrl: from.faceImageUrl ?? '',
			...(from.backImageUrl || pile.deckBackImageUrl
				? { backImageUrl: from.backImageUrl ?? (pile.deckBackImageUrl as string) }
				: {}),
			...(from.name ? { name: from.name } : {}),
			...(from.orientation ? { orientation: from.orientation } : {}),
			position: [x, CARD_REST_Y + index * CARD_THICKNESS, z],
			// a face-up deck spreads to face-up cards; 180 on x is facedown
			rotation: [isFaceUp ? 0 : 180, 0, yaw],
			...(pile.locked ? { locked: true } : {})
		}
	}));
}
