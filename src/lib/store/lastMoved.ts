import { writable } from 'svelte/store';
import type { CameraFocus } from './cameraStore.svelte';

/**
 * The last table entity THIS client moved — what Z focuses when nothing is
 * under the pointer. Fed from local writes only (`gameStore.updateState`, never
 * the silent path a peer's patch takes), so a peer's move never steals it.
 */
export const lastMoved = writable<CameraFocus | null>(null);

const COLLECTIONS = [
	['cards', 'card'],
	['decks', 'deck'],
	['pieces', 'piece']
] as const;

/** record the last entity a local patch gave a position to */
export function noteLocalMoves(update: unknown) {
	if (!update || typeof update !== 'object') return;
	let moved: CameraFocus | null = null;
	for (const [collection, kind] of COLLECTIONS) {
		const entities = (update as Record<string, unknown>)[collection];
		if (!entities || typeof entities !== 'object') continue;
		for (const [id, patch] of Object.entries(entities)) {
			if (patch && typeof patch === 'object' && 'position' in patch) moved = { kind, id };
		}
	}
	if (moved) lastMoved.set(moved);
}
