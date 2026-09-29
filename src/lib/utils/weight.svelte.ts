/**
 * Weight (tableplace-203): a carried entity leans against its travel, lands
 * with one small bounce, and a card hops through a flip.
 *
 * Purely local rendering. Everything here is a render offset layered over the
 * springs each entity already draws through — the store never sees a lean or a
 * bounce, nothing new goes on the wire, and a remote drag (which reaches this
 * client only as positions) leans from its interpolated motion like a local
 * one does.
 *
 * Legibility beats feel: the lean is capped at a few degrees, and the bounce
 * only starts once the fall has touched down, so nothing delays a landing.
 * All of it is off under `prefers-reduced-motion`, behind the Settings toggle,
 * and while the frame loop is stalling (see frame-stall.svelte.ts: a spring
 * that cannot be integrated smoothly is only lying about where things are).
 */

import { writable } from 'svelte/store';
import { framesAreStalling } from '$lib/utils/frame-stall.svelte';
import {
	WEIGHT_BOUNCE_HEIGHT,
	WEIGHT_BOUNCE_MS,
	WEIGHT_CONTACT_EPSILON,
	WEIGHT_FALL_TIMEOUT_MS,
	WEIGHT_FLIP_HOP,
	WEIGHT_LEAN_MAX_DEG,
	WEIGHT_LEAN_PER_SPEED,
	WEIGHT_LEAN_RESPONSE
} from '$lib/utils/constants-weight';

const WEIGHT_KEY = 'weight:v1';

function readEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem(WEIGHT_KEY) !== 'off';
	} catch {
		return true;
	}
}

function readReducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let enabled = $state(readEnabled());
let reducedMotion = $state(readReducedMotion());

if (typeof matchMedia === 'function') {
	matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (event) => {
		reducedMotion = event.matches;
	});
}

/** the Settings toggle: on unless this browser switched it off */
export const weightEnabled = writable(enabled);

weightEnabled.subscribe((on) => {
	enabled = on;
	try {
		if (on) globalThis.localStorage?.removeItem(WEIGHT_KEY);
		else globalThis.localStorage?.setItem(WEIGHT_KEY, 'off');
	} catch {
		// private window or blocked storage: the setting lasts this session only
	}
});

/** whether weight is drawn at all. Reactive: read it in a `$derived` and it follows the toggle. */
export function weightOn(): boolean {
	return enabled && !reducedMotion;
}

const clamp = (value: number, cap: number) => Math.max(-cap, Math.min(cap, value));

/**
 * The lean for a planar velocity, as [rotation.x, rotation.z] radians in the
 * world frame: the top trails the travel — the leading edge lifts — by an
 * amount proportional to speed, each axis capped.
 */
export function leanFor(vx: number, vz: number, capRad: number): [number, number] {
	return [clamp(-vz * WEIGHT_LEAN_PER_SPEED, capRad), clamp(vx * WEIGHT_LEAN_PER_SPEED, capRad)];
}

/** the landing bounce's height `ms` into it: one half-sine arc, zero outside it */
export function bounceArc(ms: number, height: number, durationMs = WEIGHT_BOUNCE_MS): number {
	if (ms <= 0 || ms >= durationMs) return 0;
	return height * Math.sin((Math.PI * ms) / durationMs);
}

/**
 * The flip hop for a flip spring at `current` heading to `target` (degrees):
 * nothing at either end of the turn, the full hop at edge-on.
 */
export function flipHopFor(current: number, target: number): number {
	const remaining = Math.abs(target - current);
	if (remaining < 0.5 || remaining > 180) return 0;
	return WEIGHT_FLIP_HOP * Math.sin((Math.PI * (180 - remaining)) / 180);
}

/** what an entity's weight reads from it each frame */
export type WeightSample = {
	/** drawn planar position */
	x: number;
	z: number;
	/** drawn height, and the height it is settling to */
	y: number;
	rest: number;
	/** in a pointer's hand — this client's, or (from the store) a remote one */
	carried: boolean;
};

type Phase = 'idle' | 'falling' | 'bounce';

/**
 * One entity's weight. Runs its own animation frames only while there is
 * something to draw — carried, leaning back to level, or landing — and stops
 * itself afterwards, so a table at rest costs nothing.
 *
 * Svelte-safe by construction: `wake()` reads and writes only plain fields,
 * so an effect calling it gains no dependency on the `$state` the frame loop
 * writes (#102).
 */
