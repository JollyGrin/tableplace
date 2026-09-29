/**
 * Outbound camera-pose stream — the first consumer of the ephemeral message
 * tier sketched in SPEC.md §4c.
 *
 * Deliberately NOT routed through `gameStore.updateState`:
 *  - that wrapper only throttles `position` under `cards`/`pieces`, so a pose
 *    would take the immediate branch and fire at pointer-move rate, and
 *  - it sends `type:'update'`, which the server merges into the lobby's
 *    canonical state — poses would be persisted, inflate the `/view` state
 *    size and replay to every joiner.
 *
 * `type:'camera'` instead falls through the server's switch untouched and is
 * relayed to every peer but the sender (server/game/game.go) — pure relay,
 * never persisted, never in a `sync` snapshot.
 *
 * Budget: the server *disconnects* (it does not drop) at 7 msg/s sustained
 * with a burst bucket of 15 (server/lobby/lobby.go). Drag streaming already
 * owns 5 Hz of that, so the camera gets ≤ 3 Hz — leading edge plus one
 * trailing sample — and goes completely silent once the camera settles.
 *
 * The pointer (tableplace-197) rides the same message rather than a stream of
 * its own: the table-plane point under our cursor is one more optional field
 * on the sample, and a pointer that moved is one more reason to send inside
 * the SAME throttle. Orbiting and pointing together therefore cost exactly
 * what orbiting alone does. Older receivers read `p`/`t`/`seq` and never look
 * at the extra field.
 */

export type Vec3 = [number, number, number];
/** a point on the table plane: world `[x, z]` */
export type TablePoint = [number, number];

/** Wire payload of a `type:'camera'` message. ~60 bytes. */
export type CameraSample = {
	/** camera position */
	p: Vec3;
	/** orbit target the camera is looking at */
	t: Vec3;
	/** monotonic per-sender counter; receivers drop anything not newer */
	seq: number;
	/**
	 * The table-plane point under the sender's cursor. Absent while the
	 * cursor is off the canvas or off the felt — and from senders that
	 * predate pointers, which receivers therefore read the same way.
	 */
	c?: TablePoint;
};

/** ~2.9 Hz — see the rate budget above. */
export const CAMERA_STREAM_INTERVAL_MS = 350;
/** world units the eye must travel before a new sample is worth sending */
export const CAMERA_POSITION_EPSILON = 0.04;
/** the target moves far less than the eye during an orbit, so it gets a tighter gate */
export const CAMERA_TARGET_EPSILON = 0.02;
/**
 * world units the pointer must travel on the felt before it is worth a
 * packet — about a tenth of a card width; the receiver glides between samples
 * anyway, so finer than this buys nothing a peer could see
 */
export const POINTER_EPSILON = 0.15;

type Pose = { p: Vec3; t: Vec3 };
type Sample = Pose & { c: TablePoint | null };

