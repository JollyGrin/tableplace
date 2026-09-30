/**
 * Lift-time snap guides (tableplace-188): what rings, which grid cells show
 * near the pointer, how big the instance pools get, and which overlays dim.
 * The filled target is not tested here — it is `resolveDrop`'s own answer,
 * passed through — but its one shared rule, `entitySnaps`, is.
 */
import { describe, expect, it } from 'vitest';
import {
	forEachSnapGuide,
	gridRevealRadius,
	hasSnapPoints,
	overlayUnderSnapPoints,
	poolSize,
	snapGuideCapacity,
	type SnapGuideKind
} from '../snap-guides';
import { entitySnaps, resolveDrop } from '$lib/utils/transforms/drop';
import { SNAP_GUIDE_GRID_REVEAL, SNAP_RADIUS_DEFAULT } from '$lib/utils/constants-snap';
import { TABLE_TOP_Y } from '$lib/utils/constants-table';
import type { GameDTO } from '$lib/store/game/types';

type Guide = { kind: SnapGuideKind; x: number; y: number; z: number; size: number; yaw: number };

function guides(snapPoints: GameDTO['snapPoints'], pointer: { x: number; z: number } | null) {
	const out: Guide[] = [];
	forEachSnapGuide(snapPoints, pointer, (kind, x, y, z, size, yaw) =>
		out.push({ kind, x, y, z, size, yaw })
	);
	return out;
}

describe('forEachSnapGuide', () => {
	it('rings every discrete point, at its floor and catch radius, wherever the pointer is', () => {
		const out = guides(
			{
				'snap:1': { position: [1, 2] },
				'snap:2': { position: [-3, 4], radius: 2, y: 1.5 },
				'snap:3': null,
				'snap:4': { position: [Number.NaN, 0] }
			},
			{ x: 20, z: 20 }
		);
		expect(out).toEqual([
			{ kind: 'point', x: 1, y: TABLE_TOP_Y, z: 2, size: SNAP_RADIUS_DEFAULT, yaw: 0 },
			{ kind: 'point', x: -3, y: 1.5, z: 4, size: 2, yaw: 0 }
		]);
	});

	it('reveals only the grid cells near the pointer, not the lattice', () => {
		// 20×20 cells of pitch 1 centred on the origin
		const grid = {
			'snap:1': { position: [0, 0], kind: 'grid', pitch: 1, cols: 20, rows: 20 }
		} as GameDTO['snapPoints'];
		const out = guides(grid, { x: 0.5, z: 0.5 });
		expect(out.length).toBeGreaterThan(4);
		expect(out.length).toBeLessThan(400);
		for (const cell of out) {
			expect(cell.kind).toBe('cell');
			expect(Math.hypot(cell.x - 0.5, cell.z - 0.5)).toBeLessThanOrEqual(
				SNAP_GUIDE_GRID_REVEAL + 1e-9
			);
			expect(cell.size).toBe(1);
		}
		// the cell the pointer is over is among them
		expect(out.some((c) => Math.abs(c.x - 0.5) < 1e-9 && Math.abs(c.z - 0.5) < 1e-9)).toBe(true);
	});

	it('reveals no cells without a pointer, and none for a grid far away', () => {
		const grid = {
			'snap:1': { position: [0, 0], kind: 'grid', pitch: 1, cols: 3, rows: 3 }
		} as GameDTO['snapPoints'];
		expect(guides(grid, null)).toEqual([]);
		expect(guides(grid, { x: 20, z: 0 })).toEqual([]);
	});

	it('places a yawed grid’s cells where the resolver lands them', () => {
		const snapPoints = {
			'snap:1': {
				position: [2, 1],
				kind: 'grid',
				pitch: 2,
				cols: 3,
				rows: 3,
				rotation: 30,
				y: 0.9
			}
		} as GameDTO['snapPoints'];
		const state = { snapPoints, pieces: { 'piece:a': { position: [0, 0.16, 0] } } };
		for (const cell of guides(snapPoints, { x: 2, z: 1 })) {
			expect(cell.yaw).toBe(30);
			expect(cell.y).toBe(0.9);
			// a drop right on a revealed cell centre resolves onto that same centre
			const drop = resolveDrop(state as never, 'piece:a', { x: cell.x, z: cell.z });
			expect(drop?.kind).toBe('snap');
			expect(drop!.position[0]).toBeCloseTo(cell.x, 9);
			expect(drop!.position[2]).toBeCloseTo(cell.z, 9);
		}
	});

	it('keeps a coarse grid’s own cell in reach', () => {
		expect(gridRevealRadius(8)).toBe(8);
		const grid = {
			'snap:1': { position: [0, 0], kind: 'grid', pitch: 8, cols: 2, rows: 1 }
		} as GameDTO['snapPoints'];
		expect(guides(grid, { x: -4, z: 0 }).length).toBeGreaterThanOrEqual(1);
	});
});

