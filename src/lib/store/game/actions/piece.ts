import { get } from 'svelte/store';
import { gameActions } from '.';
import { gameStore } from '../gameStore.svelte';
import { degrees } from '$lib/utils/constants-rotation';
import { DIE_SIDES_DEFAULT, PIECE_REST_Y } from '$lib/utils/constants-pieces';
import {
	composePiece,
	currentPieceState,
	nextPieceId as nextFreePieceId,
	slugify,
	type PieceProps
} from '$lib/compose/piece';
import type { GameDTO, PieceKind } from '../types';

// re-exported so `slugify` keeps its historical home here (bag.ts imports it)
export { slugify };

export type PieceState = NonNullable<NonNullable<GameDTO['pieces']>[string]>;

function getPieceState(pieceId: string) {
	return get(gameStore)?.pieces?.[pieceId];
}

function removePiece(pieceId: string) {
	return gameStore.updateState({ pieces: { [pieceId]: null } });
}

function movePiece(pieceId: string, position: [number, number, number]) {
	return gameStore.updateState({ pieces: { [pieceId]: { position } } });
}

/**
 * Turn a piece on the table by `delta` degrees of yaw — the piece analog of
 * `tapCard`, added for model sections (R/T on a hovered model, and the model
 * menu's Rotate entries) but valid for any piece: yaw is `rotation[1]` in
 * degrees (see applySnapRotation), normalized into [0, 360) so the synced
 * number never grows without bound.
 */
function rotatePiece(pieceId: string, delta: number) {
	const piece = getPieceState(pieceId);
	if (!piece) return;
	const [x = 0, yaw = 0, z = 0] = piece.rotation ?? [];
	const next = (((yaw + delta) % 360) + 360) % 360;
	return gameStore.updateState({ pieces: { [pieceId]: { rotation: [x, next, z] } } });
}

/** Adjust a counter piece's value, clamped to [0, maxValue] */
function incrementCounter(pieceId: string, delta: number) {
	const piece = getPieceState(pieceId);
	if (!piece || piece.kind !== 'counter') return;
	const max = piece.maxValue ?? 99;
	const value = Math.min(max, Math.max(0, (piece.value ?? max) + delta));
	return gameStore.updateState({ pieces: { [pieceId]: { value } } });
}

/**
 * Show one of a multi-state piece's faces. Out-of-range indexes wrap, so
 * `setPieceState(id, current + 1)` is the cycle verb and a menu can pass an
 * absolute index. No-op on a piece with fewer than two states.
 *
 * Refuses a die outright, the mirror of `rollDie` refusing everything else: a
 * die shows a face because of how it is lying, so an index would be a second,
 * disagreeing answer to the same question. A bag is refused for the same
 * reason — its face is a pouch, and what it shows is a count, not an index.
 * `addPiece` already keeps `states` off both, but state can also arrive over
 * the wire from another client.
 */
function setPieceState(pieceId: string, index: number) {
	const piece = getPieceState(pieceId);
	if (piece?.kind === 'die' || piece?.kind === 'bag') return;
	const count = piece?.states?.length ?? 0;
	if (count < 2) return;
	const wrapped = ((Math.trunc(index) % count) + count) % count;
	if (wrapped === currentPieceState(piece)) return;
	return gameStore.updateState({ pieces: { [pieceId]: { state: wrapped } } });
}

/**
 * The per-piece snap opt-out: `false` makes this piece's drops resolve as if
 * Alt were held (snap points and grids only — aimed-at targets like bags are
 * unaffected). Absent means "snaps", so turning it back on deletes the field
 * (`null` at that path) rather than shipping a redundant `true` on the wire.
 */
function setPieceSnap(pieceId: string, snap: boolean) {
	return gameStore.updateState({
		pieces: { [pieceId]: { snap: snap ? null : false } }
	} as Parameters<typeof gameStore.updateState>[0]);
}

/**
 * How many snap-point links a piece usually travels — advisory reach rings
 * (tableplace-190). 0 or less deletes the field: no reach, no bright set.
 */
function setPieceReach(pieceId: string, reach: number) {
	const whole = Math.round(reach);
	return gameStore.updateState({
		pieces: { [pieceId]: { reach: whole > 0 ? whole : null } }
	} as Parameters<typeof gameStore.updateState>[0]);
}

/** Step a multi-state piece to its next (or previous) face. Never a die or bag. */
function cyclePieceState(pieceId: string, delta = 1) {
	const piece = getPieceState(pieceId);
	if (piece?.kind === 'die' || piece?.kind === 'bag') return;
	if ((piece?.states?.length ?? 0) < 2) return;
	return setPieceState(pieceId, currentPieceState(piece) + delta);
}

