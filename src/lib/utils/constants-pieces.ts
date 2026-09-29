import type { DieSides } from '../store/game/types';
import { TABLE_TOP_Y } from './constants-table';

/** Thickness of a flat token/counter disc */
export const PIECE_THICKNESS = 0.16;

/** Resting height of a piece centre: table top + half the disc thickness */
export const PIECE_REST_Y = TABLE_TOP_Y + PIECE_THICKNESS / 2;

/** Footprint radius used when a piece doesn't declare one */
export const PIECE_DEFAULT_RADIUS = 0.75;

/** Height a piece floats at while being dragged */
export const PIECE_DRAG_Y = 1.2;

/**
 * Radius a hand-spawned piece is given per kind. Tokens and counters are flat
 * discs; pawns are procedural (base + stem + head) but sized off the same
 * radius. These match what the TTS parser assigns, so imported and
 * hand-spawned pieces of the same kind come out the same size.
 *
 * A die's radius is its circumradius — the distance from its centre to a
 * corner — so every shape from a d4 to a d20 occupies the same envelope.
 */
export const PIECE_RADIUS = {
	token: PIECE_DEFAULT_RADIUS,
	pawn: 0.3,
	counter: 0.6,
	die: 0.55,
	bag: 0.9,
	// footprint circumradius of a 1×1-cell catalog tile (cell = 2.0 world);
	// the catalog browser overrides this per model from the manifest footprint
	model: 1.42
} as const;

/** Starting max for a hand-spawned health dial */
export const COUNTER_MAX_DEFAULT = 20;

/** Die shapes the primitive library can build, in spawn-menu order */
export const DIE_SIDES: readonly DieSides[] = [4, 6, 8, 10, 12, 20];

/** What a die spawns as when nothing says otherwise */
export const DIE_SIDES_DEFAULT: DieSides = 6;

/** Peak of the tumble arc, above the die's resting height */
export const DIE_LIFT_Y = 1.5;

/** Height of the bag pouch, drawn upward from the piece origin */
export const BAG_HEIGHT = 1.2;

/** Gap between the bag's edge and where a drawn item lands */
export const BAG_DRAW_GAP = 0.75;

/** Landing spots in the first ring around a bag before draws step outward */
export const BAG_DRAW_SLOTS = 8;

/**
 * Where a drawn item lands: stepping round a ring beside the bag so successive
 * draws sit side by side instead of piling on one spot. `index` is any
 * monotonically-changing number — the caller uses the table's entity count, so
 * the ring advances by one per draw. Returns the table-plane [x, z]; the caller
 * clamps it to the felt and supplies the resting height.
 */
export function bagDrawOffset(radius: number, index: number): { x: number; z: number } {
	const slot = ((index % BAG_DRAW_SLOTS) + BAG_DRAW_SLOTS) % BAG_DRAW_SLOTS;
	const ring = Math.floor(Math.abs(index) / BAG_DRAW_SLOTS);
	const distance = radius + BAG_DRAW_GAP + ring * BAG_DRAW_GAP;
	const theta = (slot / BAG_DRAW_SLOTS) * Math.PI * 2;
	const round = (v: number) => Math.round(v * 1000) / 1000;
	return { x: round(Math.cos(theta) * distance), z: round(Math.sin(theta) * distance) };
}

/**
 * Surface roughness of tokens, counters and pawns: a lacquered-chip finish
 * that picks up the environment's highlights instead of three.js's dead-matte
 * default of 1. Bags stay cloth-rough.
 */
export const PIECE_CHIP_ROUGHNESS = 0.38;
