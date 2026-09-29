/**
 * Where a ping's edge arrow goes (tableplace-198): a ping this client cannot
 * see gets an arrow on the rim of the view, pointing toward it.
 */

/** a point after `Vector3.project(camera)`: normalised device coordinates */
export type Ndc = { x: number; y: number; z: number };

export type EdgeArrow = {
	/** CSS pixels from the view's top-left */
	x: number;
	y: number;
	/** screen angle the arrow points at, in degrees clockwise from +x (right) */
	angle: number;
};

/** how far in from the view's edge the arrow sits, in CSS pixels */
export const EDGE_MARGIN_PX = 28;

/**
 * The arrow for a projected point, or null when the point is in view.
 *
 * A point behind the camera projects through the eye and comes out mirrored,
 * so its direction is flipped before it is pushed to the rim — otherwise the
 * arrow would point away from it.
 */
export function edgeArrow(
	ndc: Ndc,
	view: { width: number; height: number },
	margin = EDGE_MARGIN_PX
): EdgeArrow | null {
	const behind = ndc.z > 1;
	if (!behind && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) return null;

	const halfW = view.width / 2;
	const halfH = view.height / 2;
	// screen-space direction from the centre (y grows downwards)
	let dx = ndc.x * halfW;
	let dy = -ndc.y * halfH;
	if (behind) {
		dx = -dx;
		dy = -dy;
	}
	if (dx === 0 && dy === 0) dy = 1; // dead behind: point down, toward the seat

	const reachX = Math.max(0, halfW - margin);
	const reachY = Math.max(0, halfH - margin);
	// scale the direction until it meets the inset rectangle
	const scale = Math.min(
		dx === 0 ? Infinity : reachX / Math.abs(dx),
		dy === 0 ? Infinity : reachY / Math.abs(dy)
	);
	return {
		x: halfW + dx * scale,
		y: halfH + dy * scale,
		angle: (Math.atan2(dy, dx) * 180) / Math.PI
	};
}
