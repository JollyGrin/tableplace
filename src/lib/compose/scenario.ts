/**
 * Headless scenario composition: a tbps scenario plus its already-resolved
 * packs in, the `GameDTO` fragment a client would have produced out.
 *
 * This is the entity-building half of `scenario.applyScenario`, lifted out of
 * the browser. Nothing here touches a store, Svelte, `localStorage` or the
 * DOM, so the same code that lays out a table in /play can lay one out from a
 * bun script (`scripts/seed-lobby.ts`) or from a future provisioning API —
 * same entity ids, same `seat0`…`seat3` placeholder owners, same `packOrigin`
 * stamps, same card order.
 *
 * Pack **resolution** is deliberately not here: fetching a `.tbpp.json` is I/O,
 * and keeping it out is what makes this testable and reusable. The caller
 * resolves (`scenario/resolve-packs.ts` in the browser) and passes the map.
 */

import { BUILTIN_PACKS, PACK_SOURCE_BUILTIN } from '../packs/builtin';
import { composePackDeck, composePackOverlay, composePackPiece, type ShuffleFn } from './pack';
import type { GamePackDef } from '../packs/types';
import type { GameDTO } from '../store/game/types';
import type { PackPlacement, PackRef, Scenario, SeatIndex, SnapPoint } from '../scenario/file';

export type { ShuffleFn };

export const seatPlaceholderId = (seat: SeatIndex) => `seat${seat}`;
export const isSeatPlaceholder = (id: string) => /^seat[0-3]$/.test(id);

export type ComposeScenarioOptions = {
	/**
	 * How a `shuffleOnLoad` deck is shuffled. Defaults to Fisher–Yates; the
	 * client passes its own so there is one shuffle on the client, and a seeder
	 * that wants a reproducible table passes a seeded generator.
	 */
	shuffleWith?: ShuffleFn;
	/**
	 * Where a pack re-resolves from, stamped into every entity's `packOrigin`.
	 * Defaults to what the scenario's own ref says, falling back to `'builtin'`
	 * for a shipped pack. The browser overrides this to also recognise packs
	 * held in its local library, which is knowledge no headless caller has.
	 */
	sourceOf?: (ref: PackRef, pack: GamePackDef) => string | undefined;
};

function defaultSourceOf(ref: PackRef, pack: GamePackDef): string | undefined {
	if (ref.source) return ref.source;
	return BUILTIN_PACKS[pack.id] ? PACK_SOURCE_BUILTIN : undefined;
}

/**
 * Placeholder players a scenario needs: the ones it saved, plus one per seat
 * its placements own content for. They hold the seat index and tray until a
 * real player claims them (`scenario.claimSeat`), and `?seat=N` auto-claim
 * waits on exactly this — so a seeded lobby without them is unclaimable.
 */
export function composePlayers(scenario: Scenario): GameDTO['players'] {
	const players: GameDTO['players'] = {};
	for (const [id, player] of Object.entries(scenario.state?.players ?? {})) {
		players[id] = player as GameDTO['players'][string];
	}
	for (const placement of scenario.placements ?? []) {
		if (placement.seat === undefined) continue;
		const id = seatPlaceholderId(placement.seat);
		players[id] ??= { id, seat: placement.seat, joinTimestamp: 0, tray: {}, metadata: {} };
	}
	return players;
}

/**
 * Snap points live in a file as a plain array — table-scoped, nothing
 * references them — and in state keyed by id. This is that reassignment.
 */
export function composeSnapPoints(snapPoints: SnapPoint[] | undefined): GameDTO['snapPoints'] {
	const composed: GameDTO['snapPoints'] = {};
	(snapPoints ?? []).forEach((point, index) => {
		const id = `snap:${index}`;
		composed[id] = { id, ...point };
	});
	return composed;
}

/**
 * Lay an override from the scenario's raw `state` on top of composed content.
 * Mirrors the gameStore's own merge (`store/transform-helpers.ts`): objects
 * merge key by key, arrays and scalars replace — so a partial override patches
 * the spawned entity here exactly as it would have patched it in the store.
 */
function mergeOver(base: unknown, override: unknown): unknown {
	if (Array.isArray(base) || Array.isArray(override)) return override;
	if (typeof base !== 'object' || typeof override !== 'object' || !base || !override) {
		return override;
	}
	const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		merged[key] = merged[key] ? mergeOver(merged[key], value) : value;
	}
	return merged;
}

