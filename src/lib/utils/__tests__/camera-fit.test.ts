import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { contentBounds, fitCamera } from '../camera-fit';
import { CAMERA_DEFAULT_HEIGHT, CAMERA_FOV_DEG, CAMERA_MAX_DISTANCE } from '../constants-camera';
import type { GameDTO } from '$lib/store/game/types';

const piece = (x: number, z: number) =>
	({ position: [x, 0.16, z], rotation: [0, 0, 0], kind: 'token', name: 't' }) as never;

describe('contentBounds', () => {
	it('is undefined on an empty table', () => {
		expect(contentBounds(undefined)).toBeUndefined();
		expect(contentBounds({ cards: {}, decks: {}, pieces: {} } as Partial<GameDTO>)).toBeUndefined();
	});

	it('grows to cover every kind of entity by footprint', () => {
		const b = contentBounds({
			pieces: { a: piece(-20, -12.5), b: piece(20, 12.5) },
			overlays: { o: { position: [0, 0, 0], scale: 10, ratio: 2 } as never }
		})!;
		expect(b.minX).toBeLessThan(-20);
		expect(b.maxX).toBeGreaterThan(20);
		expect(b.minZ).toBeLessThan(-12.5);
		expect(b.maxZ).toBeGreaterThan(12.5);
	});
});

describe('fitCamera', () => {
	const spread = contentBounds({
		pieces: { a: piece(-20, -12.5), b: piece(20, -12.5), c: piece(-20, 12.5), d: piece(20, 12.5) }
	})!;

	it.each([
		['16:10', 16 / 10],
		['16:9', 16 / 9],
		['4:3', 4 / 3]
	])('projects the whole box inside the frame at %s', (_n, aspect) => {
		const fit = fitCamera(spread, aspect);
		const cam = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.5, 200);
		cam.position.set(fit.x, fit.distance, fit.z + 0.01);
		cam.lookAt(fit.x, 0, fit.z);
		cam.updateMatrixWorld(true);
		for (const x of [spread.minX, spread.maxX])
			for (const z of [spread.minZ, spread.maxZ]) {
				const ndc = new THREE.Vector3(x, 0.16, z).project(cam);
				expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
				expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
			}
	});

	it('never closer than the default view, never past the max', () => {
		const tiny = contentBounds({ pieces: { a: piece(0, 0) } })!;
		expect(fitCamera(tiny, 16 / 10).distance).toBe(CAMERA_DEFAULT_HEIGHT);
		const huge = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
		expect(fitCamera(huge, 16 / 10).distance).toBe(CAMERA_MAX_DISTANCE);
	});

	it('swaps axes for the quarter-turn seats', () => {
		const wide = { minX: -15, maxX: 15, minZ: -1, maxZ: 1 };
		expect(fitCamera(wide, 16 / 10, true).distance).toBeGreaterThan(
			fitCamera(wide, 16 / 10, false).distance
		);
	});
});
