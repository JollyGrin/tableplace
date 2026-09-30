import { DEG2RAD } from 'three/src/math/MathUtils.js';
import type { GameDTO, PieceDTO } from '$lib/store/game/types';
import { TABLE_FEATURES_DEFAULT, type TableFeatures } from '$lib/store/tableFeatures';
import {
	CARD_WIDTH,
	CARD_HEIGHT,
	CARD_REST_Y,
	deckHeightForCount
} from '$lib/utils/constants-cards';
import { PIECE_DEFAULT_RADIUS, PIECE_REST_Y } from '$lib/utils/constants-pieces';
import { EDGE_MARGIN, TABLE_HALF_X, TABLE_HALF_Z, TABLE_TOP_Y } from '$lib/utils/constants-table';
import { tokenFootprint } from '$lib/primitives/token-shape';
import { resolveStack } from './stacking';
import { applySnapRotation, resolveSnap, type SnapResolution } from './snap';

export type DropKind =
	/** lands on bare felt (or an overlay) */
	| 'table'
	/** lands on top of one or more cards already at that spot */
	| 'stack'
	/** caught by an authored snap point: lands exactly on it */
	| 'snap'
	/** returns to a deck instead of the table */
	| 'deck'
	/** goes into a bag's hidden contents instead of the table */
	| 'bag'
	/** goes into the local player's hand tray */
	| 'tray';

export type DropFootprint =
	| { shape: 'rect'; w: number; h: number }
	| { shape: 'circle'; r: number };

export interface DropTarget {
	kind: DropKind;
	/** deck id when kind === 'deck', bag piece id when kind === 'bag' */
	targetId?: string;
	/** where the entity's origin ends up — exactly what the commit writes */
	position: [number, number, number];
	/** the entity's rotation on landing (degrees, matching the DTOs) */
	rotation: [number, number, number];
	/** shape of the shadow the entity casts on the surface it lands on */
	footprint: DropFootprint;
	/**
	 * Height to draw the footprint at. Same as `position[1]` for cards (they
	 * lie flat), but the table surface for pieces — a token's origin sits half
	 * a disc above the felt, and the footprint belongs on the felt.
	 */
	footprintY: number;
	/**
	 * Set when `kind === 'snap'`: the point that caught the drop — its id, its
	 * catch radius (the preview draws it), and the yaw it authored, if any, so
	 * the commit can tell "this drop turned the entity" from "this drop only
	 * moved it" without diffing rotations. `grid` is set when the catcher was
	 * a grid cell, so the preview can draw the cell instead of a ring.
	 */
	snap?: {
		id: string;
		radius: number;
		rotation?: number;
		grid?: { pitch: number; rotation: number };
	};
}

export interface DropHover {
	/** id of the deck currently under the pointer, if any */
	deckId?: string | null;
	/** id of the bag piece currently under the pointer, if any */
	bagId?: string | null;
	/** whether the pointer is over the hand tray */
	tray?: boolean;
}

export interface DropOptions {
	/**
	 * Alt held at release: place the card exactly where the pointer is, with
	 * no XZ square-up onto a nearby pile and no pull onto an authored snap
	 * point. The escape hatch for laying cards out next to each other on
	 * purpose. Height still merges — an overlapping card rests on top of what
	 * is under it, because coplanar cards z-fight (see resolveStack).
	 */
	noSnap?: boolean;
	/**
	 * Whether the route mounted a hand tray (see `store/tableFeatures`).
	 * Defaults to true; `/create` passes false, and then a tray hover — which
	 * can arrive stale from a previous `/play` visit, the flag being
	 * module-global — can't win a drop the editor has no way to represent.
	 */
	hand?: TableFeatures['hand'];
	/**
	 * A second floor source, for surfaces that aren't snap points: the model
	 * catalog (tableplace-135) injects raycast surface height over model
	 * meshes here — rudimentary collision. The effective floor for a landing
	 * is `snap.y ?? surfaceYAt?.(x, z) ?? TABLE_TOP_Y`. Left undefined by
	 * every current caller; it exists so #135 can plug in without touching
	 * the precedence rules.
	 */
	surfaceYAt?: (x: number, z: number) => number | undefined;
	/**
	 * Width / height of the dragged piece's face image, when the caller has it
	 * loaded (tableplace-254): a square token whose art is not 1:1 is a
	 * rectangle of that aspect, and its footprint follows. Only the preview
	 * passes it — the commit writes a position and a rotation, never a
	 * footprint — and it defaults to 1.
	 */
	faceAspect?: number;
}

