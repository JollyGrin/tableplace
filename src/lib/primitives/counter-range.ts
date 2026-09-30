/**
 * The span a counter's value lives in (tableplace-253): `[minValue, maxValue]`.
 * A dial that reads 3–17, a round tracker that counts 1–12 and a score wheel
 * that goes negative are all the same primitive with a different floor.
 *
 * One definition, so the clamp (`incrementCounter`), the rim arc
 * (`counter-dial.ts`) and the file validators can never disagree about where
 * a counter starts and stops. Nothing here knows what the number means.
 */

import { COUNTER_MAX_UNSET } from '../utils/constants-pieces';

export type CounterBounds = {
	/** lowest value the counter can show; omitted means 0 */
	minValue?: number;
	maxValue?: number;
};

export type CounterRange = { min: number; max: number };

/**
 * A counter's range. `fallbackMax` is what an absent `maxValue` means to the
 * caller: a live piece runs open-ended to `COUNTER_MAX_UNSET`, a pack piece
 * spawns with `COUNTER_MAX_DEFAULT`.
 */
export function counterRange(
	bounds: CounterBounds,
	fallbackMax: number = COUNTER_MAX_UNSET
): CounterRange {
	return { min: bounds.minValue ?? 0, max: bounds.maxValue ?? fallbackMax };
}

/** `value` held inside the range. A floor above the ceiling resolves to the ceiling. */
export function clampToRange(value: number, { min, max }: CounterRange): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Why `value` cannot be this counter's value, naming both bounds — or null
 * when it fits. The sentence completes "`<path>.value` …".
 */
export function counterValueRefusal(value: number, { min, max }: CounterRange): string | null {
	if (value >= min && value <= max) return null;
	return `must be between ${min} and ${max}, got ${value}`;
}
