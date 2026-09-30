import { get, writable } from 'svelte/store';
import type { GameDTO } from './types';
import { merge } from '../transform-helpers';
import { noteLocalMoves } from '../lastMoved';

const initGameState = {
	players: {},
	decks: {},
	cards: {}
};
const game = writable<Partial<GameDTO>>(initGameState);

function findNullPaths(obj: Record<string, any>, currentPath: string[] = []): string[][] {
	const nullPaths: string[][] = [];

	for (const [key, value] of Object.entries(obj)) {
		const newPath = [...currentPath, key];

		if (value === null) {
			nullPaths.push(newPath); // 👈 wrap it
		} else if (typeof value === 'object' && value !== null) {
			nullPaths.push(...findNullPaths(value, newPath));
		}
	}

	return nullPaths;
}

function removePathFromObject(obj: any, path: string[]): any {
	if (path.length === 0) return obj;

	const [firstKey, ...restPath] = path;

	if (!(firstKey in obj)) return obj;

	// At the final key: remove it
	if (restPath.length === 0) {
		const { [firstKey]: _, ...rest } = obj;
		return rest;
	}

	// Recurse deeper
	return {
		...obj,
		[firstKey]: removePathFromObject(obj[firstKey], restPath)
	};
}

function deepFilterNulls<T>(obj: T): T {
	if (obj === null || typeof obj !== 'object') return obj;

	if (Array.isArray(obj)) {
		return obj.map(deepFilterNulls) as unknown as T;
	}

	const result: any = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === null) continue;
		result[key] = deepFilterNulls(value);
	}
	return result;
}

/**
 * recursive utility type called PartialWithNull<T> that allows any property in the tree to be either:
 * the original type, a partial object of that type (for nested objects), or null.
 * */
type PartialWithNull<T> = {
	[P in keyof T]?: T[P] extends object ? PartialWithNull<T[P]> | null : T[P] | null;
};

function updateState(update: PartialWithNull<GameDTO>) {
	const paths = findNullPaths(update);

	game.update((state) => {
		let newState = { ...state };

		// 1. Remove nulls
		for (const path of paths) {
			newState = removePathFromObject(newState, path);
		}

		// 2. Remove nulls from update object itself (so merge doesn’t re-add them)
		const cleanedUpdate = deepFilterNulls(update);

		// 3. Merge in the remaining values
		return merge(newState, cleanedUpdate);
	});
}

type LocalPatchObserver = (update: unknown, before: Partial<GameDTO>) => void;
let localPatchObserver: LocalPatchObserver | null = null;

/**
 * Watch every patch this client makes, with the state as it was just before
 * it lands — the action journal (tableplace-201) reads its undo snapshots
 * here. One observer; installing another replaces it, `null` removes it.
 */
export function observeLocalPatches(observer: LocalPatchObserver | null) {
	localPatchObserver = observer;
}

type PatchObserver = (
	update: unknown,
	before: Partial<GameDTO>,
	origin: 'local' | 'remote'
) => void;
let patchObserver: PatchObserver | null = null;

/**
 * Watch every patch, mine and a peer's, with which it was (table sounds,
 * tableplace-204). Separate from `observeLocalPatches` so neither replaces the
 * other. One observer; `null` removes it.
 */
export function observePatches(observer: PatchObserver | null) {
	patchObserver = observer;
}

/** a patch this client made (as opposed to one relayed from a peer) */
function updateLocalState(update: PartialWithNull<GameDTO>) {
	noteLocalMoves(update);
	localPatchObserver?.(update, get(game));
	patchObserver?.(update, get(game), 'local');
	updateState(update);
}

/** a patch relayed from a peer (or the join sync): applied without rebroadcasting */
function updateRemoteState(update: PartialWithNull<GameDTO>) {
	patchObserver?.(update, get(game), 'remote');
	updateState(update);
}

export const gameStore = {
	...game,
	// NOTE: wrapped in storeIntegration.ts to broadcast messages
	updateState: updateLocalState,
	// NOTE: silent used in websocket/index.ts to sync received messages without rebroadcasting
	updateStateSilently: updateRemoteState
};