function distance(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Hysteresis gate: has the pose moved enough to be worth a packet?
 * A camera nobody is touching returns false forever, which is what keeps an
 * idle client completely off the wire.
 */
export function poseChanged(
	previous: Pose,
	next: Pose,
	positionEpsilon = CAMERA_POSITION_EPSILON,
	targetEpsilon = CAMERA_TARGET_EPSILON
): boolean {
	return (
		distance(previous.p, next.p) > positionEpsilon || distance(previous.t, next.t) > targetEpsilon
	);
}

/**
 * Has the pointer moved enough to be worth a packet? Appearing or
 * disappearing always is — that is what shows or hides it for peers.
 */
export function pointerChanged(
	previous: TablePoint | null,
	next: TablePoint | null,
	epsilon = POINTER_EPSILON
): boolean {
	if (!previous || !next) return previous !== next;
	return Math.hypot(previous[0] - next[0], previous[1] - next[1]) > epsilon;
}

export type CameraStream = {
	/**
	 * Offer the current pose. Sends at most once per interval, and only when
	 * the pose (or the pointer) actually moved.
	 * @param force skip the movement gate (still throttled) — used to answer a
	 * peer joining, so they get an avatar without waiting for us to orbit.
	 * @param c the pointer's table point, when the move also moved it (a
	 * parked cursor sweeps the felt while the camera orbits under it) — one
	 * sample carries both. Omitted: the pointer is unchanged.
	 */
	offer(p: Vec3, t: Vec3, force?: boolean, c?: TablePoint | null): void;
	/**
	 * Offer the pointer's table point, or null once it left the canvas or the
	 * felt. Shares the pose's throttle and its seq: a pointer move becomes the
	 * next camera sample, never a message of its own. Held (not sent) until
	 * the first pose has been offered, since a sample needs a pose.
	 */
	point(c: TablePoint | null): void;
	/** cancel any queued trailing sample */
	dispose(): void;
};

export type CameraStreamOptions = {
	intervalMs?: number;
	positionEpsilon?: number;
	targetEpsilon?: number;
	pointerEpsilon?: number;
	/** injectable clock, for tests */
	now?: () => number;
};

/**
 * @param send delivers a sample; return `false` when it could not go out (not
 * connected yet) so the stream neither burns a seq nor records the pose as
 * already sent — otherwise hysteresis would suppress it forever and peers
 * would never see a camera that connected and then sat still.
 */
export function createCameraStream(
	send: (sample: CameraSample) => boolean | void,
	options: CameraStreamOptions = {}
): CameraStream {
	const intervalMs = options.intervalMs ?? CAMERA_STREAM_INTERVAL_MS;
	const positionEpsilon = options.positionEpsilon ?? CAMERA_POSITION_EPSILON;
	const targetEpsilon = options.targetEpsilon ?? CAMERA_TARGET_EPSILON;
	const pointerEpsilon = options.pointerEpsilon ?? POINTER_EPSILON;
	const now = options.now ?? Date.now;

	let seq = 0;
	let lastSent: Sample | null = null;
	let lastSentAt = Number.NEGATIVE_INFINITY;
	let pending: Sample | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** the newest pose and pointer offered, sent or not */
	let pose: Pose | null = null;
	let pointer: TablePoint | null = null;

	function emit(sample: Sample) {
		// no pointer is sent as no field at all — absent already means "none"
		const wire: CameraSample = { p: sample.p, t: sample.t, seq: seq + 1 };
		if (sample.c) wire.c = sample.c;
		if (send(wire) === false) return;
		seq += 1;
		lastSent = sample;
		lastSentAt = now();
	}

	function flushPending() {
		timer = null;
		if (!pending) return;
		const sample = pending;
		pending = null;
		emit(sample);
	}

	/** the one gate both halves go through — one throttle, one budget */
	function consider(force: boolean) {
		if (!pose) return;
		const sample: Sample = { p: pose.p, t: pose.t, c: pointer };

		// compare against the newest sample already committed to the wire (or
		// queued for it), so a settled camera under a still pointer stops
		// sending entirely
		const reference = pending ?? lastSent;
		if (
			!force &&
			reference &&
			!poseChanged(reference, sample, positionEpsilon, targetEpsilon) &&
			!pointerChanged(reference.c, sample.c, pointerEpsilon)
		)
			return;

		const elapsed = now() - lastSentAt;
		if (!timer && elapsed >= intervalMs) {
			emit(sample); // leading edge
			return;
		}
		// trailing: keep only the newest sample — unlike entity updates there is
		// nothing to coalesce, the latest pose and pointer supersede every earlier one
		pending = sample;
		if (!timer) timer = setTimeout(flushPending, Math.max(0, intervalMs - elapsed));
	}

	return {
		offer(p, t, force = false, c) {
			pose = { p: [p[0], p[1], p[2]], t: [t[0], t[1], t[2]] };
			if (c !== undefined) pointer = c ? [c[0], c[1]] : null;
			consider(force);
		},

		point(c) {
			pointer = c ? [c[0], c[1]] : null;
			consider(false);
		},

		dispose() {
			if (timer) clearTimeout(timer);
			timer = null;
			pending = null;
		}
	};
}
