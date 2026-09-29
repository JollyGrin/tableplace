import type { GameDTO } from './game/types';

/**
 * Held-by (tableplace-199): a card, deck or piece in someone's hand says so.
 *
 * A client-enforced hold, shaped so the server lease in SPEC.md §4c can
 * replace it. The holder writes `heldBy: <their id>` in the very carry patch
 * that moves the entity (see `carryPatch`), and `heldBy: null` in the patch
 * that lands it (see drop/commit.ts) — so a hold costs no message of its own.
 * Every other client reads the field: it draws the holder's colour around the
 * entity and refuses to start a drag on it.
 *
 * A hold is only as alive as its holder. Once `players[holder].connected` goes
 * false (or the holder has no row at all), the hold reads as released — the
 * next grab simply overwrites it. The field is live-table state only: it never
 * goes into a saved scenario, and a file that carries one has it stripped.
 *
 * Pure and relatively imported: the scenario file codec and the composer
 * (which a bun script runs without a browser) strip holds through it too.
 */

type HoldCollection = 'cards' | 'decks' | 'pieces';

/** every collection an entity can be carried out of */
export const HOLD_COLLECTIONS: readonly HoldCollection[] = ['cards', 'decks', 'pieces'];

/** the collection a carried id lives in (ids encode their kind) */
function holdCollectionOf(id: string): HoldCollection {
	if (id.startsWith('deck:')) return 'decks';
	if (id.startsWith('piece:')) return 'pieces';
	return 'cards';
}

/**
 * This client's player id, read straight from localStorage (the same key
 * `actions/player.ts` keeps) so the drag store can stamp holds without
 * importing the action layer, which imports it.
 */
export function myHoldId(): string | null {
	try {
		return localStorage.getItem('myPlayerId');
	} catch {
		return null;
	}
}

/** is a hold by `holder` still binding — are they at the table and connected? */
export function isHoldLive(state: Partial<GameDTO> | null | undefined, holder: string): boolean {
	const player = state?.players?.[holder];
	return !!player && player.connected !== false;
}

/**
 * Who holds `id` so that this client may not take it — null when nobody does,
 * when this client is the holder, or when the holder has gone.
 */
export function heldByOther(
	state: Partial<GameDTO> | null | undefined,
	id: string,
	myId: string | null | undefined = myHoldId()
): string | null {
	const entity = state?.[holdCollectionOf(id)]?.[id] as { heldBy?: string } | null | undefined;
	const holder = entity?.heldBy;
	if (!holder || holder === myId) return null;
	return isHoldLive(state, holder) ? holder : null;
}

/**
 * The patch that lets go of everything `myId` is recorded as holding, or null
 * when there is nothing. For a client that finds its own holds in the state
 * it joins into — left behind by a reload mid-drag — with nothing in hand.
 */
export function releaseHoldsPatch(
	state: Partial<GameDTO> | null | undefined,
	myId: string | null | undefined
): Partial<GameDTO> | null {
	if (!myId) return null;
	const patch: Record<string, Record<string, { heldBy: null }>> = {};
	for (const collection of HOLD_COLLECTIONS)
		for (const [id, entity] of Object.entries(state?.[collection] ?? {}))
			if ((entity as { heldBy?: string } | null)?.heldBy === myId)
				(patch[collection] ??= {})[id] = { heldBy: null };
	return Object.keys(patch).length ? (patch as Partial<GameDTO>) : null;
}

function strip<T>(entities: Record<string, T> | undefined): Record<string, T> | undefined {
	if (!entities) return entities;
	let out: Record<string, T> | undefined;
	for (const [id, entity] of Object.entries(entities)) {
		if (!entity || typeof entity !== 'object' || !('heldBy' in entity)) continue;
		out ??= { ...entities };
		const copy = { ...entity } as T & { heldBy?: unknown };
		delete copy.heldBy;
		out[id] = copy;
	}
	return out ?? entities;
}

/**
 * `state` with every hold taken out — cards, decks, pieces, and cards in a
 * hand. A hold describes a pointer on a live table, so nothing written to a
 * file (or read from one) may carry it. Returns the input untouched when
 * there is nothing to strip.
 */
export function withoutHolds<S extends Partial<GameDTO>>(state: S): S {
	let out: S = state;
	for (const collection of HOLD_COLLECTIONS) {
		const entities = state[collection] as Record<string, unknown> | undefined;
		const stripped = strip(entities);
		if (stripped !== entities) out = { ...out, [collection]: stripped };
	}
	if (state.players) {
		let players: GameDTO['players'] | undefined;
		for (const [id, player] of Object.entries(state.players)) {
			const tray = strip(player?.tray as Record<string, unknown> | undefined);
			if (tray === player?.tray) continue;
			players ??= { ...state.players };
			players[id] = { ...player, tray: tray as GameDTO['players'][string]['tray'] };
		}
		if (players) out = { ...out, players };
	}
	return out;
}
