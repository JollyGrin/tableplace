/**
 * The first-run checklist, wired to the live stores (see `checklist.ts`).
 *
 * Everything here is this browser's alone: what has been ticked and whether
 * the strip was dismissed live in localStorage, and every tick is read off
 * something this client already has — its own journal lines, the preview on
 * screen, the wheel, its own pings. Nothing is ever sent.
 */

import { get, writable, type Readable } from 'svelte/store';
import { journal } from '$lib/journal';
import { gameActions } from '$lib/store/game/actions';
import { preview } from '$lib/HUDPreview/previewStore';
import { radialMenu } from '$lib/store/radialUi';
import { activePings } from '$lib/ping';
import {
	COACH_KEY,
	itemForJournalVerb,
	parseCoachMemory,
	tick,
	type CoachMemory
} from './checklist';

function read(): CoachMemory {
	try {
		return parseCoachMemory(globalThis.localStorage?.getItem(COACH_KEY));
	} catch {
		return parseCoachMemory(null);
	}
}

const memory = writable<CoachMemory>(read());

memory.subscribe((value) => {
	try {
		globalThis.localStorage?.setItem(COACH_KEY, JSON.stringify(value));
	} catch {
		// private window or blocked storage: the checklist lasts this session only
	}
});

export const coach: Readable<CoachMemory> = { subscribe: memory.subscribe };

export function tickItem(id: string) {
	memory.update((m) => tick(m, id));
}

/** hide the strip (`true`), or bring it back from the `?` reference (`false`) */
export function dismissCoach(dismissed = true) {
	memory.update((m) => (m.dismissed === dismissed ? m : { ...m, dismissed }));
}

/**
 * Start ticking from what this client sees. /play calls it once mounted;
 * the returned function stops it.
 */
export function installCoach(): () => void {
	const stops = [
		// this player's own journal lines: a peer's flip is not yours
		journal.log.subscribe((lines) => {
			const me = gameActions.getMyId();
			if (!me) return;
			for (const line of lines) {
				if (line.actor !== me) continue;
				const id = itemForJournalVerb(line.verb);
				if (id && !get(memory).done.includes(id)) tickItem(id);
			}
		}),
		preview.subscribe((shown) => {
			if (shown) tickItem('preview');
		}),
		radialMenu.subscribe((open) => {
			if (open) tickItem('menu');
		}),
		activePings.subscribe((pings) => {
			const me = gameActions.getMyId();
			if (me && pings.some((ping) => ping.playerId === me)) tickItem('ping');
		})
	];
	return () => stops.forEach((stop) => stop());
}
