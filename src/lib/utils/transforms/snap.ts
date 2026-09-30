import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { turnYaw } from '$lib/utils/yaw';
import type { GameDTO, SnapPointDTO } from '$lib/store/game/types';
import {
	SNAP_GRID_YAW_STEP_DEFAULT,
	SNAP_RADIUS_DEFAULT,
	SNAP_RADIUS_MAX,
	SNAP_RADIUS_MIN
} from '$lib/utils/constants-snap';

/**
 * Snap points: where a drop is *pulled to*, as opposed to where the pointer
 * happened to be.
 *
 * The whole mechanic is this one pure function plus a branch in `resolveDrop`.
 * Nothing about a snap is synced on its own: the dropping client resolves the
 * point, writes the final position through the same move path as any other
 * drop, and the relay carries that — so both clients land on the identical
 * transform without any new machinery.
 *
 * A point with `kind: 'grid'` is a lattice of square cells rather than one
 * spot: a drop anywhere over its extent pulls to the nearest cell centre, and
 * the landing's yaw steps to the nearest `yawStep` multiple. Candidates from
 * grids and discrete points compete on distance; an authored discrete point
 * beats a generated cell on ties — authored intent over generated lattice.
 */

/** A resolved snap: the exact transform a caught drop commits at. */
export interface SnapResolution {
	/** which snap point caught the drop */
	id: string;
	x: number;
	z: number;
	/** the local floor the landing rests on, when the point authors one */
	y?: number;
	/** authored yaw in degrees, or undefined to keep the entity's own rotation */
	rotation?: number;
	/** the radius that caught it, after clamping (a cell's is half its pitch) */
	radius: number;
	/** distance from the drop point to the snap point */
	distance: number;
	/** set when a grid cell caught the drop — the preview draws the cell */
	grid?: { pitch: number; rotation: number };
}

