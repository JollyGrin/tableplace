import { describe, it, expect } from 'vitest';
import { applySnapRotation, compareSnapIds, resolveSnap, snapRadius } from '../snap';
import { SNAP_RADIUS_DEFAULT, SNAP_RADIUS_MAX, SNAP_RADIUS_MIN } from '$lib/utils/constants-snap';
import { yawDegrees } from '$lib/utils/yaw';
import type { GameDTO, SnapPointDTO } from '$lib/store/game/types';

const points = (
	...entries: [string, Partial<Omit<SnapPointDTO, 'id'>> | null][]
): GameDTO['snapPoints'] => Object.fromEntries(entries);

describe('snapRadius', () => {
	it('falls back to the shared default', () => {
		expect(snapRadius({})).toBe(SNAP_RADIUS_DEFAULT);
		expect(snapRadius(undefined)).toBe(SNAP_RADIUS_DEFAULT);
	});

	it('honours an authored radius', () => {
		expect(snapRadius({ radius: 2.5 })).toBe(2.5);
	});

	it('clamps values that could never catch a drop, or would catch everything', () => {
		expect(snapRadius({ radius: 0 })).toBe(SNAP_RADIUS_MIN);
		expect(snapRadius({ radius: -3 })).toBe(SNAP_RADIUS_MIN);
		expect(snapRadius({ radius: 9999 })).toBe(SNAP_RADIUS_MAX);
	});

	it('ignores a non-finite radius', () => {
		expect(snapRadius({ radius: Number.NaN })).toBe(SNAP_RADIUS_DEFAULT);
	});
});

