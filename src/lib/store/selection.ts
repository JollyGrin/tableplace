/**
 * The box selection (tableplace-202): the set of table entities the next
 * group gesture acts on — a drag of any member moves them all, and the
 * selection verbs (F, Q/E, L, G) act on every member at once.
 *
 * Render-only and local to this client, like `dragStore`'s hover fields:
 * nothing here is ever patched into `GameDTO`. What a selection DOES goes on
 * the wire as ordinary entity patches, batched into one message per gesture.
 *
 * Membership is re-checked against the live table on every read
 * (`selectedIds`), so an entity that is deleted, grouped into a deck or pinned
 * — here or by another player — drops out of the selection by itself, and a
 * locked entity can never be part of one.
 */

import { derived, get, writable } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import type { GameDTO } from '$lib/store/game/types';

/** the raw ids, in the order they were added; read `selectedIds` instead */
const selection = writable<string[]>([]);

/** the collection an entity id lives in, by its prefix */
export function collectionOf(id: string): 'cards' | 'decks' | 'pieces' {
	if (id.startsWith('deck:')) return 'decks';
	if (id.startsWith('piece:')) return 'pieces';
	return 'cards';
}

/** can `id` be selected right now? It has to be on the table, and not pinned */
export function isSelectable(state: Partial<GameDTO> | undefined | null, id: string): boolean {
	const entity = state?.[collectionOf(id)]?.[id] as { locked?: boolean } | null | undefined;
	return !!entity && entity.locked !== true;
}

/** `ids` minus anything gone or pinned */
export function liveSelection(
	state: Partial<GameDTO> | undefined | null,
	ids: readonly string[]
): string[] {
	return ids.filter((id) => isSelectable(state, id));
}

/** what is selected on the live table, in the order it was added */
export const selectedIds = derived([selection, gameStore], ([$selection, $game]) =>
	$selection.length ? liveSelection($game, $selection) : []
);

export function currentSelection(): string[] {
	return get(selectedIds);
}

/** replace the selection (a box without Shift) */
export function setSelection(ids: readonly string[]) {
	const next = liveSelection(get(gameStore), [...new Set(ids)]);
	selection.update((current) => (sameIds(current, next) ? current : next));
}

/** add to the selection (a box with Shift held) */
export function addToSelection(ids: readonly string[]) {
	setSelection([...currentSelection(), ...ids]);
}

/**
 * Shift/Ctrl+click: add `id`, or take it out again. Returns whether it is
 * selected afterwards; a pinned or missing entity is never added.
 */
export function toggleSelected(id: string): boolean {
	const current = currentSelection();
	if (current.includes(id)) {
		selection.set(current.filter((other) => other !== id));
		return false;
	}
	if (!isSelectable(get(gameStore), id)) return false;
	selection.set([...current, id]);
	return true;
}

/** Esc, a plain click on the felt, or a drag of something not in it */
export function clearSelection() {
	selection.update((current) => (current.length ? [] : current));
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Does this press add or remove one entity from the selection? Shift+click,
 * or Ctrl/Cmd+click. `shiftIsTaken` is for the entities whose Shift+click
 * already means something (a deck draws to the felt, a counter counts up):
 * on those only Ctrl/Cmd selects.
 */
export function isSelectClick(
	event: Pick<MouseEvent, 'button' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
	shiftIsTaken = false
): boolean {
	if (event.button !== 0) return false;
	return event.ctrlKey || event.metaKey || (!shiftIsTaken && event.shiftKey);
}