/** What the caught drop reports back about the point that caught it. */
function snapInfo(snap: SnapResolution): NonNullable<DropTarget['snap']> {
	return {
		id: snap.id,
		radius: snap.radius,
		...(snap.rotation !== undefined ? { rotation: snap.rotation } : {}),
		...(snap.grid ? { grid: snap.grid } : {})
	};
}

/**
 * Whether the entity `id` is pulled by snap points at all: every card and
 * deck is, a piece unless it authors `snap: false`. The one rule both the
 * resolver and the lift-time snap guides read, so the guides never promise a
 * pull the drop won't make.
 */
export function entitySnaps(state: Partial<GameDTO> | undefined | null, id: string): boolean {
	if (id.startsWith('piece:')) {
		const piece = state?.pieces?.[id];
		return !!piece && piece.snap !== false;
	}
	if (id.startsWith('deck:')) return !!state?.decks?.[id];
	return !!state?.cards?.[id];
}

/** Keep a drop a margin inside the felt edge. */
export function clampToTable(x: number, z: number): [number, number] {
	return [
		Math.min(Math.max(x, -TABLE_HALF_X + EDGE_MARGIN), TABLE_HALF_X - EDGE_MARGIN),
		Math.min(Math.max(z, -TABLE_HALF_Z + EDGE_MARGIN), TABLE_HALF_Z - EDGE_MARGIN)
	];
}

/**
 * Resolve where the entity currently being dragged would land if it were
 * released right now.
 *
 * This is the single source of truth for the drop: `DropIndicator` draws it
 * and `Table.handleDragEnd` commits it, so the preview cannot promise a
 * landing the release won't honour.
 *
 * `rawPoint` is the unclamped table raycast hit; when it's missing (pointer
 * off the table plane) the entity's own position is used instead so a drag
 * keeps previewing.
 *
 * The order is aimed-at targets first, proximity effects second, because a
 * target you pointed at should never lose to one you merely drifted near:
 *
 * - a **bag** under the pointer swallows a card or a piece (not a deck, and
 *   never another bag) — the tray still beats it for a card;
 * - **pieces** and whole **decks** then only ever settle: felt position, pulled
 *   onto an authored snap point if one catches them;
 * - a **card** goes: hand tray, hovered deck, Alt's opt-out, an authored snap
 *   point within radius, then the loose-pile square-up.
 *
 * A snap point beats a pile because it is authored intent rather than a side
 * effect of where cards drifted; Alt opts out of every kind of snapping at
 * once, but not out of the aimed-at targets.
 *
 * `options` carries what the release itself asks for (`noSnap`, from Alt) and
 * what the route actually mounted (`hand`): a target that isn't on screen
 * can't win a drop, even if a stale hover flag says the pointer is over it.
 * Both call sites — the indicator's preview and the commit — pass the same
 * object, which is what keeps the preview honest.
 */
