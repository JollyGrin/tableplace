import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	Weight,
	bounceArc,
	flipHopFor,
	leanFor,
	weightEnabled,
	weightOn,
	type WeightSample
} from '../weight.svelte';
import { noteFrame, resetFrameStalls } from '../frame-stall.svelte';
import {
	WEIGHT_BOUNCE_HEIGHT,
	WEIGHT_BOUNCE_MS,
	WEIGHT_FLIP_HOP,
	WEIGHT_LEAN_MAX_DEG
} from '../constants-weight';

/**
 * Weight is feel, and feel is exactly what may never cost legibility or a
 * landing: these pin the caps, that the bounce only ever follows a touchdown,
 * and that every way of switching it off leaves an entity level and at rest.
 */

const FRAME = 1000 / 60;
const CARD_CAP = (WEIGHT_LEAN_MAX_DEG.card * Math.PI) / 180;

/** a scripted entity: tests move it, the Weight samples it */
function rig(kind: 'card' | 'piece' = 'piece') {
	const sample: WeightSample = { x: 0, z: 0, y: 1.2, rest: 1.2, carried: true };
	const weight = new Weight(kind, () => ({ ...sample }));
	let now = 0;
	const step = () => weight.step((now += FRAME));
	return { sample, weight, step };
}

describe('weight', () => {
	beforeEach(() => {
		resetFrameStalls();
		weightEnabled.set(true);
	});
	afterEach(() => {
		vi.useRealTimers();
		weightEnabled.set(true);
	});

	it('leans against the travel, proportional to speed and capped', () => {
		const [slowX, slowZ] = leanFor(2, 0, CARD_CAP);
		expect(slowX).toBeCloseTo(0);
		// moving +x: the top trails toward −x, which is a positive turn about z
		expect(slowZ).toBeGreaterThan(0);
		expect(leanFor(4, 0, CARD_CAP)[1]).toBeCloseTo(slowZ * 2);
		expect(leanFor(0, 2, CARD_CAP)[0]).toBeLessThan(0);
		expect(leanFor(1e4, -1e4, CARD_CAP)).toEqual([CARD_CAP, CARD_CAP]);
	});

	it('bounces once, in a single arc', () => {
		expect(bounceArc(0, 1)).toBe(0);
		expect(bounceArc(WEIGHT_BOUNCE_MS / 2, 1)).toBeCloseTo(1);
		expect(bounceArc(WEIGHT_BOUNCE_MS, 1)).toBe(0);
		expect(bounceArc(WEIGHT_BOUNCE_MS * 2, 1)).toBe(0);
	});

	it('hops at edge-on and not at either end of a flip', () => {
		expect(flipHopFor(0, 180)).toBe(0);
		expect(flipHopFor(90, 180)).toBeCloseTo(WEIGHT_FLIP_HOP);
		expect(flipHopFor(180, 180)).toBe(0);
		expect(flipHopFor(90, 0)).toBeCloseTo(WEIGHT_FLIP_HOP);
	});

	it('leans while carried and levels out after the drop', () => {
		const { sample, weight, step } = rig('card');
		step();
		for (let i = 0; i < 20; i++) {
			sample.x += 0.3; // 18 units a second: well past the cap
			step();
		}
		expect(weight.tiltZ).toBeGreaterThan(0);
		expect(weight.tiltZ).toBeLessThanOrEqual(CARD_CAP + 1e-9);
		sample.carried = false;
		sample.rest = 0.3;
		let running = true;
		for (let i = 0; i < 200 && running; i++) running = step();
		expect(running).toBe(false);
		expect(weight.tiltX).toBe(0);
		expect(weight.tiltZ).toBe(0);
		expect(weight.lift).toBe(0);
	});

	it('bounces only once the fall has touched down', () => {
		const { sample, weight, step } = rig('piece');
		step();
		sample.carried = false;
		sample.rest = 0.335;
		step();
		// still falling: nothing added, so nothing delays the landing
		sample.y = 0.8;
		step();
		expect(weight.lift).toBe(0);
		// touchdown, and a dip under the rest the spring overshoots into
		sample.y = 0.3;
		step();
		const peaks: number[] = [];
		for (let i = 0; i < 12; i++) {
			step();
			peaks.push(weight.lift);
		}
		// held at the surface, never below it, and up by at most the bounce
		expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...peaks)).toBeGreaterThan(0.035);
		expect(Math.max(...peaks)).toBeLessThanOrEqual(0.035 + WEIGHT_BOUNCE_HEIGHT.piece + 1e-9);
		sample.y = sample.rest;
		for (let i = 0; i < 20; i++) step();
		expect(weight.lift).toBe(0);
	});

	it('draws nothing when switched off in Settings', () => {
		weightEnabled.set(false);
		expect(weightOn()).toBe(false);
		const { sample, weight, step } = rig('piece');
		step();
		for (let i = 0; i < 10; i++) {
			sample.x += 0.3;
			expect(step()).toBe(true); // still watching: it is carried
		}
		expect(weight.tiltZ).toBe(0);
		sample.carried = false;
		expect(step()).toBe(false);
		expect(weight.lift).toBe(0);
	});

	it('persists the Settings toggle', () => {
		weightEnabled.set(false);
		expect(localStorage.getItem('weight:v1')).toBe('off');
		weightEnabled.set(true);
		expect(localStorage.getItem('weight:v1')).toBeNull();
		expect(get(weightEnabled)).toBe(true);
	});

	it('draws nothing while the frame loop is stalling', () => {
		vi.useFakeTimers();
		noteFrame(0);
		noteFrame(500); // one long gap: a stall
		const { sample, weight, step } = rig('piece');
		step();
		for (let i = 0; i < 10; i++) {
			sample.x += 0.3;
			step();
		}
		expect(weight.tiltZ).toBe(0);
	});
});