describe('snapGuideCapacity / poolSize', () => {
	it('bounds every layout forEachSnapGuide can produce', () => {
		const snapPoints = {
			...Object.fromEntries(
				Array.from({ length: 33 }, (_, i) => [`snap:${i}`, { position: [i % 11, i / 11] }])
			),
			'snap:grid': { position: [0, 0], kind: 'grid', pitch: 0.5, cols: 40, rows: 40 },
			'snap:tiny': { position: [5, 5], kind: 'grid', pitch: 1, cols: 2, rows: 1 }
		} as GameDTO['snapPoints'];
		const cap = snapGuideCapacity(snapPoints);
		expect(cap.points).toBe(33);
		for (const pointer of [
			{ x: 0, z: 0 },
			{ x: 5, z: 5 },
			{ x: 9.7, z: -3.3 },
			{ x: 5.4, z: 4.8 }
		]) {
			const out = guides(snapPoints, pointer);
			expect(out.filter((g) => g.kind === 'point').length).toBeLessThanOrEqual(cap.points);
			expect(out.filter((g) => g.kind === 'cell').length).toBeLessThanOrEqual(cap.cells);
		}
		expect(poolSize(0)).toBe(8);
		expect(poolSize(33)).toBe(64);
	});
});

describe('hasSnapPoints', () => {
	it('ignores removed entries', () => {
		expect(hasSnapPoints(undefined)).toBe(false);
		expect(hasSnapPoints({ 'snap:1': null })).toBe(false);
		expect(hasSnapPoints({ 'snap:1': { position: [0, 0] } })).toBe(true);
	});
});

describe('overlayUnderSnapPoints', () => {
	const points = { 'snap:1': { position: [4, 0] } } as GameDTO['snapPoints'];
	it('dims only an overlay a snap point sits on', () => {
		expect(overlayUnderSnapPoints(points, [0, 0.255, 0], 0, 10, 4)).toBe(true);
		expect(overlayUnderSnapPoints(points, [0, 0.255, 0], 0, 6, 4)).toBe(false);
		expect(overlayUnderSnapPoints(undefined, [0, 0.255, 0], 0, 10, 4)).toBe(false);
	});
	it('respects the overlay’s yaw', () => {
		// a long thin overlay turned 90° runs along z, no longer under (4, 0)
		expect(overlayUnderSnapPoints(points, [0, 0.255, 0], Math.PI / 2, 10, 1)).toBe(false);
	});
});

describe('entitySnaps', () => {
	it('is what resolveDrop honours: every card and deck, a piece unless snap: false', () => {
		const state = {
			cards: { 'card:p:a': { position: [0, 0.26, 0] } },
			decks: { 'deck:p:0': { position: [0, 0.3, 0], cards: [] } },
			pieces: {
				'piece:on': { position: [0, 0.16, 0] },
				'piece:off': { position: [0, 0.16, 0], snap: false }
			},
			snapPoints: { 'snap:1': { position: [0.2, 0] } }
		} as never;
		for (const id of ['card:p:a', 'deck:p:0', 'piece:on', 'piece:off']) {
			const drop = resolveDrop(state, id, { x: 0, z: 0 });
			expect(entitySnaps(state, id)).toBe(drop?.kind === 'snap');
		}
		expect(entitySnaps(state, 'piece:off')).toBe(false);
		expect(entitySnaps(state, 'piece:missing')).toBe(false);
	});
});
