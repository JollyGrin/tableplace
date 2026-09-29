/**
 * Whether this client draws other players' pointers (tableplace-197). On by
 * default. Hiding them is purely local: our own pointer still streams, since
 * peers make their own choice. Local to this browser, never synced.
 */

import { writable } from 'svelte/store';

const REMOTE_POINTERS_KEY = 'remotePointers:v1';

function readEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem(REMOTE_POINTERS_KEY) !== 'off';
	} catch {
		return true;
	}
}

/** the Settings toggle: on unless this browser switched it off */
export const remotePointersEnabled = writable(readEnabled());

remotePointersEnabled.subscribe((on) => {
	try {
		if (on) globalThis.localStorage?.removeItem(REMOTE_POINTERS_KEY);
		else globalThis.localStorage?.setItem(REMOTE_POINTERS_KEY, 'off');
	} catch {
		// private window or blocked storage: the setting lasts this session only
	}
});
