/**
 * A token's outline (tableplace-254). The hit-test half of this file raycasts
 * the very geometry Piece.svelte draws — `squareBodyArgs` / `discBodyArgs` are
 * its `args` — because picking on the table IS a three.js raycast against the
 * body mesh: a corner that the box covers and the cylinder does not is a
 * corner that grabs one and misses the other.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Mesh, Raycaster, Vector3 } from 'three';
import {
	discBodyArgs,
	footprintContains,
	squareBodyArgs,
	squareTokenSize,
	tokenFootprint,
	tokenShape
} from '../token-shape';
import { PIECE_DEFAULT_RADIUS, PIECE_THICKNESS } from '$lib/utils/constants-pieces';

const RADIUS = 1;
// inside the square's corner, outside the inscribed circle: |offset| ≈ 1.2
const CORNER = { x: 0.85, z: 0.85 };

describe('tokenShape', () => {
	it('is a disc unless a token says square', () => {
		expect(tokenShape({ kind: 'token' })).toBe('disc');
		expect(tokenShape({ kind: 'token', shape: 'disc' })).toBe('disc');
		expect(tokenShape({ kind: 'token', shape: 'square' })).toBe('square');
		expect(tokenShape(undefined)).toBe('disc');
	});

	it('ignores shape on every kind that has a body of its own', () => {
		for (const kind of ['pawn', 'counter', 'die', 'bag', 'model'] as const) {
			expect(tokenShape({ kind, shape: 'square' })).toBe('disc');
		}
	});
});

describe('squareTokenSize', () => {
	it('keeps radius as the half-width and lets the depth follow the image', () => {
		expect(squareTokenSize(1)).toEqual({ w: 2, d: 2 });
		expect(squareTokenSize(1, 2)).toEqual({ w: 2, d: 1 }); // a wide image
		expect(squareTokenSize(1, 0.5)).toEqual({ w: 2, d: 4 }); // a tall one
	});

	it('falls back to a square for an aspect that is not a real one', () => {
		for (const bad of [0, -1, NaN, Infinity])
			expect(squareTokenSize(1, bad)).toEqual({ w: 2, d: 2 });
	});
});

describe('tokenFootprint', () => {
	it('is a circle for a disc and the rectangle for a square', () => {
		expect(tokenFootprint({ kind: 'token', radius: 1.25 })).toEqual({ shape: 'circle', r: 1.25 });
		expect(tokenFootprint({ kind: 'token', shape: 'square', radius: 1.25 })).toEqual({
			shape: 'rect',
			w: 2.5,
			h: 2.5
		});
		expect(tokenFootprint({ kind: 'token', shape: 'square', radius: 1 }, 2)).toEqual({
			shape: 'rect',
			w: 2,
			h: 1
		});
	});

	it('uses the default radius when the piece declares none', () => {
		expect(tokenFootprint({ kind: 'token' })).toEqual({ shape: 'circle', r: PIECE_DEFAULT_RADIUS });
		expect(tokenFootprint({ kind: 'token', shape: 'square' })).toMatchObject({
			w: PIECE_DEFAULT_RADIUS * 2
		});
	});
});

describe('footprintContains', () => {
	const square = tokenFootprint({ kind: 'token', shape: 'square', radius: RADIUS });
	const disc = tokenFootprint({ kind: 'token', radius: RADIUS });

	it('a square holds its corner; a disc of the same radius does not', () => {
		expect(footprintContains(square, CORNER.x, CORNER.z)).toBe(true);
		expect(footprintContains(disc, CORNER.x, CORNER.z)).toBe(false);
		// both hold their centre, and neither reaches past its edge
		expect(footprintContains(square, 0, 0)).toBe(true);
		expect(footprintContains(disc, 0, 0)).toBe(true);
		expect(footprintContains(square, 1.05, 0)).toBe(false);
		expect(footprintContains(disc, 1.05, 0)).toBe(false);
	});

	it('two square tiles side by side do not overlap where a circle round each would', () => {
		// tile B sits one full width to the right of tile A: they touch, no more.
		// A point just inside B's near corner is B's alone…
		const point = { x: 1.05, z: 0.9 };
		expect(footprintContains(square, point.x, point.z)).toBe(false); // from A's centre
		expect(footprintContains(square, point.x - 2, point.z)).toBe(true); // from B's
		// …where the circle that circumscribes a tile (r·√2) would claim it for both
		const circumscribed = { shape: 'circle', r: RADIUS * Math.SQRT2 } as const;
		expect(footprintContains(circumscribed, point.x, point.z)).toBe(true);
		expect(footprintContains(circumscribed, point.x - 2, point.z)).toBe(true);
	});

	it('turns with the token', () => {
		// at 45° a corner points along +x: reachable there, not on the diagonal
		expect(footprintContains(square, 1.3, 0, 45)).toBe(true);
		expect(footprintContains(square, 1.3, 0, 0)).toBe(false);
		expect(footprintContains(square, CORNER.x, CORNER.z, 45)).toBe(false);
	});

	it('follows a rectangle the way Piece.svelte draws it', () => {
		// 2 wide (x) by 1 deep (z); a quarter turn swaps the axes
		const wide = tokenFootprint({ kind: 'token', shape: 'square', radius: 1 }, 2);
		expect(footprintContains(wide, 0.9, 0)).toBe(true);
		expect(footprintContains(wide, 0, 0.9)).toBe(false);
		expect(footprintContains(wide, 0.9, 0, 90)).toBe(false);
		expect(footprintContains(wide, 0, 0.9, 90)).toBe(true);
	});
});

describe('pointer hit-test against the body mesh', () => {
	/** a pointer ray straight down onto the table at (x, z) — what a click is */
	function picks(mesh: Mesh, x: number, z: number): boolean {
		mesh.updateMatrixWorld(true);
		const ray = new Raycaster(new Vector3(x, 10, z), new Vector3(0, -1, 0));
		return ray.intersectObject(mesh).length > 0;
	}
	const squareBody = () => {
		const { w, d } = squareTokenSize(RADIUS);
		return new Mesh(new BoxGeometry(...squareBodyArgs(w, d)));
	};
	const discBody = () => new Mesh(new CylinderGeometry(...discBodyArgs(RADIUS)));

	it("a click in a square token's corner picks it; the same offset on a disc does not", () => {
		expect(picks(squareBody(), CORNER.x, CORNER.z)).toBe(true);
		expect(picks(discBody(), CORNER.x, CORNER.z)).toBe(false);
	});

	it('both are picked at the centre, and neither past the edge', () => {
		expect(picks(squareBody(), 0, 0)).toBe(true);
		expect(picks(discBody(), 0, 0)).toBe(true);
		expect(picks(squareBody(), 1.05, 1.05)).toBe(false);
		expect(picks(discBody(), 1.05, 0)).toBe(false);
	});

	it('the mesh and the pure footprint agree, corner to corner', () => {
		const body = squareBody();
		const footprint = tokenFootprint({ kind: 'token', shape: 'square', radius: RADIUS });
		for (const [x, z] of [
			[0.95, 0.95],
			[-0.95, 0.95],
			[0.95, -0.95],
			[-0.95, -0.95],
			[1.05, 0],
			[0, -1.05]
		]) {
			expect(picks(body, x, z)).toBe(footprintContains(footprint, x, z));
		}
	});

	it('is as thick as a disc', () => {
		expect(squareBodyArgs(2, 2)[1]).toBe(PIECE_THICKNESS);
		expect(discBodyArgs(1)[2]).toBe(PIECE_THICKNESS);
	});
});
