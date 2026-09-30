/**
 * Render-only UI state for the hint bar and the `?` reference: whether the
 * reference is open, and whether this player wants the bar at all. Local to
 * this client, never patched into `GameDTO`.
 */

import { writable } from 'svelte/store';

/** the `?` overlay listing every verb */
export const helpOpen = writable(false);

export function toggleHelp(force?: boolean) {
	helpOpen.update((open) => force ?? !open);
}

const HINT_BAR_KEY = 'hintbar:v1';

function readHintBarEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem(HINT_BAR_KEY) !== 'off';
	} catch {
		return true;
	}
}

/** the Settings toggle: on unless this browser switched it off */
export const hintBarEnabled = writable(readHintBarEnabled());

hintBarEnabled.subscribe((enabled) => {
	try {
		if (enabled) globalThis.localStorage?.removeItem(HINT_BAR_KEY);
		else globalThis.localStorage?.setItem(HINT_BAR_KEY, 'off');
	} catch {
		// private window or blocked storage: the setting lasts this session only
	}
});
