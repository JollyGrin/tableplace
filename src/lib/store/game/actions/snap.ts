import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import { SNAP_RADIUS_DEFAULT } from '$lib/utils/constants-snap';
import { clampToTable } from '$lib/utils/transforms/drop';
import { compareSnapIds } from '$lib/utils/transforms/snap';
import type { GameDTO, SnapPointDTO } from '../types';

// the resolver breaks distance ties on the same ordering the pane lists
// points in, so the comparator lives with the pure transforms — re-exported
// here because this module is where the editor has always imported it from
export { compareSnapIds };

/**
 * Authoring snap points — the /setup layer's whole vocabulary: add, move,
 * retune, link, tag, remove.
 *
 * Everything goes through `updateState`, so the editor's edits are ordinary
 * surgical patches (and `null` deletes) exactly like a piece's. Snap points are
 * table-scoped, so ids carry no owner: they are plain sequential `snap:<n>`.
 */

type SnapPointState = NonNullable<NonNullable<GameDTO['snapPoints']>[string]>;

export function snapPointIds(state?: Partial<GameDTO> | null): string[] {
	const points = (state ?? get(gameStore))?.snapPoints ?? {};
	return Object.keys(points)
		.filter((id) => points[id])
		.sort(compareSnapIds);
}

/**
 * Next free `snap:<n>`, one past the highest currently on the table. Deleting
 * the newest point frees its id again, which is fine: /setup is a local editor
 * and the delete has already been applied before the next add is built.
 */
function nextSnapId(): string {
	const used = Object.keys(get(gameStore)?.snapPoints ?? {})
		.map((id) => Number(id.split(':')[1]))
		.filter((n) => Number.isFinite(n));
	return `snap:${used.length ? Math.max(...used) + 1 : 0}`;
}

export type AddSnapPointOptions = {
	/** table-space [x, z]; clamped inside the felt like any other placement */
	position?: [number, number];
	/** elevation — the local floor a landing rests on (omitted: the felt) */
	y?: number;
	/** yaw in degrees a caught drop turns to (a grid's lattice yaw) */
	rotation?: number;
	radius?: number;
	/** `'grid'` plus pitch/cols/rows makes the point a lattice of cells */
	kind?: SnapPointDTO['kind'];
	pitch?: number;
	cols?: number;
	rows?: number;
	yawStep?: number;
	/** ids of connected points (see `toggleSnapLink` to keep both ends in step) */
	links?: string[];
	/** ids of the points this one leads to, one way only */
	outLinks?: string[];
	/** free-form labels */
	tags?: string[];
};

/** Place a snap point. Returns its id. */
function addSnapPoint(opts: AddSnapPointOptions = {}): string {
	const id = nextSnapId();
	const [x, z] = clampToTable(opts.position?.[0] ?? 0, opts.position?.[1] ?? 0);
	const point: Partial<SnapPointState> = {
		id,
		position: [x, z],
		radius: opts.radius ?? SNAP_RADIUS_DEFAULT
	};
	for (const field of [
		'y',
		'rotation',
		'kind',
		'pitch',
		'cols',
		'rows',
		'yawStep',
		'links',
		'outLinks',
		'tags'
	] as const) {
		if (opts[field] !== undefined) (point as Record<string, unknown>)[field] = opts[field];
	}
	gameStore.updateState({ snapPoints: { [id]: point } });
	return id;
}

function moveSnapPoint(id: string, position: [number, number]) {
	const [x, z] = clampToTable(position[0], position[1]);
	gameStore.updateState({ snapPoints: { [id]: { position: [x, z] } } });
}

/**
 * Retune a point in place. An optional field set to `undefined` is how the
 * editor says "back to none" — `null` at that path is what deletes the field,
 * since an undefined value would be dropped from the patch and change nothing.
 * (`rotation: undefined` = no authored yaw; `kind: undefined` = plain point.)
 */
function updateSnapPoint(id: string, patch: Partial<Omit<SnapPointDTO, 'id'>>) {
	const next: Record<string, unknown> = { ...patch };
	for (const field of [
		'y',
		'rotation',
		'kind',
		'pitch',
		'cols',
		'rows',
		'yawStep',
		'links',
		'outLinks',
		'tags'
	] as const) {
		if (field in patch && patch[field] === undefined) next[field] = null;
	}
	gameStore.updateState({
		snapPoints: { [id]: next as Partial<SnapPointState> }
	} as Parameters<typeof gameStore.updateState>[0]);
}

