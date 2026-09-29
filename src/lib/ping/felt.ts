import * as THREE from 'three';
import { TABLE_HALF_X, TABLE_HALF_Z, TABLE_TOP_Y } from '$lib/utils/constants-table';
import type { PingValue } from './ping';

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const felt = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_TOP_Y);
const hit = new THREE.Vector3();

/**
 * The spot on the felt under a client-pixel point, or null when that pixel is
 * not over the felt (the rim, the room, the sky). The felt is a plane, so this
 * is one ray-plane intersection — no scene raycast, no dispatch.
 */
export function feltPointAt(
	camera: THREE.Camera,
	rect: { left: number; top: number; width: number; height: number },
	clientX: number,
	clientY: number
): PingValue | null {
	if (!rect.width || !rect.height) return null;
	ndc.set(
		((clientX - rect.left) / rect.width) * 2 - 1,
		-((clientY - rect.top) / rect.height) * 2 + 1
	);
	raycaster.setFromCamera(ndc, camera);
	if (!raycaster.ray.intersectPlane(felt, hit)) return null;
	if (Math.abs(hit.x) > TABLE_HALF_X || Math.abs(hit.z) > TABLE_HALF_Z) return null;
	return { x: hit.x, z: hit.z };
}