describe('resolveSnap', () => {
	it('catches a drop inside the radius', () => {
		const snap = resolveSnap(points(['snap:0', { position: [4, 2], radius: 1 }]), 4.5, 2);
		expect(snap).toMatchObject({ id: 'snap:0', x: 4, z: 2, radius: 1 });
		expect(snap?.distance).toBeCloseTo(0.5);
	});

	it('ignores a drop outside the radius', () => {
		expect(resolveSnap(points(['snap:0', { position: [4, 2], radius: 1 }]), 5.5, 2)).toBeNull();
	});

	it('catches a drop exactly on the radius', () => {
		expect(resolveSnap(points(['snap:0', { position: [0, 0], radius: 1 }]), 1, 0)).toMatchObject({
			id: 'snap:0'
		});
	});

	it('uses the default radius when the point omits one', () => {
		const p = points(['snap:0', { position: [0, 0] }]);
		expect(resolveSnap(p, SNAP_RADIUS_DEFAULT - 0.01, 0)).toMatchObject({ id: 'snap:0' });
		expect(resolveSnap(p, SNAP_RADIUS_DEFAULT + 0.01, 0)).toBeNull();
	});

	it('lets the nearest point win when radii overlap', () => {
		const p = points(
			['snap:0', { position: [0, 0], radius: 3 }],
			['snap:1', { position: [2, 0], radius: 3 }]
		);
		expect(resolveSnap(p, 1.4, 0)?.id).toBe('snap:1');
		expect(resolveSnap(p, 0.6, 0)?.id).toBe('snap:0');
	});

	it('breaks an exact tie on id, so record order cannot decide a snap', () => {
		const near = { position: [0, 0] as [number, number], radius: 2 };
		const far = { position: [2, 0] as [number, number], radius: 2 };
		const forward = resolveSnap(points(['snap:0', near], ['snap:1', far]), 1, 0);
		const reversed = resolveSnap(points(['snap:1', far], ['snap:0', near]), 1, 0);
		expect(forward?.id).toBe('snap:0');
		expect(reversed?.id).toBe('snap:0');
	});

	it('carries the authored rotation, and reports none when there is none', () => {
		expect(
			resolveSnap(points(['snap:0', { position: [0, 0], rotation: 90 }]), 0, 0)?.rotation
		).toBe(90);
		expect(resolveSnap(points(['snap:0', { position: [0, 0] }]), 0, 0)?.rotation).toBeUndefined();
	});

	it('keeps a rotation of 0, which is an authored facing and not "unset"', () => {
		expect(resolveSnap(points(['snap:0', { position: [0, 0], rotation: 0 }]), 0, 0)?.rotation).toBe(
			0
		);
	});

	it('skips deleted and malformed entries', () => {
		const p = points(
			['snap:0', null],
			// @ts-expect-error deliberately malformed: a wire patch can carry anything
			['snap:1', { position: ['x', 2] }],
			['snap:2', { position: [0, 0] }]
		);
		expect(resolveSnap(p, 0, 0)?.id).toBe('snap:2');
	});

	it('is unfazed by no snap points at all', () => {
		expect(resolveSnap(undefined, 0, 0)).toBeNull();
		expect(resolveSnap({}, 0, 0)).toBeNull();
	});

	it('breaks ties in numeric id order, not lexicographic — snap:2 before snap:10', () => {
		// 'snap:10' < 'snap:2' as strings; the pane sorts numerically, and the
		// resolver must agree with the pane about which point "comes first"
		const near = { position: [0, 0] as [number, number], radius: 2 };
		const far = { position: [2, 0] as [number, number], radius: 2 };
		expect(resolveSnap(points(['snap:10', far], ['snap:2', near]), 1, 0)?.id).toBe('snap:2');
	});

	it('carries an authored elevation onto the resolution', () => {
		expect(resolveSnap(points(['snap:0', { position: [0, 0], y: 2 }]), 0, 0)?.y).toBe(2);
		expect(resolveSnap(points(['snap:0', { position: [0, 0] }]), 0, 0)?.y).toBeUndefined();
	});

	describe('grids', () => {
		const grid = (over: Partial<Omit<SnapPointDTO, 'id'>> = {}) =>
			points(['snap:0', { position: [10, 4], kind: 'grid', pitch: 2, cols: 3, rows: 3, ...over }]);

		it('pulls a drop to the nearest cell centre', () => {
			// cells at x ∈ {8, 10, 12}, z ∈ {2, 4, 6}
			const snap = resolveSnap(grid(), 8.6, 5.3);
			expect(snap).toMatchObject({ id: 'snap:0', x: 8, z: 6 });
			expect(snap?.grid).toEqual({ pitch: 2, rotation: 0 });
		});

		it('catches anywhere over the extent, and nowhere outside it', () => {
			// extent is cols·pitch × rows·pitch = 6×6 around [10, 4]
			expect(resolveSnap(grid(), 12.9, 6.9)).toMatchObject({ x: 12, z: 6 });
			expect(resolveSnap(grid(), 13.1, 4)).toBeNull();
			expect(resolveSnap(grid(), 10, 7.1)).toBeNull();
		});

		it('is not clamped by SNAP_RADIUS_MAX — a grid deliberately covers area', () => {
			const huge = grid({ pitch: 4, cols: 12, rows: 6 }); // 48×24, most of the felt
			expect((12 * 4) / 2).toBeGreaterThan(SNAP_RADIUS_MAX);
			expect(resolveSnap(huge, 10 + 23, 4 + 11)).toMatchObject({ x: 10 + 22, z: 4 + 10 });
		});

		it('steps the entity yaw to the nearest multiple of 90 by default', () => {
			expect(resolveSnap(grid(), 10, 4, 0)?.rotation).toBe(0);
			expect(resolveSnap(grid(), 10, 4, 50)?.rotation).toBe(90);
			expect(resolveSnap(grid(), 10, 4, 130)?.rotation).toBe(90);
			expect(resolveSnap(grid(), 10, 4, -50)?.rotation).toBe(-90);
		});

		it('steps by an authored yawStep, measured from the grid own yaw', () => {
			expect(resolveSnap(grid({ yawStep: 45 }), 10, 4, 30)?.rotation).toBe(45);
			// lattice turned 30°: steps land on 30 + k·90
			expect(resolveSnap(grid({ rotation: 30 }), 10, 4, 100)?.rotation).toBe(120);
		});

		it('turns the lattice with the grid rotation', () => {
			// 90°: local cols direction (u) maps onto world +x → with the grid
			// yawed, a drop offset along world +z resolves to a neighbouring cell
			const turned = grid({ rotation: 90, cols: 3, rows: 1 });
			// rows = 1 leaves only the u axis; u = dx·cos90 + dz·sin90 = dz
			expect(resolveSnap(turned, 10, 6, 0)).toMatchObject({ x: 10, z: 6 });
			expect(resolveSnap(turned, 12, 4, 0)).toBeNull(); // off the turned extent
		});

		it('carries the grid elevation onto the cell', () => {
			expect(resolveSnap(grid({ y: 1.5 }), 10, 4)?.y).toBe(1.5);
		});

		it('loses to an authored discrete point at equal distance', () => {
			// the drop sits exactly between a cell centre and a discrete point
			const both = points(
				['snap:0', { position: [10, 4], kind: 'grid', pitch: 2, cols: 3, rows: 3 }],
				['snap:1', { position: [11, 4], radius: 1 }]
			);
			// at x=10.5 both candidates are 0.5 away — authored intent wins
			expect(resolveSnap(both, 10.5, 4)?.id).toBe('snap:1');
			// nearer the cell, distance decides as usual
			expect(resolveSnap(both, 10.2, 4)?.id).toBe('snap:0');
		});

		it('skips a malformed grid rather than snapping to garbage', () => {
			expect(resolveSnap(grid({ pitch: 0 }), 10, 4)).toBeNull();
			expect(resolveSnap(grid({ cols: 0 }), 10, 4)).toBeNull();
			expect(resolveSnap(grid({ rows: 2.5 }), 10, 4)).toBeNull();
		});
	});
});

