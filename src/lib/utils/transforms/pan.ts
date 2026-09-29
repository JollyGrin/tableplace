/**
 * Screen-relative WASD panning, as pure maths — the component only owns the
 * held keys and the clock (see TableCamera.svelte).
 *
 * "Screen-relative" is the whole point: W is always *away from the viewer*,
 * whatever the orbit yaw is, so panning stays predictable after you have turned
 * the table around. That direction cannot come from the eye→target vector
 * alone: top-down (P) looks straight down, where that vector has almost no
 * horizontal component at all. The camera's own up axis does have one — at any
 * tilt it points up-screen — so the basis is taken from there, with the
 * eye→target vector as the fallback for a camera lying almost flat (where up is
 * nearly vertical instead).
 */

export type Vec3 = [number, number, number];
/** the pan basis on the table plane: unit XZ vectors for up-screen and right-screen */
export type PanBasis = { forward: [number, number]; right: [number, number] };

export const PAN_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;
export type PanKey = (typeof PAN_KEYS)[number];

export function isPanKey(code: string): code is PanKey {
	return (PAN_KEYS as readonly string[]).includes(code);
}

/** world units per second, scaled by how far out the camera is sitting */
export const PAN_SPEED_PER_DISTANCE = 0.55;
export const PAN_SPEED_MIN = 4;
export const PAN_SPEED_MAX = 26;

/** how far past the felt's own footprint (60 x 30) the target may wander */
export const PAN_LIMIT_X = 42;
export const PAN_LIMIT_Z = 26;

function normalize2(x: number, z: number): [number, number] | null {
	const length = Math.hypot(x, z);
	if (length < 1e-4) return null;
	return [x / length, z / length];
}

/**
 * @param up the camera's world up axis (matrixWorld's second column)
 * @param eye camera position
 * @param target what it orbits
 */
export function panBasis(up: Vec3, eye: Vec3, target: Vec3): PanBasis | null {
	const forward = normalize2(up[0], up[2]) ?? normalize2(target[0] - eye[0], target[2] - eye[2]);
	if (!forward) return null;
	// right = forward x worldUp, on the plane: (fx, 0, fz) x (0, 1, 0) = (-fz, 0, fx)
	return { forward, right: [-forward[1], forward[0]] };
}

export function panSpeed(eye: Vec3, target: Vec3): number {
	const distance = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
	return Math.min(PAN_SPEED_MAX, Math.max(PAN_SPEED_MIN, distance * PAN_SPEED_PER_DISTANCE));
}

/**
 * How far to shift camera and target this frame, on the table plane.
 *
 * Returns null when nothing moves — no keys, opposing keys, a degenerate basis
 * or a target already against the limit — so the caller can skip the update
 * entirely and leave the pose (and therefore the presence stream) untouched.
 */
export function panDelta(
	keys: Iterable<string>,
	up: Vec3,
	eye: Vec3,
	target: Vec3,
	deltaSeconds: number
): [number, number] | null {
	let forwardInput = 0;
	let rightInput = 0;
	for (const key of keys) {
		if (key === 'KeyW') forwardInput += 1;
		else if (key === 'KeyS') forwardInput -= 1;
		else if (key === 'KeyD') rightInput += 1;
		else if (key === 'KeyA') rightInput -= 1;
	}
	if (!forwardInput && !rightInput) return null;
	const basis = panBasis(up, eye, target);
	if (!basis) return null;

	const direction = normalize2(
		basis.forward[0] * forwardInput + basis.right[0] * rightInput,
		basis.forward[1] * forwardInput + basis.right[1] * rightInput
	);
	if (!direction) return null;

	const step = panSpeed(eye, target) * Math.max(0, Math.min(deltaSeconds, 0.1));
	// clamped against the TARGET, and the same delta is applied to the eye, so
	// the orbit relationship is never bent by hitting the edge
	const x = clampStep(target[0], direction[0] * step, PAN_LIMIT_X);
	const z = clampStep(target[2], direction[1] * step, PAN_LIMIT_Z);
	if (!x && !z) return null;
	return [x, z];
}

function clampStep(from: number, step: number, limit: number): number {
	return Math.max(-limit, Math.min(limit, from + step)) - from;
}
