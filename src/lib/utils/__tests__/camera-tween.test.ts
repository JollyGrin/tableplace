import { describe, expect, it } from 'vitest';
import { angleOf, type CameraPose } from '../camera-fit';
import { distanceOf, easeInOutCubic, interpolatePose } from '../camera-tween';

describe('easeInOutCubic', () => {
	it('starts at 0, lands on 1, and is symmetric', () => {
		expect(easeInOutCubic(0)).toBe(0);
		expect(easeInOutCubic(1)).toBe(1);
		expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
		expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
	});
});

describe('interpolatePose', () => {
	const seat: CameraPose = { position: [0, 20, 20], target: [0, 0, 0] };
	const top: CameraPose = { position: [0, 30, 0.1], target: [2, 0, 0] };

	it('ends where it starts and where it lands', () => {
		const a = interpolatePose(seat, top, 0);
		const b = interpolatePose(seat, top, 1);
		a.position.forEach((v, i) => expect(v).toBeCloseTo(seat.position[i]!));
		b.position.forEach((v, i) => expect(v).toBeCloseTo(top.position[i]!, 3));
		b.target.forEach((v, i) => expect(v).toBeCloseTo(top.target[i]!));
	});

	it('swings round the target instead of cutting a chord', () => {
		const mid = interpolatePose(seat, top, 0.5);
		const d = distanceOf(mid);
		expect(d).toBeCloseTo((distanceOf(seat) + distanceOf(top)) / 2);
	});

	it('turns the short way round', () => {
		const east: CameraPose = { position: [10, 10, 0.0], target: [0, 0, 0] };
		const northWest: CameraPose = { position: [-7, 10, -7.1], target: [0, 0, 0] };
		const south: CameraPose = { position: [0.001, 10, 10], target: [0, 0, 0] };
		// from +x to the +z side the short way is a quarter turn, never three
		const mid = angleOf(interpolatePose(east, south, 0.5)).azimuth;
		expect(mid).toBeCloseTo(Math.PI / 4, 2);
		expect(Math.abs(angleOf(interpolatePose(east, northWest, 0.01)).azimuth)).toBeLessThan(Math.PI);
	});
});
