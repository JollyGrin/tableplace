/**
 * Pure piece construction: the half of `addPiece` that decides what a piece
 * *is*, with no store behind it.
 *
 * Two callers, one implementation. `store/game/actions/piece.ts` is the
 * browser one — it resolves the acting owner, picks a fan-out spawn position
 * and hands over the piece ids already on the table. `compose/pack.ts` is the
 * headless one, assembling the same inputs from a scenario instead of a live
 * store. That is what lets a table laid out from a terminal be the same table
 * a browser would have laid out.
 *
 * Relative imports throughout (not `$lib`): this module is compiled by bun
 * scripts that run without the SvelteKit path aliases — see `packs/types.ts`.
 */

import { COUNTER_MAX_DEFAULT, DIE_SIDES_DEFAULT, PIECE_RADIUS } from '../utils/constants-pieces';
import type {
	BagDrawMode,
	BagItem,
	DieSides,
	PackOrigin,
	PieceDTO,
	PieceKind,
	PieceStateDTO,
	TokenShape
} from '../store/game/types';

export type Vec3 = [number, number, number];

const KIND_LABEL: Record<PieceKind, string> = {
	token: 'Token',
	pawn: 'Pawn',
	counter: 'Counter',
	die: 'Die',
	bag: 'Bag',
	model: 'Model'
};

export function slugify(name: string, fallback: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || fallback;
}

/**
 * The state index a piece is actually showing: clamped into its `states`
 * array, and 0 for a piece that has none. Shared by the renderer and the
 * cycle/select verbs so they can never disagree about what is on the table.
 */
export function currentPieceState(
	piece: { states?: PieceStateDTO[]; state?: number } | null | undefined
): number {
	const count = piece?.states?.length ?? 0;
	if (count === 0) return 0;
	return Math.min(Math.max(Math.trunc(piece?.state ?? 0), 0), count - 1);
}

/**
 * ids are `kind:owner:slug` (claimSeat renames the owner segment) — `-n`
 * disambiguates repeats. `taken` is every piece id already on the table, so
 * two pieces of the same name never collide.
 */
export function nextPieceId(taken: ReadonlySet<string>, ownerId: string, slug: string): string {
	let n = 0;
	while (taken.has(`piece:${ownerId}:${slug}-${n}`)) n++;
	return `piece:${ownerId}:${slug}-${n}`;
}

/** Everything a piece *is* — minus who owns it and where it goes. */
export type PieceProps = {
	name?: string;
	/** hex tint; pawns/counters/dice without images render in this color */
	color?: string;
	/** resolved like card faces — a plain https:// url works */
	imageUrl?: string;
	/** multi-state pieces: every face, `states[0]` being the base one */
	states?: PieceStateDTO[];
	/** which of `states` to spawn showing (default 0) */
	state?: number;
	radius?: number;
	/** tokens only; `'square'` draws a tile instead of a disc */
	shape?: TokenShape;
	/** counters only; the piece spawns full (`value = maxValue`) unless `value` says otherwise */
	maxValue?: number;
	/** counters only; the lowest value it can show (default 0) */
	minValue?: number;
	/** counters only; restores a saved count (scenario loads) instead of spawning full */
	value?: number;
	/** dice only; how many faces (defaults to a d6) */
	sides?: DieSides;
	/** models only; the `model:<kit>/<name>` catalog ref the renderer resolves */
	model?: string;
	rotation?: Vec3;
	/** false opts this piece out of snap points/grids (default true) */
	snap?: boolean;
	/** how many snap-point links it usually travels — advisory reach rings */
	reach?: number;
	/** pinned in place (tableplace-189) */
	locked?: boolean;
	/** bags only; the hidden pool a draw pulls from */
	contents?: BagItem[];
	/** bags only; defaults to 'random' */
	drawMode?: BagDrawMode;
	/** bags only; a draw clones instead of removing */
	infinite?: boolean;
	/** set when the piece comes from a pack, so a v2 scenario can reference it */
	packOrigin?: PackOrigin;
};

export type ComposePieceOptions = PieceProps & {
	ownerId: string;
	/**
	 * Where it lands. Required: the fan-out default a hand-spawn uses is a
	 * function of how full the owner's edge of the table already is, which is a
	 * store question — the caller answers it.
	 */
	position: Vec3;
	/** piece ids already on the table, so a repeated name gets the next `-n` */
	taken?: ReadonlySet<string>;
};

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Shape a piece and its id. Pure — nothing is committed anywhere; the caller
 * decides whether that means a store patch or a websocket frame.
 */
export function composePiece(
	kind: PieceKind,
	opts: ComposePieceOptions
): { id: string; piece: Partial<PieceDTO> } {
	const sides = opts.sides ?? DIE_SIDES_DEFAULT;
	// dice name themselves after their shape: `d20`, not `Die` — the shape is
	// the only thing that distinguishes one from another at a glance
	const name = opts.name?.trim() || (kind === 'die' ? `d${sides}` : KIND_LABEL[kind]);
	const id = nextPieceId(opts.taken ?? NO_IDS, opts.ownerId, slugify(name, kind));

	const piece: Partial<PieceDTO> = {
		kind,
		name,
		position: opts.position,
		rotation: opts.rotation ?? [0, 0, 0],
		radius: opts.radius ?? PIECE_RADIUS[kind]
	};
	if (opts.color) piece.color = opts.color;
	if (opts.imageUrl) piece.imageUrl = opts.imageUrl;
	// only a square token carries it: absent already means a disc, and no other
	// kind has an outline to choose
	if (kind === 'token' && opts.shape === 'square') piece.shape = 'square';
	// the ref, not the geometry: what a model piece IS travels as one string
	if (kind === 'model' && opts.model) piece.model = opts.model;
	// Not on a die or a bag: a die's faces are geometry and a bag's is a pouch,
	// so states would be dead weight on the wire and would hand either a state
	// menu it has no use for. Dropped here rather than rejected at parse time so
	// a pack that carries them anyway still imports — it just spawns plain.
	if (kind !== 'die' && kind !== 'bag' && opts.states?.length) {
		piece.states = opts.states.map((s) => ({ face: s.face, ...(s.name ? { name: s.name } : {}) }));
		piece.state = currentPieceState({ states: opts.states, state: opts.state });
	}
	if (opts.packOrigin) piece.packOrigin = opts.packOrigin;
	// only the opt-out is worth carrying: absent already means "snaps"
	if (opts.snap === false) piece.snap = false;
	if (opts.reach !== undefined) piece.reach = opts.reach;
	// only a pinned piece carries it: absent already means "unlocked"
	if (opts.locked) piece.locked = true;
	if (kind === 'counter') {
		const maxValue = opts.maxValue ?? COUNTER_MAX_DEFAULT;
		piece.maxValue = maxValue;
		// only a declared floor is carried: absent already means 0
		if (opts.minValue !== undefined) piece.minValue = opts.minValue;
		piece.value = opts.value ?? maxValue;
	}
	if (kind === 'die') {
		piece.sides = sides;
		piece.value = opts.value ?? 1;
		// a fresh die has never been rolled, so nothing animates on spawn
		piece.rollSeq = 0;
	}
	if (kind === 'bag') {
		// always written, even empty: a bag with no `contents` key would leave
		// nothing for a return-to-bag patch to merge into
		piece.contents = opts.contents ?? [];
		piece.drawMode = opts.drawMode ?? 'random';
		if (opts.infinite) piece.infinite = true;
	}
	return { id, piece };
}