/** Compose one placement into the fragment being built. */
function place(
	placement: PackPlacement,
	pack: GamePackDef,
	state: Partial<GameDTO>,
	source: string | undefined,
	shuffleWith: ShuffleFn | undefined
) {
	const ownerId = placement.seat !== undefined ? seatPlaceholderId(placement.seat) : undefined;

	if (placement.kind === 'overlay') {
		const composed = composePackOverlay(pack, Number(placement.content), {
			source,
			position: placement.position,
			rotation: placement.rotation,
			scale: placement.scale,
			locked: placement.locked
		});
		if (composed) (state.overlays ??= {})[composed.id] = composed.overlay;
		return;
	}

	// decks and pieces are seat-relative: without an owner there is no id to
	// build, and inventing one would put content on a seat nobody can claim
	if (!ownerId) {
		console.error(`[compose] ${placement.kind} placement in '${pack.id}' has no seat`);
		return;
	}

	if (placement.kind === 'deck') {
		const deck = pack.decks.find((d) => d.slot === placement.content);
		if (!deck) {
			console.error(`[scenario] pack '${pack.id}' has no deck '${placement.content}'`);
			return;
		}
		const composed = composePackDeck(pack, deck, {
			ownerId,
			source,
			position: placement.position,
			rotation: placement.rotation,
			isFaceUp: placement.isFaceUp,
			// authored order is the default; shuffling is an explicit opt-in
			order: placement.order,
			shuffle: placement.shuffleOnLoad === true,
			shuffleOnLoad: placement.shuffleOnLoad,
			shuffleWith,
			locked: placement.locked
		});
		(state.decks ??= {})[composed.id] = composed.deck;
		return;
	}

	const index = Number(placement.content);
	if (!Number.isInteger(index)) {
		console.error(`[scenario] ${placement.kind} placement content must be an index`);
		return;
	}
	const composed = composePackPiece(pack, index, {
		ownerId,
		source,
		// ids allocated against what this composition has already placed — the
		// client asks the same question of a table it cleared first
		taken: new Set(Object.keys(state.pieces ?? {})),
		position: placement.position,
		rotation: placement.rotation,
		value: placement.value,
		state: placement.state,
		locked: placement.locked
	});
	if (composed) (state.pieces ??= {})[composed.id] = composed.piece;
}

/**
 * Turn a scenario into the table it describes.
 *
 * `packs` is keyed by `PackRef.id`; a placement whose pack is missing from it
 * is skipped silently — the caller resolved the packs and already knows which
 * ones failed. Handles v1/v0 scenarios too: with no placements the result is
 * just the file's own `state` snapshot, so a legacy file seeds as happily as a
 * pack-referencing one.
 *
 * The result is a complete table, not a diff: apply it to an empty lobby and
 * that lobby is the scenario.
 */
export function composeScenario(
	scenario: Scenario,
	packs: Map<string, GamePackDef>,
	options: ComposeScenarioOptions = {}
): Partial<GameDTO> {
	const sourceOf = options.sourceOf ?? defaultSourceOf;
	const refs = new Map((scenario.packs ?? []).map((ref) => [ref.id, ref]));

	const state: Partial<GameDTO> = {
		players: composePlayers(scenario),
		cards: {},
		decks: {},
		pieces: {},
		overlays: {},
		snapPoints: composeSnapPoints(scenario.snapPoints)
	};

	for (const placement of scenario.placements ?? []) {
		const pack = packs.get(placement.pack);
		if (!pack) continue; // unresolvable — the caller reports it
		const ref = refs.get(placement.pack) ?? { id: placement.pack };
		place(placement, pack, state, sourceOf(ref, pack), options.shuffleWith);
	}

	// the raw `state` snapshot is the override layer: ad-hoc pieces, hand-placed
	// cards, and tweaks to pack content the placements can't express
	for (const collection of ['cards', 'decks', 'pieces', 'overlays', 'snapPoints'] as const) {
		const target = (state[collection] ??= {}) as Record<string, unknown>;
		for (const [id, entity] of Object.entries(scenario.state?.[collection] ?? {})) {
			target[id] = target[id] ? mergeOver(target[id], entity) : entity;
		}
	}
	return state;
}

/**
 * Placements the composer could actually place: everything whose pack
 * resolved. What `ApplyReport.placed` counts.
 */
export function placedCount(scenario: Scenario, packs: Map<string, GamePackDef>): number {
	return (scenario.placements ?? []).filter((p) => packs.has(p.pack)).length;
}