export function resolveDrop(
	state: Partial<GameDTO> | undefined | null,
	dragId: string | null | undefined,
	rawPoint: { x: number; z: number } | null | undefined,
	hover: DropHover = {},
	options: DropOptions = {}
): DropTarget | null {
	const hasHand = options.hand ?? TABLE_FEATURES_DEFAULT.hand;
	if (!dragId) return null;

	const isPiece = dragId.startsWith('piece:');
	const isDeck = dragId.startsWith('deck:');
	const entity = isPiece
		? state?.pieces?.[dragId]
		: isDeck
			? state?.decks?.[dragId]
			: state?.cards?.[dragId];
	if (!entity) return null;

	const [ex = 0, , ez = 0] = entity.position ?? [];
	const [x, z] = clampToTable(rawPoint?.x ?? ex, rawPoint?.z ?? ez);
	const rotation = (entity.rotation ?? [0, 0, 0]) as [number, number, number];

	// the entity's current table yaw in DEGREES clockwise, whatever unit, slot
	// and sign its kind stores it in — a grid cell's yaw stepping rounds this.
	// A deck's radians run the other way round (see `turnYaw`), hence the flip.
	const entityYaw = isDeck
		? -(rotation[1] ?? 0) / DEG2RAD
		: isPiece
			? (rotation[1] ?? 0)
			: (rotation[2] ?? 0);

	// An authored snap point pulls the landing onto itself. Alt opts out — it is
	// already the "put it exactly where I said" modifier — as does a piece
	// authored with `snap: false`; the aimed-at targets (bag, deck, tray) still
	// beat proximity either way.
	const snap =
		options.noSnap || !entitySnaps(state, dragId)
			? null
			: resolveSnap(state?.snapPoints, x, z, entityYaw);

	/**
	 * The local floor a landing rests on — the one seam elevation flows
	 * through: an elevated snap point's `y` first, then whatever surface the
	 * route injects (model meshes, tableplace-135), then the felt. Every rest
	 * height below is computed exactly as it always was, with this substituted
	 * for the table top.
	 */
	const floorAt = (fx: number, fz: number, snapY?: number) =>
		snapY ?? options.surfaceYAt?.(fx, fz) ?? TABLE_TOP_Y;

	// A bag swallows what is dropped on it — cards and pieces alike — so it is
	// resolved before the piece branch, and before the snap pull those branches
	// apply. Pointing at a pouch is an aimed-at gesture, the way a deck and the
	// tray are; a snap point catching the same spot is proximity. Alt does not
	// opt out of it either, for the same reason it does not opt out of a deck.
	//
	// What a bag never swallows — each of these settles (or snaps) instead, so a
	// drop the bag would refuse can't leave the entity floating at drag height:
	// - a bag (containers don't nest — docs/packs.md), or the bag itself;
	// - a die: `contents` has no die item, so its `sides` and roll state have
	//   nowhere to live and `returnToBag` refuses it. A die is for rolling on
	//   the table, not for storing;
	// - a whole deck: likewise no deck item in `contents`;
	// - a card while the hand tray is under the pointer too: your hand is the
	//   most explicit target there is, and the HUD tray draws in front of the
	//   table, so both can be "under" one pointer. Pieces can't enter the tray
	//   at all, so for them the bag always wins.
	const draggedKind = isPiece && 'kind' in entity ? entity.kind : undefined;
	const trayWins = !isPiece && !isDeck && hover.tray && hasHand;
	const bagSwallows =
		hover.bagId &&
		!isDeck &&
		!trayWins &&
		hover.bagId !== dragId &&
		draggedKind !== 'bag' &&
		draggedKind !== 'die' &&
		// a model is refused for the die's reason: no bag item can carry its
		// catalog ref, so returnToBag would quietly turn a room into a token
		draggedKind !== 'model';
	if (bagSwallows) {
		const bag = state?.pieces?.[hover.bagId as string];
		if (bag?.kind === 'bag') {
			const [bx = x, , bz = z] = bag.position ?? [];
			return {
				kind: 'bag',
				targetId: hover.bagId as string,
				position: [bx, PIECE_REST_Y, bz],
				rotation,
				footprint: { shape: 'circle', r: bag.radius ?? PIECE_DEFAULT_RADIUS },
				footprintY: TABLE_TOP_Y
			};
		}
	}

	// pieces don't stack, join decks, or enter the tray — they just settle
	if (isPiece) {
		const [px, pz] = snap ? [snap.x, snap.z] : [x, z];
		const floor = floorAt(px, pz, snap?.y);
		return {
			kind: snap ? 'snap' : 'table',
			position: [px, floor + (PIECE_REST_Y - TABLE_TOP_Y), pz],
			rotation: applySnapRotation(rotation, snap?.rotation, 'piece'),
			// a square token lands as the rectangle it is, not as a circle round it
			footprint: tokenFootprint(entity as Partial<PieceDTO>, options.faceAspect),
			footprintY: floor,
			...(snap ? { snap: snapInfo(snap) } : {})
		};
	}

	// decks don't nest, stack, or enter the tray: a dragged pile settles on
	// the felt wherever it's pointed, centred at half its body height (the
	// group origin is the slab's middle, not its base) — or exactly on an
	// authored snap point when one catches it.
	//
	// A snap only ever moves the deck in XZ and turns it: `restY` stays its own
	// half-height, because a deck landing on an occupied point still doesn't
	// stack. And the yaw goes in as radians of the opposite sign here, unlike a
	// card's — see applySnapRotation.
	if (isDeck) {
		const count = ('cards' in entity ? entity.cards : undefined)?.length ?? 0;
		const [dx, dz] = snap ? [snap.x, snap.z] : [x, z];
		const floor = floorAt(dx, dz, snap?.y);
		const restY = floor + deckHeightForCount(count) / 2;
		return {
			kind: snap ? 'snap' : 'table',
			position: [dx, restY, dz],
			rotation: applySnapRotation(rotation, snap?.rotation, 'deck'),
			footprint: { shape: 'rect', w: CARD_WIDTH, h: CARD_HEIGHT },
			footprintY: floor,
			...(snap ? { snap: snapInfo(snap) } : {})
		};
	}

	const footprint = { shape: 'rect', w: CARD_WIDTH, h: CARD_HEIGHT } as const;

	// the tray wins over a deck: dropping into your hand is the more explicit
	// gesture, and the two hover states can briefly overlap. No hand on this
	// route (the pack editor) and the card just lands on the table instead.
	if (hover.tray && hasHand) {
		return {
			kind: 'tray',
			position: [x, CARD_REST_Y, z],
			rotation,
			footprint,
			footprintY: CARD_REST_Y
		};
	}

	if (hover.deckId) {
		const deck = state?.decks?.[hover.deckId];
		const [dx, , dz] = deck?.position ?? [x, CARD_REST_Y, z];
		return {
			kind: 'deck',
			targetId: hover.deckId,
			position: [dx, CARD_REST_Y, dz],
			rotation: (deck?.rotation ?? rotation) as [number, number, number],
			footprint,
			footprintY: CARD_REST_Y
		};
	}

	// Alt beats the pile's pull, not its height: commit at the pointer, but
	// still rest on top of whatever the card overlaps — coplanar cards z-fight
	// (see resolveStack), and resting on top is physics, not snapping. Checked
	// after the deck and tray, which are aimed-at targets rather than a side
	// effect of proximity.
	if (options.noSnap) {
		const stack = resolveStack(state?.cards, dragId, x, z, floorAt(x, z));
		return {
			kind: stack.count > 0 ? 'stack' : 'table',
			position: [x, stack.restY, z],
			rotation,
			footprint,
			footprintY: stack.restY
		};
	}

	// A caught card commits on the point exactly, but still stacks: the resting
	// height comes from whatever is already sitting there — relative to the
	// point's own floor when it authors one, so a card dropped on a card on an
	// elevated point lands on top of it, not inside it.
	if (snap) {
		const floor = floorAt(snap.x, snap.z, snap.y);
		const stack = resolveStack(state?.cards, dragId, snap.x, snap.z, floor);
		return {
			kind: 'snap',
			position: [snap.x, stack.restY, snap.z],
			rotation: applySnapRotation(rotation, snap.rotation, 'card'),
			footprint,
			footprintY: stack.restY,
			snap: snapInfo(snap)
		};
	}

	// landing on a pile squares up to its base XZ (resolveStack), so cards
	// dropped roughly together settle into a neat stack instead of a fan
	const stack = resolveStack(state?.cards, dragId, x, z, floorAt(x, z));
	return {
		kind: stack.count > 0 ? 'stack' : 'table',
		position: [stack.x, stack.restY, stack.z],
		rotation,
		footprint,
		footprintY: stack.restY
	};
}