/**
 * Remove a point, and every other point's link to it in the same patch — a
 * dangling link is harmless to the table, but an export renumbers ids and a
 * stale one must not survive to be misread.
 */
function removeSnapPoint(id: string) {
	const points = get(gameStore)?.snapPoints ?? {};
	const update: Record<string, Partial<SnapPointState> | null> = { [id]: null };
	for (const other in points) {
		if (other === id) continue;
		const patch: Record<string, string[] | null> = {};
		for (const field of LINK_FIELDS) {
			const links = points[other]?.[field];
			if (!links?.includes(id)) continue;
			const rest = links.filter((link) => link !== id);
			// an emptied list is deleted, not shipped
			patch[field] = rest.length ? rest : null;
		}
		if (Object.keys(patch).length) update[other] = patch as Partial<SnapPointState>;
	}
	gameStore.updateState({ snapPoints: update });
}

/** the two lists an edge can be written in: two-way `links`, one-way `outLinks` */
const LINK_FIELDS = ['links', 'outLinks'] as const;

/** are `a` and `b` linked — from either end, since links are undirected */
function snapPointsLinked(a: string, b: string, state?: Partial<GameDTO> | null): boolean {
	const points = (state ?? get(gameStore))?.snapPoints;
	return !!points?.[a]?.links?.includes(b) || !!points?.[b]?.links?.includes(a);
}

/**
 * Draw a link between two points, or remove the one that is there.
 *
 * Two-way (the default): written on both ends, so a file reads the same from
 * either point; toggling a pair that is joined in any way — a one-way edge
 * included — clears it.
 *
 * `oneWay`: the edge leaves `a` for `b` and is written on `a` alone
 * (`outLinks`). It replaces whatever joined the pair, so drawing it against
 * an existing edge turns that edge round; toggling the same edge again
 * removes it.
 *
 * Returns whether the pair is joined afterwards.
 */
function toggleSnapLink(a: string, b: string, oneWay = false): boolean {
	const points = get(gameStore)?.snapPoints;
	if (a === b || !points?.[a] || !points?.[b]) return false;
	const forward = !!points[a]?.outLinks?.includes(b);
	const back = !!points[b]?.outLinks?.includes(a);
	const twoWay = snapPointsLinked(a, b);
	const remove = oneWay ? forward && !back && !twoWay : twoWay || forward || back;
	const next = (self: string, other: string, add: (typeof LINK_FIELDS)[number] | null) => {
		const patch: Record<string, string[] | null> = {};
		for (const field of LINK_FIELDS) {
			const current = points[self]?.[field];
			const list = (current ?? []).filter((link) => link !== other);
			if (field === add) list.push(other);
			// an empty list is deleted rather than shipped
			if (current || list.length) patch[field] = list.length ? list : null;
		}
		return patch;
	};
	gameStore.updateState({
		snapPoints: {
			[a]: next(a, b, remove ? null : oneWay ? 'outLinks' : 'links'),
			[b]: next(b, a, remove || oneWay ? null : 'links')
		}
	} as Parameters<typeof gameStore.updateState>[0]);
	return !remove;
}

/** Drop every link on the table, one-way ones too — the editor's "clear links". */
function clearSnapLinks() {
	const points = get(gameStore)?.snapPoints ?? {};
	// `null` deletes the field — see updateSnapPoint for why the cast
	const update: Record<string, Partial<SnapPointState>> = {};
	for (const id in points) {
		for (const field of LINK_FIELDS) {
			if (points[id]?.[field]) {
				update[id] = { ...update[id], [field]: null } as unknown as Partial<SnapPointState>;
			}
		}
	}
	if (!Object.keys(update).length) return;
	gameStore.updateState({ snapPoints: update });
}

/** Replace a point's tags; an empty list deletes the field. */
function setSnapTags(id: string, tags: string[]) {
	const clean = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
	gameStore.updateState({
		snapPoints: { [id]: { tags: clean.length ? clean : null } }
	} as Parameters<typeof gameStore.updateState>[0]);
}

/** Drop every snap point on the table (the editor's clear, and scenario load). */
function clearSnapPoints() {
	const ids = Object.keys(get(gameStore)?.snapPoints ?? {});
	if (!ids.length) return;
	const update: Record<string, null> = {};
	for (const id of ids) update[id] = null;
	gameStore.updateState({ snapPoints: update });
}

export const snapActions = {
	addSnapPoint,
	moveSnapPoint,
	updateSnapPoint,
	removeSnapPoint,
	clearSnapPoints,
	toggleSnapLink,
	snapPointsLinked,
	clearSnapLinks,
	setSnapTags,
	snapPointIds
};
