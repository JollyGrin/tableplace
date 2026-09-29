import { angleOf, type CameraPose, type Vec3 } from './camera-fit';

/** ease in and out: a preset move starts and lands softly instead of snapping */
export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** the shorter way round from `a` to `b`, in radians */
function lerpAngle(a: number, b: number, t: number): number {
	const turn = Math.PI * 2;
	const delta = ((((b - a) % turn) + turn * 1.5) % turn) - turn / 2;
	return a + delta * t;
}

function distanceOf({ position, target }: CameraPose): number {
	return Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
}

/**
 * The pose `t` (0–1) of the way from `from` to `to`, moved the way an orbit
 * moves: the target glides straight, and the eye swings round it on the
 * sphere (distance, tilt and bearing each interpolated) rather than cutting a
 * chord through it — a seat-to-top-down move arcs over the table instead of
 * diving at it.
 */
export function interpolatePose(from: CameraPose, to: CameraPose, t: number): CameraPose {
	const a = angleOf(from);
	const b = angleOf(to);
	const target: Vec3 = [
		lerp(from.target[0], to.target[0], t),
		lerp(from.target[1], to.target[1], t),
		lerp(from.target[2], to.target[2], t)
	];
	const distance = lerp(distanceOf(from), distanceOf(to), t);
	const polar = lerp(a.polar, b.polar, t);
	const azimuth = lerpAngle(a.azimuth, b.azimuth, t);
	const s = Math.sin(polar);
	return {
		target,
		position: [
			target[0] + distance * s * Math.sin(azimuth),
			target[1] + distance * Math.cos(polar),
			target[2] + distance * s * Math.cos(azimuth)
		]
	};
}

export { distanceOf };
