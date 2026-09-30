import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
	CAMERA_FOV_DEG,
	CAMERA_FRAME_ASPECT,
	CAMERA_MAX_DISTANCE,
	CAMERA_SEAT_POLAR,
	distanceToFrameFelt
} from '../constants-camera';
import { fitPose } from '../camera-fit';
import { TABLE_HALF_X, TABLE_HALF_Z, TABLE_TOP_Y } from '../constants-table';

describe('camera max distance', () => {
	it.each([
		['16:10', 16 / 10],
		['16:9', 16 / 9],
		['21:9', 21 / 9]
	])('frames all four felt corners at %s', (_name, aspect) => {
		const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.5, 200);
		camera.position.set(0, CAMERA_MAX_DISTANCE, 0);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld(true);
		for (const sx of [-1, 1]) {
			for (const sz of [-1, 1]) {
				const ndc = new THREE.Vector3(sx * TABLE_HALF_X, TABLE_TOP_Y, sz * TABLE_HALF_Z).project(
					camera
				);
				expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
				expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
			}
		}
	});

	it('is enough for 16:10 straight down', () => {
		expect(CAMERA_MAX_DISTANCE).toBeGreaterThanOrEqual(distanceToFrameFelt(CAMERA_FRAME_ASPECT));
	});

	it("is enough for 16:10 from the seat view's 45° and not wildly more", () => {
		const felt = {
			minX: -TABLE_HALF_X,
			maxX: TABLE_HALF_X,
			minZ: -TABLE_HALF_Z,
			maxZ: TABLE_HALF_Z
		};
		const pose = fitPose(
			felt,
			CAMERA_FRAME_ASPECT,
			{ azimuth: 0, polar: CAMERA_SEAT_POLAR },
			{ padding: 1, minDistance: 1 }
		);
		const needed = Math.hypot(...pose.position.map((v, i) => v - pose.target[i]!));
		expect(CAMERA_MAX_DISTANCE).toBeGreaterThanOrEqual(needed);
		expect(CAMERA_MAX_DISTANCE).toBeLessThan(needed * 1.1);
	});
});
