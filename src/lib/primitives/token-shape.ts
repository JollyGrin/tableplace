import type { PieceDTO, TokenShape } from '../store/game/types';
import { PIECE_DEFAULT_RADIUS, PIECE_THICKNESS } from '../utils/constants-pieces';

/**
 * The outline of a token (tableplace-254): a `disc`, or a `square` tile that
 * keeps the corners of its art.
 *
 * Everything that has to agree on a token's outline reads it from here — the
 * body mesh the raycaster picks, the face the image is printed on, the drop
 * footprint, the selection and held-by rings, the zoomed preview — so a square
 * tile is square in all of them or in none.
 */

/** Exported so validators and llms-txt.ts can list the values instead of hand-writing them. */
export const TOKEN_SHAPES = ['disc', 'square'] as const;

/** Segments round a disc token's rim */
export const TOKEN_DISC_SEGMENTS = 36;

/**
 * The shape a piece draws as. Only a token is ever square: a counter's dial,
 * a pawn, a die, a bag and a model each have a body of their own, so a stray
 * `shape` on one of them changes nothing.
 */
export function tokenShape(
	piece: Pick<Partial<PieceDTO>, 'kind' | 'shape'> | undefined | null
): TokenShape {
	return (piece?.kind ?? 'token') === 'token' && piece?.shape === 'square' ? 'square' : 'disc';
}

/**
 * Table-plane size of a square token: `radius` is its half-WIDTH, always, and
 * its depth follows the image so the art is never cropped or stretched —
 * `aspect` is the image's width / height, 1 until it has loaded (and for a
 * token with no image at all).
 */
export function squareTokenSize(radius: number, aspect = 1): { w: number; d: number } {
	const w = radius * 2;
	return { w, d: aspect > 0 && Number.isFinite(aspect) ? w / aspect : w };
}

/** The outline a token covers on the table, in its own (unturned) frame. */
export type TokenFootprint =
	| { shape: 'rect'; w: number; h: number }
	| { shape: 'circle'; r: number };

export function tokenFootprint(
	piece: Pick<Partial<PieceDTO>, 'kind' | 'shape' | 'radius'> | undefined | null,
	aspect = 1
): TokenFootprint {
	const radius = piece?.radius ?? PIECE_DEFAULT_RADIUS;
	if (tokenShape(piece) !== 'square') return { shape: 'circle', r: radius };
	const { w, d } = squareTokenSize(radius, aspect);
	return { shape: 'rect', w, h: d };
}

/**
 * Is the table point (`dx`, `dz`) — measured from the token's centre — inside
 * its footprint? `yawDeg` is the token's `rotation[1]`; a disc ignores it.
 */
export function footprintContains(
	footprint: TokenFootprint,
	dx: number,
	dz: number,
	yawDeg = 0
): boolean {
	if (footprint.shape === 'circle') return Math.hypot(dx, dz) <= footprint.r;
	// into the token's own frame: undo the turn Piece.svelte draws (-yaw about y)
	const t = (yawDeg * Math.PI) / 180;
	const lx = dx * Math.cos(t) + dz * Math.sin(t);
	const lz = -dx * Math.sin(t) + dz * Math.cos(t);
	return Math.abs(lx) <= footprint.w / 2 && Math.abs(lz) <= footprint.h / 2;
}

/**
 * Constructor args of the token's body geometry — `BoxGeometry` for a square,
 * `CylinderGeometry` for a disc. One source for the mesh Piece.svelte draws
 * and for the hit-test unit test, which raycasts exactly these.
 */
export function squareBodyArgs(w: number, d: number): [number, number, number] {
	return [w, PIECE_THICKNESS, d];
}

export function discBodyArgs(radius: number): [number, number, number, number] {
	return [radius, radius, PIECE_THICKNESS, TOKEN_DISC_SEGMENTS];
}
