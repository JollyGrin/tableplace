/**
 * The hand (tableplace-195), as pure functions over state: the order its
 * cards sit in, the fan they are drawn in, which face a play lands on, and
 * which back a card shows when it leaves face-down. `HUDTray/*` only draws
 * and wires pointers to these.
 *
 * Relative imports only: the scenario parser reads `validHandPlayFace` and
 * is loaded by the schema scripts outside Vite.
 */

import type { CardDTO, GameDTO, HandPlayFace } from '../store/game/types';

type Tray = Record<string, Partial<CardDTO | null> | null | undefined> | undefined;

export function validHandPlayFace(value: unknown): HandPlayFace | undefined {
	return value === 'down' || value === 'up' ? value : undefined;
}

/** the table's default play face: the scenario's, else face-down */
export function handPlayFace(game: Partial<GameDTO> | undefined): HandPlayFace {
	return validHandPlayFace(game?.table?.handPlayFace) ?? 'down';
}

/** the face a play lands on: the table's default, the other one with Shift held */
export function playFace(defaultFace: HandPlayFace, shift: boolean): HandPlayFace {
	if (!shift) return defaultFace;
	return defaultFace === 'down' ? 'up' : 'down';
}

/**
 * The hand's card ids, left to right: by `handOrder`, cards without one after
 * every numbered card in the order the record holds them. Deleted (null)
 * entries are skipped.
 */
export function handOrderOf(tray: Tray): string[] {
	const entries = Object.entries(tray ?? {}).filter(([, card]) => !!card);
	return entries
		.map(([id, card], index) => ({ id, index, order: card?.handOrder }))
		.sort((a, b) => {
			const ao = typeof a.order === 'number' ? a.order : Infinity;
			const bo = typeof b.order === 'number' ? b.order : Infinity;
			return ao === bo ? a.index - b.index : ao - bo;
		})
		.map((entry) => entry.id);
}

/** the sort key for a card joining the right-hand end of `tray` */
export function nextHandOrder(tray: Tray): number {
	let max = -1;
	for (const card of Object.values(tray ?? {})) {
		if (typeof card?.handOrder === 'number' && card.handOrder > max) max = card.handOrder;
	}
	return Math.max(max + 1, Object.keys(tray ?? {}).length);
}

/**
 * `order` with `id` moved to `toIndex` (clamped), or appended when it is not
 * in `order` yet.
 */
