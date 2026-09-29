/**
 * Weight (tableplace-203): the render-only motion that makes a carried entity
 * feel like it has mass — a lean against its travel, one small bounce on
 * landing, a hop through a flip. None of it is ever written to `GameDTO`.
 */

/** radians of lean per world unit per second of planar travel */
export const WEIGHT_LEAN_PER_SPEED = 0.012;

/**
 * The lean's cap, in degrees. A card's is lower than a piece's: legibility
 * beats feel, and a few degrees is as far as a face can tip before a
 * near-vertical camera starts to foreshorten its print.
 */
export const WEIGHT_LEAN_MAX_DEG = { card: 4, piece: 7 } as const;

/** how quickly the lean chases its target (per second, exponential) */
export const WEIGHT_LEAN_RESPONSE = 12;

/** the landing bounce's peak, in world units, above the rest height */
export const WEIGHT_BOUNCE_HEIGHT = { card: 0.05, piece: 0.08 } as const;

/** the landing bounce's whole arc, up and back down */
export const WEIGHT_BOUNCE_MS = 160;

/**
 * Within this of its rest height a falling entity counts as having touched
 * down — the moment its bounce starts.
 */
export const WEIGHT_CONTACT_EPSILON = 0.01;

/**
 * A drop that has not touched down by now gets no bounce. Guards a fall that
 * is interrupted (a re-grab, a stall snap) from bouncing long after the fact.
 */
export const WEIGHT_FALL_TIMEOUT_MS = 450;

/**
 * Store heights within this of the carry height read as "carried" — how a
 * remote drag, which reaches this client only as positions, is recognised.
 */
export const WEIGHT_CARRY_EPSILON = 0.02;

/** extra lift at the middle of a flip, on top of the flip's clearance lift */
export const WEIGHT_FLIP_HOP = 0.4;
