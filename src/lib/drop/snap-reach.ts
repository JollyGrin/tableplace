import type { GameDTO, PieceDTO } from '$lib/store/game/types';
import { resolveSnap, snapRadius } from '$lib/utils/transforms/snap';

/**
 * Snap point links and reach (tableplace-190), as pure graph arithmetic.
 *
 * Snap points may carry `links` — ids of the points they connect to — and a
 * piece may carry `reach`, how many links it usually travels. Lift that piece
 * off a linked point and `SnapGuides` draws the points within `reach` links
 * brighter than the rest. Advisory only: nothing here feeds `resolveDrop`, so
 * every point still catches exactly as it did, and a scenario without links
 * gets no bright set at all.
 */

type SnapPoints = GameDTO['snapPoints'];

/**
 * The link graph as adjacency, undirected: a link authored on either end
 * joins both, so a hand-written file needn't repeat itself. Links to points
 * that don't exist (or were removed), self links and non-string entries are
 * ignored rather than trusted.
 */
export function snapLinkGraph(snapPoints: SnapPoints | undefined | null): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>();
	const join = (a: string, b: string) => {
		let set = graph.get(a);
		if (!set) graph.set(a, (set = new Set()));
		set.add(b);
	};
	for (const id in snapPoints ?? {}) {
		const links = snapPoints?.[id]?.links;
		if (!Array.isArray(links)) continue;
		for (const target of links) {
			if (typeof target !== 'string' || target === id || !snapPoints?.[target]) continue;
			join(id, target);
			join(target, id);
		}
	}
	return graph;
}

/**
 * Breadth-first: every point within `reach` links of `from`, mapped to its
 * link distance (`from` itself is 0). Cycles are walked once — a point keeps
 * the distance it was first reached at, which BFS guarantees is the shortest.
 * A negative or non-finite reach yields an empty map. Every point is
 * passable: occupancy only removes a point from the landing set afterwards.
 */
export function snapPointsWithinReach(
	graph: ReadonlyMap<string, ReadonlySet<string>>,
	from: string,
	reach: number
): Map<string, number> {
	const seen = new Map<string, number>();
	if (!Number.isFinite(reach) || reach < 0) return seen;
	seen.set(from, 0);
	const queue = [from];
	for (let head = 0; head < queue.length; head++) {
		const id = queue[head]!;
		const depth = seen.get(id)!;
		if (depth >= reach) continue;
		for (const next of graph.get(id) ?? []) {
			if (seen.has(next)) continue;
			seen.set(next, depth + 1);
			queue.push(next);
		}
	}
	return seen;
}

/** A piece's authored reach, when it is a usable non-negative whole number. */
export function pieceReach(piece: Partial<PieceDTO> | null | undefined): number | null {
	const reach = piece?.reach;
	return typeof reach === 'number' && Number.isInteger(reach) && reach >= 0 ? reach : null;
}

/**
 * Discrete snap points with something resting on them: any card, deck or
 * piece whose table position lies inside the point's catch radius. `except`
 * is the lifted entity — it has left its point. Grids never count as
 * occupied; one entry covers many cells.
 */
export function occupiedSnapPoints(
	state: Partial<GameDTO> | undefined | null,
	except: string | null
): Set<string> {
	const occupied = new Set<string>();
	const snapPoints = state?.snapPoints;
	const spots: [string, number, number, number][] = [];
	for (const id in snapPoints ?? {}) {
		const point = snapPoints?.[id];
		const p = point?.position;
		if (!point || point.kind === 'grid' || !Array.isArray(p)) continue;
		spots.push([id, p[0], p[1], snapRadius(point)]);
	}
	if (!spots.length) return occupied;
	for (const collection of [state?.cards, state?.decks, state?.pieces]) {
		for (const id in collection ?? {}) {
			if (id === except) continue;
			const p = collection?.[id]?.position;
			if (!Array.isArray(p)) continue;
			for (const [spot, x, z, r] of spots) {
				if (Math.hypot(p[0] - x, p[2] - z) <= r) occupied.add(spot);
			}
		}
	}
	return occupied;
}

/**
 * The bright set for a lift: the points a piece with `reach` can get to from
 * the linked snap point it was lifted off. Null — no bright set, every ring
 * drawn as usual — unless all of that holds: the entity is a piece with a
 * reach, it left from a table position (`origin`) caught by a discrete point,
 * and that point has links.
 *
 * The origin point is in the set (staying put is always a move). Occupied
 * points are left out of it but stay passable, so a piece can still reach
 * past one.
 */
export function liftReachSet(
	state: Partial<GameDTO> | undefined | null,
	dragId: string | null,
	origin: readonly number[] | null | undefined
): Set<string> | null {
	if (!dragId || !origin || !dragId.startsWith('piece:')) return null;
	const reach = pieceReach(state?.pieces?.[dragId]);
	if (reach === null) return null;
	const snapPoints = state?.snapPoints;
	const from = resolveSnap(snapPoints, origin[0]!, origin[2]!);
	if (!from || from.grid) return null;
	const graph = snapLinkGraph(snapPoints);
	if (!graph.has(from.id)) return null;
	const occupied = occupiedSnapPoints(state, dragId);
	const bright = new Set<string>();
	for (const id of snapPointsWithinReach(graph, from.id, reach).keys()) {
		if (!occupied.has(id)) bright.add(id);
	}
	return bright;
}
