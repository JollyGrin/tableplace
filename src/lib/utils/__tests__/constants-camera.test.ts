import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
	CAMERA_FOV_DEG,
	CAMERA_FRAME_ASPECT,
	CAMERA_MAX_DISTANCE,
	distanceToFrameFelt
} from '../constants-camera';
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

	it('is enough for 16:10 and not wildly more', () => {
		const needed = distanceToFrameFelt(CAMERA_FRAME_ASPECT);
		expect(CAMERA_MAX_DISTANCE).toBeGreaterThanOrEqual(needed);
		expect(CAMERA_MAX_DISTANCE).toBeLessThan(needed * 1.1);
	});
});
