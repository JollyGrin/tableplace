import { TABLE_HALF_X, TABLE_HALF_Z } from './constants-table';

/** vertical field of view of the table camera, in degrees */
export const CAMERA_FOV_DEG = 35;

/** aspect the whole felt must fit at full zoom-out (16:10 — the narrowest common one) */
export const CAMERA_FRAME_ASPECT = 16 / 10;

/** default seat height, and the closest a content fit will sit (an empty table keeps it) */
export const CAMERA_DEFAULT_HEIGHT = 25;

/** breathing room around the content box when fitting the camera to it */
export const CAMERA_FIT_PADDING = 1.08;

/** closest the orbit may get */
export const CAMERA_MIN_DISTANCE = 1;

/**
 * Farthest the orbit may get. The felt is 60×30; framing its 60 width at 16:10
 * straight down takes 60 / 1.6 / (2·tan(17.5°)) ≈ 59.5 units of distance, but
 * the seat view (tableplace-185) looks at it from 45°, where the near edge sits
 * closer to the eye and the same frame takes ≈ 69.5. 72 leaves a small margin.
 * (The old 40 showed only ~40×25.) Wider aspects need less.
 */
export const CAMERA_MAX_DISTANCE = 72;

/**
 * How far a content fit may pull the camera out — past the orbit's normal max,
 * because a narrow (portrait) window framing the whole table from a seat needs
 * it. The orbit's max widens to match while that pose is home. Depth precision
 * still holds: at 150 the step is ~150²/(0.5·2²⁴) ≈ 0.003, under the 0.02
 * between card faces, and it stays inside the camera's far plane (200).
 */
export const CAMERA_FIT_MAX_DISTANCE = 150;

/** the seat view's tilt from vertical: sitting at the table, not over it */
export const CAMERA_SEAT_POLAR = Math.PI / 4;

/**
 * Top-down's tilt from vertical. Not zero: the few thousandths of a radian
 * toward the seat's own edge are what fix which way is "up" on screen, so each
 * seat still sees its own side at the bottom.
 */
export const CAMERA_TOP_POLAR = 0.005;

/** a preset move's length; `prefers-reduced-motion` cuts instead */
export const CAMERA_TWEEN_MS = 250;

/** focus never gets closer than this — a lone card fills the view, it does not clip */
export const CAMERA_FOCUS_MIN_DISTANCE = 9;

/** breathing room around a focused entity (a lot: you want to see what is next to it) */
export const CAMERA_FOCUS_PADDING = 2.2;

/** what an empty table frames: the middle of the felt, about what the old close-up showed */
export const CAMERA_EMPTY_BOUNDS = { minX: -11, maxX: 11, minZ: -7, maxZ: 7 } as const;

/** distance at which a camera looking straight down frames the felt at `aspect` */
export function distanceToFrameFelt(aspect: number): number {
	const halfTan = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
	return Math.max(TABLE_HALF_X / (aspect * halfTan), TABLE_HALF_Z / halfTan);
}
