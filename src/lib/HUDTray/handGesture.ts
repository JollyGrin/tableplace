import { writable } from 'svelte/store';

/**
 * A hand card being dragged along the fan (tableplace-195): which card, where
 * the pointer has it (tray-local x) and the slot it would land in. Local and
 * render-only — the new order is one patch, sent on release.
 *
 * A module store rather than HUDTrayScene state because the hint bar reads it.
 */
export const handGesture = writable<{
	id: string;
	reordering: true;
	x: number;
	index: number;
} | null>(null);

/**
 * While a table card is carried over the hand: the slot it would go into,
 * which the fan opens a gap at and the drop commits to. Null otherwise.
 */
export const handDropIndex = writable<number | null>(null);
