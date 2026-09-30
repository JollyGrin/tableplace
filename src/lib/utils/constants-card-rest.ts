/**
 * The two numbers that say where a card lies on the felt. They live apart from
 * `constants-cards.ts` (which re-exports them) because that module builds
 * three.js geometry on import, and the headless composer (`compose/`) has to
 * place loose cards without loading a renderer.
 */

/**
 * Cards need real thickness so stacked cards never share a plane —
 * coplanar surfaces z-fight regardless of depth-buffer precision.
 */
export const CARD_THICKNESS = 0.03;

/** Resting height of a card lying directly on the table/overlay */
export const CARD_REST_Y = 0.26;
