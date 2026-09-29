import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
	angleOf,
	contentBounds,
	fitPose,
	seatAzimuth,
	type Bounds,
	type CameraPose
} from '../camera-fit';
import {
	CAMERA_DEFAULT_HEIGHT,
	CAMERA_FIT_MAX_DISTANCE,
	CAMERA_FOV_DEG,
	CAMERA_SEAT_POLAR,
	CAMERA_TOP_POLAR
} from '../constants-camera';
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

const distance = (pose: CameraPose) =>
	Math.hypot(...pose.position.map((v, i) => v - pose.target[i]!));

/** every corner of `bounds`, on the felt and a unit above it, projected through `pose` */
function projected(pose: CameraPose, bounds: Bounds, aspect: number) {
	const cam = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.5, 200);
	cam.position.set(...pose.position);
	cam.lookAt(...pose.target);
	cam.updateMatrixWorld(true);
	const out: THREE.Vector3[] = [];
	for (const x of [bounds.minX, bounds.maxX])
		for (const z of [bounds.minZ, bounds.maxZ])
			for (const y of [0, 1]) out.push(new THREE.Vector3(x, y, z).project(cam));
	return out;
}

const SEAT = (rotationDeg: number, polar = CAMERA_SEAT_POLAR) => ({
	azimuth: seatAzimuth(rotationDeg),
	polar
});

describe('fitPose', () => {
	const spread = contentBounds({
		pieces: { a: piece(-20, -12.5), b: piece(20, -12.5), c: piece(-20, 12.5), d: piece(20, 12.5) }
	})!;

	describe.each([
		['16:10', 16 / 10],
		['16:9', 16 / 9],
		['4:3', 4 / 3],
		['3:4 portrait', 3 / 4]
	])('at %s', (_n, aspect) => {
		it.each([0, 180, 90, 270])('frames the whole box from the seat at %i°', (rotation) => {
			for (const polar of [CAMERA_SEAT_POLAR, CAMERA_TOP_POLAR]) {
				const pose = fitPose(spread, aspect, SEAT(rotation, polar));
				for (const ndc of projected(pose, spread, aspect)) {
					expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
					expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
				}
			}
		});
	});

	it("sits the eye on the seat's own side, tilted about 45°", () => {
		const at = (rotation: number) => fitPose(spread, 16 / 9, SEAT(rotation));
		expect(at(0).position[2]).toBeGreaterThan(10);
		expect(at(180).position[2]).toBeLessThan(-10);
		expect(at(90).position[0]).toBeGreaterThan(10);
		expect(at(270).position[0]).toBeLessThan(-10);
		const tilt = angleOf(at(0)).polar;
		expect(tilt).toBeCloseTo(Math.PI / 4, 5);
	});

	it('top-down still knows which way the seat faces', () => {
		const top = fitPose(spread, 16 / 9, SEAT(180, CAMERA_TOP_POLAR));
		expect(top.position[2]).toBeLessThan(top.target[2]);
		expect(angleOf(top).polar).toBeLessThan(0.01);
	});

	it('is centred: the box does not bunch toward one edge', () => {
		const pose = fitPose(spread, 16 / 9, SEAT(0));
		const ys = projected(pose, spread, 16 / 9).map((p) => p.y);
		expect(Math.abs(Math.min(...ys) + Math.max(...ys))).toBeLessThan(0.05);
	});

	it('never closer than the default view, never past the fit max', () => {
		const tiny = contentBounds({ pieces: { a: piece(0, 0) } })!;
		expect(distance(fitPose(tiny, 16 / 10, SEAT(0)))).toBeCloseTo(CAMERA_DEFAULT_HEIGHT, 5);
		const huge = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
		expect(distance(fitPose(huge, 16 / 10, SEAT(0)))).toBeCloseTo(CAMERA_FIT_MAX_DISTANCE, 5);
	});

	it('a quarter-turn seat needs more distance for a long, thin table', () => {
		const wide = { minX: -15, maxX: 15, minZ: -1, maxZ: 1 };
		const top = (rotation: number) =>
			distance(fitPose(wide, 16 / 10, SEAT(rotation, CAMERA_TOP_POLAR), { minDistance: 1 }));
		expect(top(90)).toBeGreaterThan(top(0));
	});
});
