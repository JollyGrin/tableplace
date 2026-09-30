import { describe, expect, it } from 'vitest';
import {
	DIAL_ARC_COLORS,
	dialArcColor,
	dialFraction,
	dialKey,
	drawCounterDial,
	type DialFace
} from '../counter-dial';

describe('counter dial', () => {
	it('has an arc only with a usable max, clamped to 0…1', () => {
		expect(dialFraction(5, undefined)).toBeNull();
		expect(dialFraction(5, 0)).toBeNull();
		expect(dialFraction(5, 10)).toBe(0.5);
		expect(dialFraction(-3, 10)).toBe(0);
		expect(dialFraction(14, 10)).toBe(1);
	});

	it('measures the arc over the real range: empty at min, full at max, half at the midpoint', () => {
		expect(dialFraction(3, 17, 3)).toBe(0);
		expect(dialFraction(17, 17, 3)).toBe(1);
		expect(dialFraction(10, 17, 3)).toBe(0.5);
		// outside the range it clamps rather than overdrawing
		expect(dialFraction(1, 17, 3)).toBe(0);
		expect(dialFraction(20, 17, 3)).toBe(1);
		// a range that crosses zero, and one that never reaches it
		expect(dialFraction(0, 5, -5)).toBe(0.5);
		expect(dialFraction(-15, -10, -20)).toBe(0.5);
		// an omitted minimum is 0 — the fraction every counter had before
		expect(dialFraction(5, 10, undefined)).toBe(dialFraction(5, 10));
		// a range with no width has nothing to draw an arc over
		expect(dialFraction(4, 4, 4)).toBeNull();
		expect(dialFraction(4, 3, 4)).toBeNull();
	});

	/**
	 * The rim arc `drawCounterDial` strokes, as a fraction of a full turn — 0
	 * when it strokes none. The plate discs are filled, never stroked, so the
	 * one stroked `arc` is the fill arc.
	 */
	function strokedTurn(face: DialFace): number {
		let pending: number | null = null;
		let turn = 0;
		const context = {
			clearRect() {},
			beginPath() {
				pending = null;
			},
			arc(_x: number, _y: number, _r: number, start: number, end: number) {
				pending = (end - start) / (Math.PI * 2);
			},
			fill() {},
			stroke() {
				if (pending != null) turn = pending;
			},
			strokeText() {},
			fillText() {},
			measureText: () => ({ width: 0 })
		};
		drawCounterDial(context as unknown as CanvasRenderingContext2D, 256, face);
		return turn;
	}

	it('draws an empty arc at min, a full one at max and half at the midpoint', () => {
		const dial = { name: 'Dial', minValue: 3, maxValue: 17 };
		expect(strokedTurn({ ...dial, value: 3 })).toBe(0);
		expect(strokedTurn({ ...dial, value: 17 })).toBeCloseTo(1);
		expect(strokedTurn({ ...dial, value: 10 })).toBeCloseTo(0.5);
		// without a minimum the same value fills value/max, as it always did
		expect(strokedTurn({ name: 'Dial', maxValue: 17, value: 3 })).toBeCloseTo(3 / 17);
	});

	it('shifts colour at half and at a quarter', () => {
		expect(dialArcColor(1)).toBe(DIAL_ARC_COLORS.high);
		expect(dialArcColor(0.51)).toBe(DIAL_ARC_COLORS.high);
		expect(dialArcColor(0.5)).toBe(DIAL_ARC_COLORS.mid);
		expect(dialArcColor(0.26)).toBe(DIAL_ARC_COLORS.mid);
		expect(dialArcColor(0.25)).toBe(DIAL_ARC_COLORS.low);
		expect(dialArcColor(0)).toBe(DIAL_ARC_COLORS.low);
	});

	it('keys the redraw on name, value, range and the image underlay only', () => {
		const base = dialKey({ name: 'Health', value: 5, maxValue: 17 });
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17 })).toBe(base);
		expect(dialKey({ name: 'Health', value: 4, maxValue: 17 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5, maxValue: 18 })).not.toBe(base);
		expect(dialKey({ name: 'Energy', value: 5, maxValue: 17 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17, overImage: true })).not.toBe(base);
		// the minimum moves the arc, so it redraws — but an explicit 0 is the default
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17, minValue: 3 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17, minValue: 0 })).toBe(base);
	});
});
