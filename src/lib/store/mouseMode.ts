/**
 * Which mouse mapping the table uses (tableplace-202).
 *
 * - default: left-drag on the felt draws a selection box, right-drag orbits,
 *   middle-drag pans (the Tabletop Simulator convention);
 * - classic: left-drag orbits and right-drag pans, as before box select. No
 *   box on the felt; Shift/Ctrl+click still selects.
 *
 * Classic is kept behind this setting for one release so nobody loses the
 * mapping they learned overnight; it is due to be removed after that.
 * Local to this browser, never synced.
 */

import { writable } from 'svelte/store';

const MOUSE_MODE_KEY = 'mouse:v1';

function readClassic(): boolean {
	try {
		return globalThis.localStorage?.getItem(MOUSE_MODE_KEY) === 'classic';
	} catch {
		return false;
	}
}

/** the Settings toggle: off unless this browser switched it on */
export const classicMouse = writable(readClassic());

classicMouse.subscribe((classic) => {
	try {
		if (classic) globalThis.localStorage?.setItem(MOUSE_MODE_KEY, 'classic');
		else globalThis.localStorage?.removeItem(MOUSE_MODE_KEY);
	} catch {
		// private window or blocked storage: the setting lasts this session only
	}
});
