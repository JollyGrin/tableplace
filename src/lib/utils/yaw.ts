import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { ROTATION_STEP_MAX, ROTATION_STEP_MIN } from './constants-rotation';

/**
 * Table yaw, per kind (tableplace-200).
 *
 * The three entity kinds do not agree on where — or in what unit — their yaw
 * lives, and a turn written in the wrong slot or unit has shipped before (see
 * `applySnapRotation`). Every turn goes through here, so the conventions are
 * written down once:
 *
 * - **card** — `rotation[2]`, **degrees**, rendered as `-z` (`Card.svelte`),
 *   so a positive delta turns it clockwise seen from above. `rotation[0]` is
 *   the face-down flip and is never touched.
 * - **piece** — `rotation[1]`, **degrees**, rendered as `-y` (`Piece.svelte`):
 *   positive is clockwise, the same sign as a card.
 * - **deck** — `rotation[1]`, **radians**, handed to its group as is
 *   (`Deck.svelte`): positive is COUNTER-clockwise, so a clockwise turn
 *   subtracts (the same sign flip `groupStackIntoDeck` makes).
 */
export type YawKind = 'card' | 'deck' | 'piece';

/** `value` wrapped into [0, period) */
function wrap(value: number, period: number): number {
	return ((value % period) + period) % period;
}

/** rounded so repeated turns never accumulate float noise on the wire */
function tidy(value: number, places = 1e9): number {
	return Math.round(value * places) / places;
}

/**
 * `rotation` turned clockwise (seen from above) by `degrees` — negative turns
 * counter-clockwise. The yaw comes back wrapped to one turn, so the synced
 * number never grows without bound; the renderers take the shortest arc to it
 * (`nearestTurn`), so the wrap never shows as a spin.
 */
export function turnYaw(
	kind: YawKind,
	rotation: readonly number[] | undefined,
	degrees: number
): [number, number, number] {
	const [x = 0, y = 0, z = 0] = rotation ?? [];
	switch (kind) {
		case 'card':
			return [x, y, tidy(wrap(z + degrees, 360))];
		case 'piece':
			return [x, tidy(wrap(y + degrees, 360)), z];
		case 'deck': {
			// stepped in tidy degrees, stored as radians: a full circle of turns
			// comes back to exactly 0 rather than to 2π less a rounding error
			const clockwise = tidy(wrap(-y / DEG2RAD + degrees, 360));
			return [x, clockwise === 0 ? 0 : tidy((360 - clockwise) * DEG2RAD, 1e12), z];
		}
	}
}

/** the clockwise-from-above table yaw of `rotation`, in degrees within [0, 360) */
export function yawDegrees(kind: YawKind, rotation: readonly number[] | undefined): number {
	const [, y = 0, z = 0] = rotation ?? [];
	switch (kind) {
		case 'card':
			return tidy(wrap(z, 360));
		case 'piece':
			return tidy(wrap(y, 360));
		case 'deck':
			return wrap(tidy(wrap(-y / DEG2RAD, 360)), 360);
	}
}

/** an authored rotation step, or undefined when it is not one a turn can use */
export function validRotationStep(value: unknown): number | undefined {
	return typeof value === 'number' &&
		Number.isFinite(value) &&
		value > ROTATION_STEP_MIN &&
		value <= ROTATION_STEP_MAX
		? value
		: undefined;
}

/**
 * The value equivalent to `to` (modulo `period`) that is nearest `from` — what
 * a yaw spring should head for so a turn animates through the shortest arc:
 * 350° → 0° goes on to 360°, not back round through 180°.
 */
export function nearestTurn(from: number, to: number, period = 360): number {
	if (!Number.isFinite(from)) return to;
	const delta = wrap(to - from + period / 2, period) - period / 2;
	return from + delta;
}
