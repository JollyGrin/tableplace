/**
 * The state arithmetic behind the action journal's undo (tableplace-201).
 *
 * Game state is a record of records (`cards`/`decks`/`pieces`/`players`/… by
 * id) and every write is a merge patch where `null` deletes. So an action is
 * summed up by the entities it touched — as they were before it, and as they
 * are after — and undoing it is one more merge patch: `inversePatch` turns
 * the two snapshots back into the patch that restores the first.
 */

type Json = Record<string, unknown>;

/** `collection` + `id` of one entity, e.g. `['pieces', 'piece:alice:hp']` */
export type EntityKey = readonly [collection: string, id: string];

export const keyString = ([collection, id]: EntityKey) => `${collection}\u0000${id}`;

export const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** every entity a merge patch touches (top-level records only) */
export function touchedEntities(patch: unknown): EntityKey[] {
	if (!isRecord(patch)) return [];
	const keys: EntityKey[] = [];
	for (const [collection, entities] of Object.entries(patch)) {
		if (!isRecord(entities)) continue;
		for (const id of Object.keys(entities)) keys.push([collection, id]);
	}
	return keys;
}

export function entityAt(state: unknown, [collection, id]: EntityKey): unknown {
	const entities = isRecord(state) ? state[collection] : undefined;
	return isRecord(entities) ? entities[id] : undefined;
}

export function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function same(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The patch that takes one entity from `after` back to `before`, or
 * `undefined` when they are the same. Records recurse, so the patch names
 * only what changed; anything else (arrays included — the store's merge
 * replaces them whole) is restored whole. A key `after` has and `before`
 * lacked is `null`: deleted.
 */
export function inverseOf(before: unknown, after: unknown): unknown {
	if (same(before, after)) return undefined;
	if (before === undefined || before === null) return null;
	if (!isRecord(before) || !isRecord(after)) return clone(before);
	const patch: Json = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const inverse = inverseOf(before[key], after[key]);
		if (inverse !== undefined) patch[key] = inverse;
	}
	return Object.keys(patch).length ? patch : undefined;
}

/** one merge patch restoring every entity to its `before` snapshot */
export function inversePatch(
	keys: readonly EntityKey[],
	before: ReadonlyMap<string, unknown>,
	after: ReadonlyMap<string, unknown>
): Json | null {
	const patch: Json = {};
	for (const key of keys) {
		const inverse = inverseOf(before.get(keyString(key)), after.get(keyString(key)));
		if (inverse === undefined) continue;
		const [collection, id] = key;
		((patch[collection] as Json | undefined) ??= {})[id] = inverse;
	}
	return Object.keys(patch).length ? patch : null;
}

/** every leaf path a patch writes, `['pieces', id, 'position']` style */
export function patchPaths(patch: unknown, prefix: string[] = []): string[][] {
	if (!isRecord(patch)) return [prefix];
	const paths = Object.entries(patch).flatMap(([key, value]) =>
		patchPaths(value, [...prefix, key])
	);
	return paths.length ? paths : [prefix];
}

export function valueAt(state: unknown, path: readonly string[]): unknown {
	let node = state;
	for (const key of path) {
		if (!isRecord(node)) return undefined;
		node = node[key];
	}
	return node;
}

/**
 * Is everything `inverse` would rewrite still exactly what the action left?
 * Undo only ever puts back what the action itself changed, and only while
 * nobody has changed it since — otherwise it would silently clobber them.
 */
export function stillAsLeft(inverse: unknown, leftAs: unknown, now: unknown): boolean {
	return patchPaths(inverse).every((path) => same(valueAt(leftAs, path), valueAt(now, path)));
}