/**
 * Roll a die: pick the result here, then broadcast it — the animation is
 * replayed from `rollSeq`, never streamed.
 *
 * One patch per roll, and a non-position patch at that, so it leaves
 * immediately and unthrottled (see storeIntegration). Streaming the tumble
 * instead would put us over the server's 7 msg/s sustained limit
 * (server/lobby/lobby.go) and get the roller disconnected mid-roll.
 *
 * Every client — the roller included — reacts to `rollSeq` changing by playing
 * the same tumble locally and settling on `value`, so what everyone watches is
 * one agreed outcome rather than a race.
 *
 * Rolling is a die verb the way cycling is a stateful-piece verb: each refuses
 * anything that is not its own kind, so the two never act on one piece.
 */
function rollDie(pieceId: string) {
	const piece = getPieceState(pieceId);
	if (!piece || piece.kind !== 'die') return;
	const sides = piece.sides ?? DIE_SIDES_DEFAULT;
	const value = 1 + Math.floor(Math.random() * sides);
	return gameStore.updateState({
		pieces: { [pieceId]: { value, rollSeq: (piece.rollSeq ?? 0) + 1 } }
	});
}

/** Spawns fan sideways in front of the acting seat, wrapping to further rows. */
const SPAWN_SPACING = 1.6;
const SPAWN_PER_ROW = 8;
const SPAWN_EDGE_Z = 4.5;

/**
 * Seat of the acting owner. The scenario editor owns entities with
 * `seat0`…`seat3` placeholders (see scenario.ts) — matched here by shape
 * rather than by import, since scenario.ts already imports these actions.
 */
function ownerSeat(ownerId: string): number {
	const placeholder = /^seat([0-3])$/.exec(ownerId);
	if (placeholder) return Number(placeholder[1]);
	return get(gameStore)?.players?.[ownerId]?.seat ?? 0;
}

/** Rotate a seat-local (x, z) offset into world space around the table center */
function seatToWorld(seat: number, x: number, z: number): [number, number] {
	const theta = degrees[seat % degrees.length];
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const round = (v: number) => Math.round(v * 1000) / 1000;
	return [round(x * cos + z * sin), round(z * cos - x * sin)];
}

function spawnPosition(seat: number, index: number): [number, number, number] {
	const column = index % SPAWN_PER_ROW;
	const row = Math.floor(index / SPAWN_PER_ROW);
	// fan out from the middle of the seat's edge: 0, -1, +1, -2, +2, …
	const offsetX = Math.ceil(column / 2) * SPAWN_SPACING * (column % 2 === 1 ? -1 : 1);
	const [x, z] = seatToWorld(seat, offsetX, SPAWN_EDGE_Z - row * SPAWN_SPACING);
	return [x, PIECE_REST_Y, z];
}

/** ids are `kind:owner:slug` (claimSeat renames the owner segment) — `-n` disambiguates repeats */
export function nextPieceId(ownerId: string, slug: string): string {
	return nextFreePieceId(new Set(Object.keys(get(gameStore)?.pieces ?? {})), ownerId, slug);
}

export type AddPieceOptions = PieceProps & {
	/** defaults to the local player; the scenario editor passes placeholder seat ids */
	ownerId?: string;
	position?: [number, number, number];
};

/**
 * Shape a piece and its id without committing them, so a caller that needs the
 * piece and something else in ONE state patch (a bag draw writes the drawn
 * item and the bag's shrunken contents together) doesn't have to broadcast two.
 * Returns null when there is no owner to spawn for.
 *
 * The piece itself is shaped by `compose/piece.ts` — everything this adds is
 * the two answers only a live table can give: who is acting, and where the
 * next spawn fans out to. That is what a headless composer supplies for itself.
 */
export function buildPiece(
	kind: PieceKind,
	opts: AddPieceOptions = {}
): { id: string; piece: Partial<PieceState> } | null {
	const ownerId = opts.ownerId || gameActions.getMyId();
	if (!ownerId) {
		console.error('Cannot add a piece without an owner id');
		return null;
	}

	const taken = new Set(Object.keys(get(gameStore)?.pieces ?? {}));
	const owned = [...taken].filter((key) => key.includes(`:${ownerId}:`)).length;
	return composePiece(kind, {
		...opts,
		ownerId,
		taken,
		position: opts.position ?? spawnPosition(ownerSeat(ownerId), owned)
	});
}

/**
 * Spawn a token / pawn / counter / bag in front of the acting seat.
 * Goes through updateState, so /play broadcasts to the lobby and /setup
 * stays local. Returns the new piece id ('' if there's no owner to spawn for).
 */
function addPiece(kind: PieceKind, opts: AddPieceOptions = {}): string {
	const built = buildPiece(kind, opts);
	if (!built) return '';
	gameStore.updateState({ pieces: { [built.id]: built.piece } });
	return built.id;
}

export const pieceActions = {
	getPieceState,
	addPiece,
	removePiece,
	movePiece,
	rotatePiece,
	incrementCounter,
	currentPieceState,
	setPieceState,
	setPieceSnap,
	setPieceReach,
	cyclePieceState,
	rollDie
};
