/**
 * Rudimentary collision for model pieces: where drops rest when they land on
 * geometry instead of felt (tableplace-135).
 *
 * There is no physics engine and no gravity here — rest heights are computed
 * by `resolveDrop` — so "collision" is exactly one question: what is the
 * surface height under this (x, z)? Answered by a downward raycast against the
 * mounted meshes of every `kind: 'model'` piece, which `Model.svelte`
 * registers here. Highest hit wins; a hit at felt level (or none) answers
 * `undefined`, and the caller's fallback chain (`snap.y ?? surfaceYAt(x, z) ??
 * TABLE_TOP_Y`) does the rest.
 *
 * A raycast, not a bounding box, on purpose: a box top would float a token at
 * wall height when it was dropped *inside* a room — the ray finds the real
 * floor between the walls. Kit meshes average ~1.6k triangles, so per-frame
 * preview raycasts are cheap; if a huge map ever measures slow, three-mesh-bvh
 * is the drop-in.
 */

import * as THREE from 'three';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';

/** mounted model scene graphs by piece id — world transforms live on them */
const surfaces = new Map<string, THREE.Object3D>();

export function registerModelSurface(id: string, object: THREE.Object3D): void {
	surfaces.set(id, object);
}

/** Only the object that claimed the id may release it (remount order). */
export function unregisterModelSurface(id: string, object: THREE.Object3D): void {
	if (surfaces.get(id) === object) surfaces.delete(id);
}

/** well above anything on the table (drag height is ~2, walls ~2) */
const RAY_START_Y = 50;
/** hits this close to the felt are the felt: let the default answer instead */
const FELT_EPSILON = 1e-3;

const raycaster = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
const origin = new THREE.Vector3();

/**
 * Build the `surfaceYAt` callback `resolveDrop`'s options take, excluding the
 * entity being dragged, which floats over its own drop point and must not
 * become its own floor — or every entity of a group drag, which all float.
 */
export function modelSurfaceYAt(
	exclude?: string | readonly string[] | null
): (x: number, z: number) => number | undefined {
	const excluded = typeof exclude === 'string' ? [exclude] : (exclude ?? []);
	return (x, z) => {
		let best: number | undefined;
		for (const [id, object] of surfaces) {
			if (excluded.includes(id)) continue;
			origin.set(x, RAY_START_Y, z);
			raycaster.set(origin, DOWN);
			// first intersection from above is the highest surface of this model
			const y = raycaster.intersectObject(object, true)[0]?.point.y;
			if (y !== undefined && (best === undefined || y > best)) best = y;
		}
		return best !== undefined && best > TABLE_TOP_Y + FELT_EPSILON ? best : undefined;
	};
}
