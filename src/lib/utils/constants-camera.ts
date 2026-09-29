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
 * takes 60 / 1.6 / (2·tan(17.5°)) ≈ 59.5 units of distance, and 62 leaves a
 * small margin. (The old 40 showed only ~40×25.) Wider aspects need less.
 */
export const CAMERA_MAX_DISTANCE = 62;

/** distance at which a camera looking straight down frames the felt at `aspect` */
export function distanceToFrameFelt(aspect: number): number {
	const halfTan = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
	return Math.max(TABLE_HALF_X / (aspect * halfTan), TABLE_HALF_Z / halfTan);
}
