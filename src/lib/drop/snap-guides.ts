import { DEG2RAD } from 'three/src/math/MathUtils.js';
import type { GameDTO, SnapPointDTO } from '$lib/store/game/types';
import { snapRadius } from '$lib/utils/transforms/snap';
import { SNAP_GUIDE_GRID_REVEAL } from '$lib/utils/constants-snap';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';

/**
 * Where the lift-time snap guides draw (tableplace-188), as pure arithmetic —
 * `SnapGuides.svelte` turns each visit into one instance matrix.
 *
 * Nothing here decides *which* point catches the drop: that is `resolveDrop`'s
 * job, and the guides take its answer for the filled target so the highlight
 * can never disagree with the landing. This only answers "what could".
 *
 * Every snap point accepts every entity that snaps at all (`entitySnaps` in
 * transforms/drop), so a discrete point always rings; a grid reveals only the
 * cells near the pointer, because a lattice drawn whole is a second felt.
 */

type SnapPoints = GameDTO['snapPoints'];

export type SnapGuideKind = 'point' | 'cell';

/**
 * One guide. `size` is the catch radius for a point, the pitch for a cell;
 * `yaw` (degrees) is the lattice's yaw for a cell and 0 for a point — a ring
 * has no facing.
 *
 * Called with numbers, not an object: this runs on every pointer move of a
 * drag, and a visit per guide must not allocate.
 */
export type SnapGuideVisit = (
	kind: SnapGuideKind,
	x: number,
	y: number,
	z: number,
	size: number,
	yaw: number
) => void;

function finite(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function centreOf(point: Partial<SnapPointDTO>): [number, number] | null {
	const p = point.position;
	if (!Array.isArray(p) || p.length < 2) return null;
	const [x, z] = p;
	return finite(x) && finite(z) ? [x, z] : null;
}

/** the floor a point's landing rests on — the same `y ?? table top` the resolver uses */
export function snapFloorY(point: Partial<SnapPointDTO> | null | undefined): number {
	return finite(point?.y) ? point.y : TABLE_TOP_Y;
}

/** a grid's lattice, when every field it needs is well formed (mirrors `gridCandidate`) */
function lattice(point: Partial<SnapPointDTO>) {
	const { pitch, cols, rows } = point;
	if (!finite(pitch) || pitch <= 0) return null;
	if (!Number.isInteger(cols) || (cols as number) < 1) return null;
	if (!Number.isInteger(rows) || (rows as number) < 1) return null;
	return { pitch, cols: cols as number, rows: rows as number };
}

/** how far from the pointer a grid still shows cells, for a lattice of `pitch` */
export function gridRevealRadius(pitch: number): number {
	return Math.max(SNAP_GUIDE_GRID_REVEAL, pitch);
}

/**
 * Visit every guide for `snapPoints` with the pointer at (`px`, `pz`).
 *
 * `pointer` null (no table hit yet) still rings every discrete point but
 * reveals no grid cells — there is nowhere to be near.
 *
 * Grid cells are walked over the index window around the pointer only, never
 * the whole `cols × rows`: a 100×100 lattice costs what a 3×3 one does.
 */
export function forEachSnapGuide(
	snapPoints: SnapPoints | undefined | null,
	pointer: { x: number; z: number } | null,
	visit: SnapGuideVisit
): void {
	if (!snapPoints) return;
	for (const id in snapPoints) {
		const point = snapPoints[id];
		if (!point) continue; // null = removed
		const centre = centreOf(point);
		if (!centre) continue;
		const y = snapFloorY(point);

		if (point.kind !== 'grid') {
			visit('point', centre[0], y, centre[1], snapRadius(point), 0);
			continue;
		}

		const grid = lattice(point);
		if (!grid || !pointer) continue;
		const { pitch, cols, rows } = grid;
		const yaw = finite(point.rotation) ? point.rotation : 0;
		const cos = Math.cos(yaw * DEG2RAD);
		const sin = Math.sin(yaw * DEG2RAD);
		// grid-local pointer, the same axes as gridCandidate in transforms/snap
		const dx = pointer.x - centre[0];
		const dz = pointer.z - centre[1];
		const u = dx * cos + dz * sin;
		const v = dx * sin - dz * cos;
		const reach = gridRevealRadius(pitch);
		const iu = u / pitch + (cols - 1) / 2;
		const iv = v / pitch + (rows - 1) / 2;
		const span = reach / pitch;
		const i0 = Math.max(0, Math.ceil(iu - span));
		const i1 = Math.min(cols - 1, Math.floor(iu + span));
		const j0 = Math.max(0, Math.ceil(iv - span));
		const j1 = Math.min(rows - 1, Math.floor(iv + span));
		for (let i = i0; i <= i1; i++) {
			const cu = (i - (cols - 1) / 2) * pitch;
			for (let j = j0; j <= j1; j++) {
				const cv = (j - (rows - 1) / 2) * pitch;
				if (Math.hypot(cu - u, cv - v) > reach) continue;
				visit(
					'cell',
					centre[0] + cu * cos + cv * sin,
					y,
					centre[1] + cu * sin - cv * cos,
					pitch,
					yaw
				);
			}
		}
	}
}

/**
 * Upper bounds on how many guides of each kind `snapPoints` can produce at
 * once, so the instanced meshes are sized once per scenario rather than per
 * pointer move.
 */
export function snapGuideCapacity(snapPoints: SnapPoints | undefined | null): {
	points: number;
	cells: number;
} {
	let points = 0;
	let cells = 0;
	for (const id in snapPoints ?? {}) {
		const point = snapPoints?.[id];
		if (!point || !centreOf(point)) continue;
		if (point.kind !== 'grid') {
			points++;
			continue;
		}
		const grid = lattice(point);
		if (!grid) continue;
		const side = 2 * Math.ceil(gridRevealRadius(grid.pitch) / grid.pitch) + 1;
		cells += Math.min(grid.cols, side) * Math.min(grid.rows, side);
	}
	return { points, cells };
}

/** Round a capacity up to a power of two (min 8), so a growing scenario rebuilds rarely. */
export function poolSize(n: number): number {
	let size = 8;
	while (size < n) size *= 2;
	return size;
}

/** does the scenario have anything a lifted entity could snap to at all */
export function hasSnapPoints(snapPoints: SnapPoints | undefined | null): boolean {
	for (const id in snapPoints ?? {}) if (snapPoints?.[id]) return true;
	return false;
}

/**
 * Does an overlay of world size `width × depth`, centred at `position` and
 * yawed by `yaw` (radians, its group's rotation.y), lie under any snap point?
 * Only those overlays dim while something is lifted — a decorative image
 * with no landing spots on it has nothing to recede behind.
 */
export function overlayUnderSnapPoints(
	snapPoints: SnapPoints | undefined | null,
	position: readonly number[] | undefined,
	yaw: number,
	width: number,
	depth: number
): boolean {
	const ox = position?.[0] ?? 0;
	const oz = position?.[2] ?? 0;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	for (const id in snapPoints ?? {}) {
		const point = snapPoints?.[id];
		const centre = point ? centreOf(point) : null;
		if (!centre) continue;
		const dx = centre[0] - ox;
		const dz = centre[1] - oz;
		// world → overlay-local: the inverse of the group's yaw about +y
		const lx = dx * cos - dz * sin;
		const lz = dx * sin + dz * cos;
		if (Math.abs(lx) <= width / 2 && Math.abs(lz) <= depth / 2) return true;
	}
	return false;
}
