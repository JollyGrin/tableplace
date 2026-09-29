/**
 * Where a group drag lands (tableplace-202).
 *
 * Every member resolves its own landing through the same `resolveDrop` a
 * single drag uses — its own snap point, its own stack, its own surface — so
 * a group drop is just N ordinary drops. Two things make them agree with
 * each other:
 *
 * - they land on the TABLE only. A deck, a bag and the hand each take one
 *   thing, so the aimed-at targets are ignored for a group; the members
 *   settle (or snap) where they are carried instead.
 * - they land one after another against a working copy of the table that the
 *   carried entities are taken out of and put back into as each lands. A
 *   member never stacks onto another member still floating at drag height,
 *   and a pile that was selected whole lands as a pile again: members land in
 *   the order they were stacked (lowest first), each resting on the ones
 *   under it.
 *
 * The lead always resolves first, against the table without the group, so
 * the drop indicator — which previews only the lead — shows exactly where the
 * lead will land.
 */

import type { GameDTO } from '$lib/store/game/types';
import { resolveDrop, type DropOptions, type DropTarget } from './drop';

type Collection = 'cards' | 'decks' | 'pieces';
type Vec3 = [number, number, number];

function collectionOf(id: string): Collection {
	if (id.startsWith('deck:')) return 'decks';
	if (id.startsWith('piece:')) return 'pieces';
	return 'cards';
}

function entityOf(state: Partial<GameDTO> | null | undefined, id: string) {
	return state?.[collectionOf(id)]?.[id] as { position?: Vec3; rotation?: Vec3 } | null | undefined;
}

/** `state` with each collection shallow-copied and `ids` taken out */
export function withoutEntities(
	state: Partial<GameDTO> | null | undefined,
	ids: readonly string[]
): Partial<GameDTO> {
	const next: Partial<GameDTO> = { ...(state ?? {}) };
	for (const collection of ['cards', 'decks', 'pieces'] as const) {
		const records = { ...(state?.[collection] ?? {}) } as Record<string, unknown>;
		for (const id of ids) delete records[id];
		(next as Record<string, unknown>)[collection] = records;
	}
	return next;
}

function withEntity(state: Partial<GameDTO>, id: string, entity: unknown): Partial<GameDTO> {
	const collection = collectionOf(id);
	return { ...state, [collection]: { ...(state[collection] ?? {}), [id]: entity } };
}

export type GroupDropOptions = Omit<DropOptions, 'surfaceYAt'> & {
	/** the per-entity surface callback (`modelSurfaceYAt(id)`) */
	surfaceYAt?: (id: string) => DropOptions['surfaceYAt'];
};

/**
 * The lead lands at `leadPoint`; each follower at its own carried position
 * (the store already holds it — the carry patch put it there). Followers land
 * lowest `origin` first. Returns [id, landing] in landing order; an entity
 * that no longer exists is left out.
 */
export function resolveGroupDrop(
	state: Partial<GameDTO> | null | undefined,
	leadId: string,
	leadPoint: { x: number; z: number } | null | undefined,
	followers: readonly { id: string; origin: Vec3 }[],
	options: GroupDropOptions = {}
): [string, DropTarget][] {
	const order = [
		leadId,
		...[...followers].sort((a, b) => (a.origin[1] ?? 0) - (b.origin[1] ?? 0)).map((m) => m.id)
	];
	let working = withoutEntities(state, order);
	const landed: [string, DropTarget][] = [];
	for (const id of order) {
		const entity = entityOf(state, id);
		if (!entity) continue;
		const drop = resolveDrop(
			withEntity(working, id, entity),
			id,
			id === leadId ? leadPoint : null,
			{},
			{ ...options, surfaceYAt: options.surfaceYAt?.(id) }
		);
		if (!drop) continue;
		landed.push([id, drop]);
		working = withEntity(working, id, {
			...entity,
			position: drop.position,
			rotation: drop.rotation
		});
	}
	return landed;
}