describe('compareSnapIds', () => {
	it('orders by the numeric suffix', () => {
		expect(['snap:10', 'snap:2', 'snap:0'].sort(compareSnapIds)).toEqual([
			'snap:0',
			'snap:2',
			'snap:10'
		]);
	});
});

describe('applySnapRotation', () => {
	it('leaves the rotation alone when the point authored none', () => {
		expect(applySnapRotation([180, 0, 45], undefined, 'card')).toEqual([180, 0, 45]);
		expect(applySnapRotation([0, 30, 0], undefined, 'piece')).toEqual([0, 30, 0]);
		expect(applySnapRotation([0, Math.PI, 0], undefined, 'deck')).toEqual([0, Math.PI, 0]);
	});

	it('writes a card yaw into z as degrees, preserving the facedown flip', () => {
		expect(applySnapRotation([180, 0, 45], 90, 'card')).toEqual([180, 0, 90]);
	});

	it('writes a piece yaw into y as degrees', () => {
		expect(applySnapRotation([0, 30, 0], 90, 'piece')).toEqual([0, 90, 0]);
	});

	it('writes a deck yaw into y as RADIANS — decks are the odd one out', () => {
		// Deck.svelte hands the triple to its <T.Group>; degrees here would spin
		// a snapped deck by a factor of 57 (tableplace-88 makes decks draggable)
		const [x, y, z] = applySnapRotation([0, 0, 0], 180, 'deck');
		expect([x, z]).toEqual([0, 0]);
		expect(y).toBeCloseTo(Math.PI);
	});

	it('turns a deck the other way round in storage, so it turns the same way on screen', () => {
		// a card's and a piece's degrees render negated (clockwise from above);
		// a deck's radians render as stored (counter-clockwise), so the same
		// authored 90° is -π/2 there — wrapped into one turn, like every turn
		const [x, y, z] = applySnapRotation([0, Math.PI, 0], 90, 'deck');
		expect([x, z]).toEqual([0, 0]);
		expect(y).toBeCloseTo((3 * Math.PI) / 2);
		// and the three agree once read back as a clockwise table yaw
		expect(yawDegrees('deck', [x, y, z])).toBe(90);
		expect(yawDegrees('card', applySnapRotation([0, 0, 0], 90, 'card'))).toBe(90);
		expect(yawDegrees('piece', applySnapRotation([0, 0, 0], 90, 'piece'))).toBe(90);
	});

	it('writes an unturned deck as exactly 0, never -0', () => {
		expect(Object.is(applySnapRotation([0, Math.PI, 0], 0, 'deck')[1], 0)).toBe(true);
	});
});
