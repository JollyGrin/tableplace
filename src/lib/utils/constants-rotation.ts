import { DEG2RAD } from 'three/src/math/MathUtils.js';

export const degrees = [0, DEG2RAD * 180, DEG2RAD * 90, DEG2RAD * 270] as const;

/**
 * How far Q and E turn a card, deck or piece, in degrees, when the table's
 * scenario sets no `rotationStep` (tableplace-200). T and R stay 90° taps.
 */
export const ROTATION_STEP_DEFAULT = 45;

/** the bounds an authored `rotationStep` must sit inside (degrees, exclusive min) */
export const ROTATION_STEP_MIN = 0;
export const ROTATION_STEP_MAX = 360;