export function moveInOrder(order: readonly string[], id: string, toIndex: number): string[] {
	const rest = order.filter((other) => other !== id);
	const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
	return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The tray patch that makes the hand read `order`, left to right: a
 * `handOrder` for every card whose key is not already its index. One patch,
 * so a reorder is one message however far a card moved.
 */
export function handOrderPatch(
	tray: Tray,
	order: readonly string[]
): Record<string, { handOrder: number }> {
	const patch: Record<string, { handOrder: number }> = {};
	order.forEach((id, index) => {
		if (tray?.[id]?.handOrder !== index) patch[id] = { handOrder: index };
	});
	return patch;
}

// ---- the fan ----------------------------------------------------------------

/** a hand card's art at scale 1, in HUD units (portrait) */
export const HAND_CARD_W = 1.96;
export const HAND_CARD_H = 2.8;
/** a resting hand card's scale */
export const HAND_REST_SCALE = 0.55;
/** the hovered card: raised and enlarged */
export const HAND_HOVER_SCALE = 1.5;
/** neighbours overlap: the pitch at rest is this share of a card's width */
const HAND_PITCH = 0.78;
/** the arc: degrees of tilt per card from the middle, and the most the ends tilt */
const FAN_STEP_DEG = 4;
const FAN_MAX_DEG = 14;
/** how far the ends of the arc sit below its middle, per card from the middle, squared */
const FAN_DROP = 0.012;
/** space kept between the fan and the viewport's edges, HUD units */
export const HAND_MARGIN = 0.12;

export type FanSlot = {
	/** centre, tray-local (the tray's centre is 0,0) */
	x: number;
	y: number;
	/** tilt, radians, counter-clockwise positive */
	angle: number;
};

/** half-extents of a w×h box turned by `angle` */
function turnedHalf(w: number, h: number, angle: number): { hw: number; hh: number } {
	const c = Math.abs(Math.cos(angle));
	const s = Math.abs(Math.sin(angle));
	return { hw: (w / 2) * c + (h / 2) * s, hh: (w / 2) * s + (h / 2) * c };
}

/** a resting card's on-screen footprint: a landscape card lies on its side */
export function restSize(landscape: boolean): { w: number; h: number } {
	const w = HAND_CARD_W * HAND_REST_SCALE;
	const h = HAND_CARD_H * HAND_REST_SCALE;
	return landscape ? { w: h, h: w } : { w, h };
}

/**
 * Lay `landscape.length` cards out in an arc across a tray `trayWidth` wide
 * and `trayHeight` tall, sitting on the viewport's bottom edge. The arc tilts
 * the ends and drops them a little; neighbours overlap, and a hand too wide
 * for the viewport squeezes its pitch until every turned corner is inside
 * it, however many cards (the tray is the viewport's full width).
 */
export function fanLayout(
	landscape: readonly boolean[],
	trayWidth: number,
	trayHeight: number
): FanSlot[] {
	const n = landscape.length;
	if (n === 0) return [];
	const mid = (n - 1) / 2;
	const step = n > 1 ? Math.min(FAN_STEP_DEG, (2 * FAN_MAX_DEG) / (n - 1)) : 0;
	// tilt the other way from the middle out: the fan opens upward
	const angles = landscape.map((_, i) => (-(i - mid) * step * Math.PI) / 180);
	const sizes = landscape.map(restSize);
	const halves = sizes.map(({ w, h }, i) => turnedHalf(w, h, angles[i]!));

	// natural pitch between neighbours, then squeezed to fit
	const gaps = sizes.slice(1).map(({ w }, i) => ((sizes[i]!.w + w) / 2) * HAND_PITCH);
	const natural = gaps.reduce((sum, gap) => sum + gap, 0);
	const room = trayWidth - 2 * HAND_MARGIN - halves[0]!.hw - halves[n - 1]!.hw;
	const squeeze = natural > 0 && natural > room ? Math.max(0, room) / natural : 1;

	const xs: number[] = [0];
	gaps.forEach((gap) => xs.push(xs[xs.length - 1]! + gap * squeeze));
	const shift = (xs[0]! - halves[0]!.hw + xs[n - 1]! + halves[n - 1]!.hw) / 2;

	// the arc drops the ends; then the whole fan sits on the bottom margin
	const drops = landscape.map((_, i) => -FAN_DROP * (i - mid) ** 2);
	const lowest = Math.min(...drops.map((drop, i) => drop - halves[i]!.hh));
	const lift = -trayHeight / 2 + HAND_MARGIN - lowest;

	return xs.map((x, i) => ({ x: x - shift, y: drops[i]! + lift, angle: angles[i]! }));
}

/**
 * Where the hovered card goes: straight up, raised and enlarged, but never
 * past a side of the viewport — the end cards of a wide hand would otherwise
 * grow off the screen.
 */
export function hoverX(x: number, landscape: boolean, trayWidth: number): number {
	const half = (landscape ? HAND_CARD_H : HAND_CARD_W) * HAND_HOVER_SCALE * 0.5;
	const limit = trayWidth / 2 - HAND_MARGIN - half;
	if (limit <= 0) return 0;
	return Math.max(-limit, Math.min(limit, x));
}

/** hovered: raised so its bottom edge still sits on the viewport's */
export function hoverY(landscape: boolean, trayHeight: number): number {
	const half = (landscape ? HAND_CARD_W : HAND_CARD_H) * HAND_HOVER_SCALE * 0.5;
	return -trayHeight / 2 + HAND_MARGIN + half;
}

/**
 * The slot a card dropped at tray-local `x` goes into, given where the
 * `count` slots of the fan sit: the number of slot centres left of it.
 */
export function slotAt(slots: readonly Pick<FanSlot, 'x'>[], x: number): number {
	let index = 0;
	for (const slot of slots) if (slot.x < x) index++;
	return Math.min(index, Math.max(0, slots.length - 1));
}

// ---- the back a card leaves face-down with ----------------------------------

/**
 * The back a hand card shows when it is played face-down: its own; else the
 * back every deck its holder owns shares (a card drawn before draws recorded
 * the back, or seeded into a hand bare, came from one of them); else the
 * backs of every deck on the table, if they agree; else undefined — the
 * caller's generic default.
 */
export function handCardBack(
	game: Partial<GameDTO> | undefined,
	playerId: string,
	card: Partial<CardDTO> | null | undefined
): string | undefined {
	if (card?.backImageUrl) return card.backImageUrl;
	const decks = Object.entries(game?.decks ?? {});
	const shared = (ids: [string, unknown][]) => {
		const backs = new Set(
			ids
				.map(([, deck]) => (deck as { deckBackImageUrl?: string } | null)?.deckBackImageUrl)
				.filter((back): back is string => !!back)
		);
		return backs.size === 1 ? backs.values().next().value : undefined;
	};
	const mine = decks.filter(([id]) => id.split(':')[1] === playerId);
	return (mine.length ? shared(mine) : undefined) ?? shared(decks);
}