/** `snap:2` before `snap:10` — creation order, not lexicographic order. */
export function compareSnapIds(a: string, b: string): number {
	const na = Number(a.split(':')[1]);
	const nb = Number(b.split(':')[1]);
	if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Authored radius, clamped to something that can actually catch a drop. */
export function snapRadius(point: Partial<SnapPointDTO> | null | undefined): number {
	const raw = point?.radius;
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return SNAP_RADIUS_DEFAULT;
	return Math.min(Math.max(raw, SNAP_RADIUS_MIN), SNAP_RADIUS_MAX);
}

function xz(point: Partial<SnapPointDTO> | null | undefined): [number, number] | null {
	const p = point?.position;
	if (!Array.isArray(p) || p.length < 2) return null;
	const [x, z] = p;
	if (typeof x !== 'number' || typeof z !== 'number') return null;
	if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
	return [x, z];
}

function finite(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/** The elevation a point authors, if any — carried onto the resolution. */
function elevation(point: Partial<SnapPointDTO>): { y?: number } {
	return finite(point.y) ? { y: point.y } : {};
}

type Candidate = Omit<SnapResolution, 'id'>;

function pointCandidate(point: Partial<SnapPointDTO>, x: number, z: number): Candidate | null {
	const position = xz(point);
	if (!position) return null;
	const radius = snapRadius(point);
	const distance = Math.hypot(position[0] - x, position[1] - z);
	if (distance > radius) return null;
	const rotation = finite(point.rotation) ? point.rotation : undefined;
	return { x: position[0], z: position[1], rotation, radius, distance, ...elevation(point) };
}

/**
 * The nearest cell centre of a grid, when the drop is over its extent at all.
 *
 * The extent is the catch area — `cols·pitch × rows·pitch` around the centre,
 * yawed by `rotation` — and it is deliberately NOT clamped by
 * `SNAP_RADIUS_MAX`: a whole-table snap *point* is a bug, a grid covering
 * area is the point of a grid.
 *
 * `entityYaw` is the dragged entity's current table yaw in degrees; the cell
 * turns it to the nearest `yawStep` multiple measured from the grid's own
 * yaw, so tiles land aligned with the lattice however they were carried.
 */
function gridCandidate(
	point: Partial<SnapPointDTO>,
	x: number,
	z: number,
	entityYaw: number
): Candidate | null {
	const centre = xz(point);
	if (!centre) return null;
	const { pitch, cols, rows } = point;
	if (!finite(pitch) || pitch <= 0) return null;
	if (!Number.isInteger(cols) || (cols as number) < 1) return null;
	if (!Number.isInteger(rows) || (rows as number) < 1) return null;

	// grid-local axes, same yaw convention as a card's table rotation: local
	// +u is the cols direction, +v the rows direction (world -z at yaw 0)
	const yaw = finite(point.rotation) ? point.rotation : 0;
	const theta = yaw * DEG2RAD;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const dx = x - centre[0];
	const dz = z - centre[1];
	const u = dx * cos + dz * sin;
	const v = dx * sin - dz * cos;
	if (Math.abs(u) > ((cols as number) * pitch) / 2) return null;
	if (Math.abs(v) > ((rows as number) * pitch) / 2) return null;

	const clampIndex = (raw: number, count: number) =>
		Math.min(count - 1, Math.max(0, Math.round(raw)));
	const cu =
		(clampIndex(u / pitch + ((cols as number) - 1) / 2, cols as number) -
			((cols as number) - 1) / 2) *
		pitch;
	const cv =
		(clampIndex(v / pitch + ((rows as number) - 1) / 2, rows as number) -
			((rows as number) - 1) / 2) *
		pitch;
	const cx = centre[0] + cu * cos + cv * sin;
	const cz = centre[1] + cu * sin - cv * cos;

	const step =
		finite(point.yawStep) && point.yawStep > 0 ? point.yawStep : SNAP_GRID_YAW_STEP_DEFAULT;
	const rotation = yaw + Math.round((entityYaw - yaw) / step) * step;

	return {
		x: cx,
		z: cz,
		rotation,
		radius: pitch / 2,
		distance: Math.hypot(cx - x, cz - z),
		grid: { pitch, rotation: yaw },
		...elevation(point)
	};
}

/**
 * The snap point (or grid cell) that catches a drop at (x, z), or null if
 * none does.
 *
 * Nearest candidate wins, so overlapping catch areas resolve to the one the
 * drop is actually closest to. On an exact distance tie an authored discrete
 * point beats a generated grid cell, and after that ties break on id (in
 * numeric `snap:<n>` order, matching how the pane lists them) — records
 * arrive in whatever order a merge patch built them, and a snap must not
 * depend on that.
 *
 * `entityYaw` (degrees) only matters over a grid: it is what the cell's yaw
 * stepping rounds. Callers resolving for a deck convert its radians first.
 */
export function resolveSnap(
	snapPoints: GameDTO['snapPoints'] | undefined | null,
	x: number,
	z: number,
	entityYaw: number = 0
): SnapResolution | null {
	let best: SnapResolution | null = null;

	for (const [id, point] of Object.entries(snapPoints ?? {})) {
		if (!point) continue; // null = removed
		const candidate =
			point.kind === 'grid' ? gridCandidate(point, x, z, entityYaw) : pointCandidate(point, x, z);
		if (!candidate) continue; // out of range, or a malformed entry
		if (best) {
			if (candidate.distance > best.distance) continue;
			if (candidate.distance === best.distance) {
				const bestIsPoint = !best.grid;
				const candidateIsPoint = !candidate.grid;
				if (bestIsPoint && !candidateIsPoint) continue;
				if (bestIsPoint === candidateIsPoint && compareSnapIds(id, best.id) >= 0) continue;
			}
		}
		best = { id, ...candidate };
	}

	return best;
}

/**
 * Which entity is landing. They do not agree on where — or in what unit — a
 * table yaw lives, so a single authored scalar has to be routed per kind.
 */
export type SnapRotationTarget = 'card' | 'piece' | 'deck';

/**
 * Apply an authored snap yaw (degrees) to an entity's rotation triple.
 *
 * The three conventions, none of which this function gets to choose:
 * - **cards** — yaw is `rotation[2]` in **degrees** (what `tapCard` turns;
 *   `Card.svelte` renders it as `rotation.y = -z`), and `rotation[0]` is the
 *   facedown flip, which a snap must never touch.
 * - **pieces** — yaw is the natural `rotation[1]`, in **degrees**. Today
 *   nothing renders it (a token is a disc), but it is part of the piece's
 *   transform and both clients must agree on it.
 * - **decks** — yaw is `rotation[1]` in **radians**: `Deck.svelte` hands the
 *   triple straight to its `<T.Group>`, and the seat-1 default is
 *   `[0, Math.PI, 0]`. So the authored degrees convert here; writing degrees
 *   into a deck would spin it by a factor of 57.
 *
 * The sign differs too (tableplace-228): cards and pieces render their yaw
 * negated, so a positive authored yaw turns them clockwise seen from above,
 * while a deck's radians reach three.js as they are, where positive is
 * counter-clockwise. `turnYaw` owns that flip, so the deck goes through it and
 * one authored yaw turns all three the same way on screen.
 *
 * Returns the input untouched when the point authored no rotation — an
 * unrotated snap point is a position guide only.
 */
export function applySnapRotation(
	rotation: [number, number, number],
	yaw: number | undefined,
	target: SnapRotationTarget
): [number, number, number] {
	if (yaw === undefined) return rotation;
	const [x, y, z] = rotation;
	switch (target) {
		case 'card':
			return [x, y, yaw];
		case 'piece':
			return [x, yaw, z];
		case 'deck':
			return turnYaw('deck', [x, 0, z], yaw);
	}
}
