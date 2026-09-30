import type { GameDTO } from '$lib/store/game/types';
import {
	CARD_REST_Y,
	CARD_THICKNESS,
	CARD_STACK_RADIUS,
	CARD_STACK_MAX_Y,
	CARD_FAN_STEP
} from '$lib/utils/constants-cards';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';

export interface StackResolution {
	/** resting height for the dropped card */
	restY: number;
	/** XZ the drop commits at — the base card's when it lands on a stack */
	x: number;
	z: number;
	/** how many resting cards were found under the drop point */
	count: number;
}

/**
 * Resolve where a card dropped at (x, z) comes to rest.
 *
 * Cards overlapping the drop point stack on top of each other with one
 * thickness of separation instead of all resting at the same y — two
 * coplanar cards z-fight no matter how precise the depth buffer is — and the
 * drop squares up to the base card's XZ so a pile reads as an intentional
 * stack instead of a drifting fan.
 *
 * `floorY` is the local floor the pile rests on — the table top, unless an
 * elevated snap point substitutes its own (see `resolveDrop`). All the height
 * bookkeeping shifts with it: the empty-spot rest, the "mid-drag, not
 * resting" ceiling, and a lower bound that keeps a card sitting on the felt
 * *under* an elevated platform from pulling the drop down through the floor.
 */
export function resolveStack(
	cards: GameDTO['cards'] | undefined,
	droppedId: string,
	x: number,
	z: number,
	floorY: number = TABLE_TOP_Y
): StackResolution {
	let top: number | null = null;
	let base: { id: string; x: number; y: number; z: number } | null = null;
	let count = 0;
	const radiusSq = CARD_STACK_RADIUS * CARD_STACK_RADIUS;
	const restBase = floorY + (CARD_REST_Y - TABLE_TOP_Y);
	const maxRestingY = floorY + (CARD_STACK_MAX_Y - TABLE_TOP_Y);

	for (const [id, card] of Object.entries(cards ?? {})) {
		if (id === droppedId || !card?.position) continue;
		const [cx = 0, cy = 0, cz = 0] = card.position;
		if (cy > maxRestingY) continue; // mid-drag/animation, not resting
		if (cy < floorY - CARD_THICKNESS) continue; // resting below this floor
		const dx = cx - x;
		const dz = cz - z;
		if (dx * dx + dz * dz > radiusSq) continue;
		count++;
		if (top === null || cy > top) top = cy;
		// lowest card wins the XZ; ties break on id so every client squares up
		// to the same spot
		if (base === null || cy < base.y || (cy === base.y && id < base.id))
			base = { id, x: cx, y: cy, z: cz };
	}

	if (top === null || base === null) return { restY: restBase, x, z, count: 0 };
	return { restY: top + CARD_THICKNESS, x: base.x, z: base.z, count };
}

/**
 * Resolve the resting height for a card dropped at (x, z).
 */
export function resolveStackHeight(
	cards: GameDTO['cards'] | undefined,
	droppedId: string,
	x: number,
	z: number
): number {
	return resolveStack(cards, droppedId, x, z).restY;
}

export interface StackGroup {
	/** member card ids, bottom card first */
	ids: string[];
	/** the bottom card's position — the pile's base */
	position: [number, number, number];
	/** the visually topmost card, which decides the pile's facing */
	topId: string;
}

/**
 * Collect the loose stack around `anchorId`: every resting card whose centre
 * is within `CARD_STACK_RADIUS` of the anchor's, ordered bottom → top so the
 * visual top of the pile stays the top of whatever it becomes.
 *
 * Membership is a flat radius scan around the anchor (not a transitive walk),
 * the same rule `resolveStack` uses to decide what a dropped card lands on —
 * so what stacked together groups together. A lone card is a valid group.
 */
export function collectStackGroup(
	cards: GameDTO['cards'] | undefined,
	anchorId: string
): StackGroup | null {
	const anchor = cards?.[anchorId];
	if (!anchor?.position) return null;
	const [ax = 0, ay = 0, az = 0] = anchor.position;
	if (ay > CARD_STACK_MAX_Y) return null; // the anchor itself is mid-drag

	const radiusSq = CARD_STACK_RADIUS * CARD_STACK_RADIUS;
	const members: { id: string; x: number; y: number; z: number }[] = [];

	for (const [id, card] of Object.entries(cards ?? {})) {
		if (!card?.position) continue;
		const [cx = 0, cy = 0, cz = 0] = card.position;
		if (cy > CARD_STACK_MAX_Y) continue;
		if (id !== anchorId) {
			const dx = cx - ax;
			const dz = cz - az;
			if (dx * dx + dz * dz > radiusSq) continue;
		}
		members.push({ id, x: cx, y: cy, z: cz });
	}

	if (members.length === 0) return null;
	// ascending y = bottom first; ties break on id so the order is the same on
	// every client that runs this
	members.sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : 1));
	const base = members[0];
	return {
		ids: members.map((m) => m.id),
		position: [base.x, base.y, base.z],
		topId: members[members.length - 1].id
	};
}

// the deck ordering convention lives with the ungroup it is the inverse of
export { orderForDeck } from './ungroup';

/**
 * Screen-down offset for the `index`-th member (bottom → top) of a pile of
 * `count` cards being fanned on hover.
 *
 * The cascade is anchored on the visual TOP card: it keeps its resting spot
 * and everything under it slides up-screen, so each member's top edge — and
 * with it the title band — peeks out above the card covering it, solitaire
 * tableau style. Anchoring on the top card (rather than on the hovered one)
 * also keeps the card under the pointer still, so fanning can't slide the
 * pile out from under the cursor and thrash the hover.
 *
 * `seatYaw` is the local player's seat rotation in radians (`degrees[seat]`):
 * "down-screen" is +Z for seat 0 and rotates with the seat.
 */
export function fanOffset(
	index: number,
	count: number,
	seatYaw: number,
	step = CARD_FAN_STEP
): [number, number] {
	const distance = (index - (count - 1)) * step; // ≤ 0 — the top card holds still
	return [Math.sin(seatYaw) * distance, Math.cos(seatYaw) * distance];
}
