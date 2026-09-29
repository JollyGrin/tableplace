import { CARD_HEIGHT } from './constants-cards';
import * as THREE from 'three';
import {
	CAMERA_DEFAULT_HEIGHT,
	CAMERA_FIT_MAX_DISTANCE,
	CAMERA_FIT_PADDING,
	CAMERA_FOV_DEG
} from './constants-camera';
import { PIECE_DEFAULT_RADIUS } from './constants-pieces';
import type { GameDTO } from '$lib/store/game/types';

/** xz extent on the felt */
export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/**
 * xz bounding box of everything on the table — cards, decks, pieces, overlays —
 * by footprint. Undefined on an empty table. A card is bounded by its circumscribed
 * circle (its diagonal is the worst case whatever the yaw), so the box never clips
 * a tapped or landscape card.
 */
export function contentBounds(state: Partial<GameDTO> | undefined): Bounds | undefined {
	if (!state) return undefined;
	let b: Bounds | undefined;
	const add = (x: unknown, z: unknown, rx: number, rz = rx) => {
		if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) return;
		b ??= { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
		b.minX = Math.min(b.minX, x - rx);
		b.maxX = Math.max(b.maxX, x + rx);
		b.minZ = Math.min(b.minZ, z - rz);
		b.maxZ = Math.max(b.maxZ, z + rz);
	};
	const cardRadius = CARD_HEIGHT / 2;
	for (const c of Object.values(state.cards ?? {}))
		add(c?.position?.[0], c?.position?.[2], cardRadius);
	for (const d of Object.values(state.decks ?? {}))
		add(d?.position?.[0], d?.position?.[2], cardRadius);
	for (const p of Object.values(state.pieces ?? {})) {
		add(p?.position?.[0], p?.position?.[2], p?.radius ?? PIECE_DEFAULT_RADIUS);
	}
	for (const o of Object.values(state.overlays ?? {})) {
		const h = (o?.scale ?? 12) / 2;
		add(o?.position?.[0], o?.position?.[2], h * (o?.ratio ?? 1), h);
	}
	return b;
}

export type Vec3 = [number, number, number];

/** where the eye is and what it looks at */
export type CameraPose = { position: Vec3; target: Vec3 };

/**
 * Which way the eye looks, as orbit angles around the target. `azimuth` is the
 * compass bearing of the eye from the target (0 = the +z side, π/2 = +x), and
 * `polar` its tilt from straight up (0 = looking straight down).
 */
export type ViewAngle = { azimuth: number; polar: number };

/**
 * The bearing a seat sits at, from its table rotation (0/180/90/270 — see
 * `SEAT_ROTATION_DEG`). Seat 0 sits on the +z edge, seat 1 across from it,
 * seats 2/3 on the +x/−x ends — the same sides `seatYaw` puts their things on.
 */
export function seatAzimuth(rotationDeg: number): number {
	return (rotationDeg * Math.PI) / 180;
}

/** the eye `distance` from `target` along `angle` */
export function poseAt(target: Vec3, distance: number, angle: ViewAngle): CameraPose {
	const s = Math.sin(angle.polar);
	return {
		target,
		position: [
			target[0] + distance * s * Math.sin(angle.azimuth),
			target[1] + distance * Math.cos(angle.polar),
			target[2] + distance * s * Math.cos(angle.azimuth)
		]
	};
}

/** the orbit angles of a pose — the inverse of `poseAt` */
export function angleOf({ position, target }: CameraPose): ViewAngle {
	const dx = position[0] - target[0];
	const dy = position[1] - target[1];
	const dz = position[2] - target[2];
	const r = Math.hypot(dx, dy, dz) || 1;
	return { azimuth: Math.atan2(dx, dz), polar: Math.acos(Math.min(1, Math.max(-1, dy / r))) };
}

export type FitOptions = {
	minDistance?: number;
	maxDistance?: number;
	padding?: number;
};

/** how tall the content box is: pieces and stacks stand up off the felt */
const FIT_HEIGHT = 1;

/**
 * The pose that frames `bounds` at `aspect`, looking along `angle`.
 *
 * A tilted camera sees a box as a trapezoid — the near edge wider than the far
 * one — so there is no closed form like the straight-down one. Instead: search
 * the distance at which every corner of the box projects inside the (padded)
 * frame, then re-aim at the ground point under the middle of what is on screen
 * so the box sits centred rather than bunched toward the far edge, and repeat.
 * Works for any seat bearing and any tilt, top-down included. The distance
 * never drops below `minDistance` (a lone deck is not worth a close-up) and
 * never exceeds `maxDistance`.
 */
export function fitPose(
	bounds: Bounds,
	aspect: number,
	angle: ViewAngle,
	{
		minDistance = CAMERA_DEFAULT_HEIGHT,
		maxDistance = CAMERA_FIT_MAX_DISTANCE,
		padding = CAMERA_FIT_PADDING
	}: FitOptions = {}
): CameraPose {
	const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 10_000);
	const corners: THREE.Vector3[] = [];
	for (const x of [bounds.minX, bounds.maxX])
		for (const z of [bounds.minZ, bounds.maxZ])
			for (const y of [0, FIT_HEIGHT]) corners.push(new THREE.Vector3(x, y, z));
	const limit = 1 / padding;
	const scratch = new THREE.Vector3();

	const place = (pose: CameraPose) => {
		camera.position.set(...pose.position);
		camera.lookAt(...pose.target);
		camera.updateMatrixWorld();
	};
	/** the NDC box the corners project to, or null if any is behind the eye */
	const extent = (pose: CameraPose) => {
		place(pose);
		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity;
		for (const corner of corners) {
			scratch.copy(corner).applyMatrix4(camera.matrixWorldInverse);
			if (scratch.z >= -camera.near) return null;
			scratch.copy(corner).project(camera);
			minX = Math.min(minX, scratch.x);
			maxX = Math.max(maxX, scratch.x);
			minY = Math.min(minY, scratch.y);
			maxY = Math.max(maxY, scratch.y);
		}
		return { minX, maxX, minY, maxY };
	};
	const fits = (target: Vec3, distance: number) => {
		const e = extent(poseAt(target, distance, angle));
		return !!e && e.minX >= -limit && e.maxX <= limit && e.minY >= -limit && e.maxY <= limit;
	};

	/** the closest distance (within the limits) at which the box fits from `target` */
	const search = (target: Vec3) => {
		if (fits(target, minDistance)) return minDistance;
		if (!fits(target, maxDistance)) return maxDistance;
		let [lo, hi] = [minDistance, maxDistance];
		for (let i = 0; i < 32; i++) {
			const mid = (lo + hi) / 2;
			if (fits(target, mid)) hi = mid;
			else lo = mid;
		}
		return hi;
	};

	const felt = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	const ray = new THREE.Raycaster();
	let target: Vec3 = [(bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2];
	let distance = search(target);
	for (let pass = 0; pass < 4; pass++) {
		// re-aim at the felt under the middle of the projected box
		const e = extent(poseAt(target, distance, angle));
		if (!e) break;
		ray.setFromCamera(new THREE.Vector2((e.minX + e.maxX) / 2, (e.minY + e.maxY) / 2), camera);
		const hit = ray.ray.intersectPlane(felt, scratch);
		if (!hit) break;
		const next: Vec3 = [hit.x, 0, hit.z];
		if (Math.hypot(next[0] - target[0], next[2] - target[2]) < 1e-3) break;
		target = next;
		distance = search(target);
	}
	return poseAt(target, distance, angle);
}