export class Weight {
	/** lean about world x and z, radians — apply on a group wrapping the entity */
	tiltX = $state(0);
	tiltZ = $state(0);
	/** height to add to the drawn height: the landing bounce */
	lift = $state(0);

	#sample: () => WeightSample;
	#cap: number;
	#bounce: number;
	#frame = 0;
	#last = -1;
	#px = 0;
	#pz = 0;
	#tx = 0;
	#tz = 0;
	#wasCarried = false;
	#phase: Phase = 'idle';
	#phaseAt = 0;

	constructor(kind: 'card' | 'piece', sample: () => WeightSample) {
		this.#sample = sample;
		this.#cap = WEIGHT_LEAN_MAX_DEG[kind] * (Math.PI / 180);
		this.#bounce = WEIGHT_BOUNCE_HEIGHT[kind];
	}

	/** start drawing (if not already): call when the entity becomes carried */
	wake(): void {
		if (this.#frame || typeof requestAnimationFrame !== 'function') return;
		this.#last = -1;
		const tick = (now: number) => {
			this.#frame = this.step(now) ? requestAnimationFrame(tick) : 0;
		};
		this.#frame = requestAnimationFrame(tick);
	}

	/** stop and level out — unmount */
	stop(): void {
		if (this.#frame && typeof cancelAnimationFrame === 'function')
			cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#reset();
	}

	/**
	 * Advance one frame; returns whether another is needed. Public for the unit
	 * tests, which have no animation frames to drive it with.
	 */
	step(now: number): boolean {
		const s = this.#sample();
		const dt = this.#last < 0 ? 0 : Math.min(now - this.#last, 1000 / 30) / 1000;
		const first = this.#last < 0;
		this.#last = now;
		const vx = dt > 0 && !first ? (s.x - this.#px) / dt : 0;
		const vz = dt > 0 && !first ? (s.z - this.#pz) / dt : 0;
		this.#px = s.x;
		this.#pz = s.z;
		const landed = this.#wasCarried && !s.carried;
		this.#wasCarried = s.carried;

		if (!weightOn() || framesAreStalling()) {
			this.#reset();
			return s.carried;
		}

		const [gx, gz] = s.carried ? leanFor(vx, vz, this.#cap) : [0, 0];
		const k = 1 - Math.exp(-dt * WEIGHT_LEAN_RESPONSE);
		this.#tx += (gx - this.#tx) * k;
		this.#tz += (gz - this.#tz) * k;
		// a lean below a hundredth of a degree is not worth another frame
		if (!s.carried && Math.abs(this.#tx) < 2e-4 && Math.abs(this.#tz) < 2e-4) {
			this.#tx = 0;
			this.#tz = 0;
		}

		if (s.carried) this.#phase = 'idle';
		else if (landed) this.#to('falling', now);
		if (this.#phase === 'falling') {
			if (s.y <= s.rest + WEIGHT_CONTACT_EPSILON) this.#to('bounce', now);
			else if (now - this.#phaseAt > WEIGHT_FALL_TIMEOUT_MS) this.#to('idle', now);
		}
		let lift = 0;
		if (this.#phase === 'bounce') {
			const t = now - this.#phaseAt;
			if (t >= WEIGHT_BOUNCE_MS) this.#to('idle', now);
			// the height spring overshoots its rest a touch on the way down: the
			// bounce holds it at the surface instead of sinking into the felt
			else lift = Math.max(0, s.rest - s.y) + bounceArc(t, this.#bounce);
		}

		this.#write(this.#tx, this.#tz, lift);
		return s.carried || this.#phase !== 'idle' || this.#tx !== 0 || this.#tz !== 0;
	}

	#to(phase: Phase, now: number) {
		this.#phase = phase;
		this.#phaseAt = now;
	}

	#reset() {
		this.#tx = 0;
		this.#tz = 0;
		this.#phase = 'idle';
		this.#write(0, 0, 0);
	}

	// compared against plain mirrors, never the `$state` itself: `stop()` runs
	// in an effect teardown, and a read there would be a dependency
	#written = { tiltX: 0, tiltZ: 0, lift: 0 };

	#write(tiltX: number, tiltZ: number, lift: number) {
		const written = this.#written;
		if (written.tiltX !== tiltX) this.tiltX = written.tiltX = tiltX;
		if (written.tiltZ !== tiltZ) this.tiltZ = written.tiltZ = tiltZ;
		if (written.lift !== lift) this.lift = written.lift = lift;
	}
}
