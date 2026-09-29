import { describe, expect, it } from 'vitest';
import { DIAL_ARC_COLORS, dialArcColor, dialFraction, dialKey } from '../counter-dial';

describe('counter dial', () => {
	it('has an arc only with a usable max, clamped to 0…1', () => {
		expect(dialFraction(5, undefined)).toBeNull();
		expect(dialFraction(5, 0)).toBeNull();
		expect(dialFraction(5, 10)).toBe(0.5);
		expect(dialFraction(-3, 10)).toBe(0);
		expect(dialFraction(14, 10)).toBe(1);
	});

	it('shifts colour at half and at a quarter', () => {
		expect(dialArcColor(1)).toBe(DIAL_ARC_COLORS.high);
		expect(dialArcColor(0.51)).toBe(DIAL_ARC_COLORS.high);
		expect(dialArcColor(0.5)).toBe(DIAL_ARC_COLORS.mid);
		expect(dialArcColor(0.26)).toBe(DIAL_ARC_COLORS.mid);
		expect(dialArcColor(0.25)).toBe(DIAL_ARC_COLORS.low);
		expect(dialArcColor(0)).toBe(DIAL_ARC_COLORS.low);
	});

	it('keys the redraw on name, value, max and the image underlay only', () => {
		const base = dialKey({ name: 'Health', value: 5, maxValue: 17 });
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17 })).toBe(base);
		expect(dialKey({ name: 'Health', value: 4, maxValue: 17 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5, maxValue: 18 })).not.toBe(base);
		expect(dialKey({ name: 'Energy', value: 5, maxValue: 17 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5 })).not.toBe(base);
		expect(dialKey({ name: 'Health', value: 5, maxValue: 17, overImage: true })).not.toBe(base);
	});
});
