import { writable } from 'svelte/store';
import type { GameDTO } from './types';
import { merge } from '../transform-helpers';
import { mintIntent, receiveIntents, splitIntents } from './intents';
import { allowIntent } from '$lib/gate';

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

function applyPatch(update: PartialWithNull<GameDTO>) {
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

/**
 * A local mutation. Naming what just happened (tableplace-169) happens HERE
 * rather than in the action wrapper, so a verb that only reads — `getMe`,
 * `getDeckLength` — stays silent without anything having to list them: no
 * patch, no intent. `mintIntent` is idempotent per action call, so the
 * websocket wrapper minting first (to put the event on the wire) leaves this
 * one a no-op rather than a second event.
 *
 * `allowIntent` (tableplace-171) is the referee's veto, and it comes FIRST:
 * a refused action leaves no patch and no minted intent behind, so nothing
 * downstream — the store, an observer, a game log — ever hears about it. With
 * no validator registered it is a single null check and this function behaves
 * exactly as it did before the gate existed. The websocket wrapper asks the
 * same question before it sends; the verdict is memoised per action call, so
 * asking twice cannot refuse a player twice.
 */
function updateState(update: PartialWithNull<GameDTO>) {
	if (!allowIntent()) return;
	mintIntent();
	applyPatch(update);
}

/**
 * An inbound mutation, applied without rebroadcasting it. Anything the sender
 * piggybacked on the patch is peeled off and published to the intent observers
 * before the merge — the intents are not game state and must never reach the
 * store — which is what makes an observer on this client see the whole table
 * instead of only its own half.
 */
function updateStateSilently(update: PartialWithNull<GameDTO>) {
	const { state, intents } = splitIntents(update);
	receiveIntents(intents);
	applyPatch(state);
}

export const gameStore = {
	...game,
	// NOTE: wrapped in storeIntegration.ts to broadcast messages
	updateState,
	// NOTE: silent used in websocket/index.ts to sync received messages without rebroadcasting
	updateStateSilently
};
