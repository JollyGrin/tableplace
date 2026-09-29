/**
 * The table's one journal, wired to the live stores (see `journal.ts`).
 *
 * Inert until `installJournal` — /play installs it once the lobby socket is
 * up; /setup never does, so authoring a scenario logs nothing.
 */

import { get } from 'svelte/store';
import toast from 'svelte-french-toast';
import { gameStore, observeLocalPatches } from '$lib/store/game/gameStore.svelte';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import type { VerbTarget } from '$lib/verbs/types';
import { createJournal } from './journal';
import type { EntityKey } from './diff';
import type { JournalEntry } from './entry';

let send: ((entry: JournalEntry) => void) | null = null;
let installed = false;

export const journal = createJournal({
	getState: () => get(gameStore),
	apply: (patch) => gameStore.updateState(patch),
	send: (entry) => send?.(entry),
	myId: () => gameActions.getMyId(),
	isDragging: () => !!get(dragStore).isDragging,
	notify: (message) => toast(message, { duration: 4000 })
});

/** start journaling this client's writes; `publish` puts an entry on the wire */
export function installJournal(publish: (entry: JournalEntry) => void) {
	send = publish;
	if (installed) return;
	installed = true;
	observeLocalPatches((patch, before) => journal.record(patch, before));
}

const COLLECTION: Partial<Record<VerbTarget['kind'], string>> = {
	card: 'cards',
	deck: 'decks',
	piece: 'pieces'
};

/** the entities a verb target names */
function keysOf(target: VerbTarget): EntityKey[] {
	if (target.kind === 'selection') {
		const state = get(gameStore) as Record<string, Record<string, unknown> | undefined>;
		return target.ids.flatMap((id) => {
			const collection = ['cards', 'decks', 'pieces'].find((c) => state?.[c]?.[id]);
			return collection ? [[collection, id] as const] : [];
		});
	}
	const collection = COLLECTION[target.kind];
	return collection && 'id' in target ? [[collection, target.id]] : [];
}

/** a registry verb is about to run (called from `verbsFor`) */
export function journalVerb(verbId: string, target: VerbTarget) {
	if (installed) journal.verb(verbId, keysOf(target));
}
