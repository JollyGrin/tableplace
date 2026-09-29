import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import type { GameDTO } from '../types';

/**
 * Lock (tableplace-189): pin a card, deck, piece or overlay in place.
 *
 * A locked entity can't be dragged, flipped, turned or grouped — only
 * previewed, and unlocked again. The flag is one synced boolean on the entity
 * (`locked: true`, deleted with `null` when unpinned), so it travels in the
 * same single patch as any other edit and every client agrees on it.
 *
 * The guards live in the actions themselves (`flipCard`, `rotatePiece`, …),
 * not only in the verbs, so no second route — the wheel, a menu, a test —
 * can move a pinned thing by going around the keyboard.
 */

export type LockableKind = 'card' | 'deck' | 'piece' | 'overlay';

const COLLECTION = {
	card: 'cards',
	deck: 'decks',
	piece: 'pieces',
	overlay: 'overlays'
} as const satisfies Record<LockableKind, keyof GameDTO>;

/** is the `kind` entity `id` pinned? false for one that doesn't exist */
export function isLocked(kind: LockableKind, id: string | null | undefined): boolean {
	if (!id) return false;
	const entity = get(gameStore)?.[COLLECTION[kind]]?.[id] as { locked?: boolean } | null;
	return entity?.locked === true;
}

/** pin or unpin; a no-op for an entity that doesn't exist */
function setLocked(kind: LockableKind, id: string, locked: boolean) {
	const collection = COLLECTION[kind];
	if (!get(gameStore)?.[collection]?.[id]) return;
	// null deletes the key: an unpinned entity looks exactly like one never pinned
	gameStore.updateState({ [collection]: { [id]: { locked: locked ? true : null } } } as Parameters<
		typeof gameStore.updateState
	>[0]);
}

/** flip the pin; returns the new state, or undefined when there is nothing there */
function toggleLock(kind: LockableKind, id: string): boolean | undefined {
	const collection = COLLECTION[kind];
	if (!get(gameStore)?.[collection]?.[id]) return undefined;
	const next = !isLocked(kind, id);
	setLocked(kind, id, next);
	return next;
}

export const lockActions = { setLocked, toggleLock };
