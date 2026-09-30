/**
 * tbps — the table.place scenario file format. See docs/packs.md.
 *
 * A scenario file is a saved table arrangement (`Scenario`) plus an in-band
 * discriminator. Files are named `<name>.tbps.json`.
 *
 * - **v2** references packs (`packs` + `placements`) instead of inlining their
 *   content: a scenario says *which* content and *where it goes*, the pack says
 *   *what it is*. `state` stays for anything not pack-derived.
 * - **v1** is a self-contained `Partial<GameDTO>` snapshot.
 * - **v0** is the legacy `scenario-<name>.json` export (no `tbps` field).
 *
 * All three load; only v2 is written for pack-derived tables.
 */

import type { GameDTO } from '../store/game/types';
import { assertReadableSpecVersion, SCENARIO_SPEC_VERSION } from '../formats/spec-version';
import { validRotationStep } from '../utils/yaw';
import { validHandPlayFace } from '../utils/hand';
import { validCoach } from '../coach/table';
import { withoutHolds } from '../utils/hold';
import { counterRange, counterValueRefusal } from '../primitives/counter-range';
import { TOKEN_SHAPES } from '../primitives/token-shape';

export const TBPS_VERSION = 2;
/** versions this app can read */
export const TBPS_SUPPORTED = [1, 2] as const;
export const SCENARIO_SCHEMA_URL = 'https://table.place/scenario.schema.json';

export type SeatIndex = 0 | 1 | 2 | 3;

/** Enough to re-resolve a pack's content at load time. */
export type PackRef = {
	/** pack id, e.g. 'standard-52' */
	id: string;
	/**
	 * `'builtin'` (shipped with the app), `'local'` (this browser's pack
	 * library) or a URL a `.tbpp.json` can be fetched from. Omitted refs are
	 * looked up in the builtin registry, then the local library.
	 */
	source?: string;
};

/**
 * Where one piece of pack content goes. `content` is the deck `slot` (decks)
 * or the array index (pieces/overlays) within the referenced pack — the
 * `<pack>/<slot>` half of the `<pack>/<slot>/<code>` addressing in docs/packs.md.
 */
export type PackPlacement = {
	kind: 'deck' | 'piece' | 'overlay';
	/** `PackRef.id` this content comes from */
	pack: string;
	content: string;
	/** placeholder seat that owns the spawned entity; omitted for table-scoped overlays */
	seat?: SeatIndex;
	position?: [number, number, number];
	rotation?: [number, number, number];
	/** decks only */
	isFaceUp?: boolean;
	/**
	 * decks only — the authored card order as pack card `code`s. A scenario is a
	 * saved arrangement, so a stacked deck round-trips exactly. Ids only, never
	 * card bodies: referencing the pack is the whole point of v2.
	 */
	order?: string[];
	/**
	 * decks only — reshuffle on load instead of restoring `order`. Per placement,
	 * so one scenario can hold a fixed encounter deck and a shuffled draw deck.
	 */
	shuffleOnLoad?: boolean;
	/**
	 * decks only — lay the deck's cards down as loose cards instead of a pile:
	 * what placing the pile and pressing `Shift+G` on it leaves, with no pile
	 * ever on the table. The cards stack at the placement's XZ, the pile's top
	 * card on top, and `isFaceUp`, `rotation`, `order`, `shuffleOnLoad` and
	 * `locked` apply to each card. How a single reference card arrives as a card
	 * rather than a one-card pile. Refused on a piece or overlay, and for a deck
	 * of more than 40 cards (`UNGROUP_MAX_CARDS`, the `Shift+G` limit). Omitted
	 * or `false`: a pile.
	 */
	loose?: boolean;
	/**
	 * counter pieces only — the count it starts on. Must sit inside the pack
	 * piece's `[minValue, maxValue]`; a value outside it is refused when the
	 * placement meets its pack (the file alone does not know the range).
	 */
	value?: number;
	/**
	 * piece placements only — which of the pack piece's `states` it starts on
	 * (index into `PackPieceDef.states`, default 0). Distinct from the
	 * scenario's top-level `state` snapshot: this is one piece's face.
	 */
	state?: number;
	/** overlays only */
	scale?: number;
	/**
	 * Place it pinned (tableplace-189): it can't be dragged, flipped, turned or
	 * grouped until someone presses `L` on it. Any kind — how a layout lays a
	 * board down locked. `false` unpins content the pack itself marks locked;
	 * omitted keeps the pack's own default.
	 */
	locked?: boolean;
};

/**
 * An authored placement guide: a spot on the felt that a dropped card or piece
 * finishes exactly on. Scenario-level and table-space — a snap point belongs
 * to the board, not to a seat, so it is not mirrored per seat the way pack
 * piece positions are.
 *
 * Deliberately shaped like TTS's save-level `SnapPoints` (position + optional
 * rotation) so importing those stays a mechanical mapping.
 */
export type SnapPoint = {
	/**
	 * Table-space `[x, z]`. Stays two elements — elevation is the separate
	 * optional `y`, so every 0.1.x reader keeps parsing the tuple it expects.
	 */
	position: [number, number];
	/**
	 * Elevation: the local floor whatever lands here rests on, replacing the
	 * table top in the rest-height arithmetic. Omitted means the felt. A card
	 * dropped on a card on an elevated point still stacks.
	 */
	y?: number;
	/**
	 * Yaw a caught drop turns to, in **degrees**. Omitted leaves the entity's
	 * own rotation alone. Degrees, not the radians `placements` use, because
	 * this is a single table yaw and it maps 1:1 onto both the card DTO's tap
	 * rotation and TTS's snap-point rotation. On a grid this is the lattice's
	 * yaw instead; the landing's own yaw steps by `yawStep`.
	 */
	rotation?: number;
	/** catch radius in world units; omitted means the app default (0.9) */
	radius?: number;
	/**
	 * `'grid'` turns this entry into a lattice of square cells (`pitch`,
	 * `cols`, `rows` required): a drop anywhere over the grid pulls to the
	 * nearest cell centre. Omitted (or `'point'`) is the discrete spot it
	 * always was.
	 */
	kind?: 'point' | 'grid';
	/** grid only — cell size in world units */
	pitch?: number;
	/** grid only — extent in cells; `position` is the grid's centre */
	cols?: number;
	/** grid only — extent in cells */
	rows?: number;
	/** grid only — degrees a landing's yaw rounds to, from the grid's own yaw (default 90) */
	yawStep?: number;
	/**
	 * Connected snap points, by id — an optional board graph. A point's id is
	 * `snap:<its index in this array>` (`snap:0` is the first), the same id it
	 * gets in state. Undirected: a link written on either end joins both. A
	 * link to an index that doesn't exist is ignored. Only read to light the
	 * points a lifted piece with `reach` can get to — nothing is ever blocked.
	 */
	links?: string[];
	/**
	 * One-way links: ids (`snap:<index>`, as in `links`) of the points this one
	 * leads to. The edge leaves this point only — the target doesn't reach back
	 * through it — so a directed route is written on its starting end. A pair
	 * that is also joined by `links` is two-way. Advisory, like `links`.
	 */
	outLinks?: string[];
	/** free-form labels (regions, sides, anything) the table itself never reads */
	tags?: string[];
};

export type Scenario = {
	name: string;
	createdAt: number;
	/** overrides + anything not pack-derived (ad-hoc pieces, hand-placed cards) */
	state: Partial<GameDTO>;
	/** v2: packs this scenario draws content from */
	packs?: PackRef[];
	/** v2: where that content goes */
	placements?: PackPlacement[];
	/**
	 * Placement guides for whatever ends up on the table, pack-derived or not —
	 * and the only place a file should author them. Additive: a scenario without
	 * them behaves exactly as it did before they existed, and they don't decide
	 * the file version (a hand-placed table with snap points is still v1).
	 */
	snapPoints?: SnapPoint[];
	/**
	 * How far Q and E turn a card, deck or piece on this table, in degrees:
	 * greater than 0, at most 360. Omitted means 45. T and R on a card stay 90°
	 * taps. Seeded into the lobby's synced `state.table`, so every player turns
	 * by the same step (tableplace-200).
	 *
	 * @exclusiveMinimum 0
	 * @maximum 360
	 */
	rotationStep?: number;
	/**
	 * Which face a card dragged out of a hand lands on by default: `"down"`
	 * (the default when omitted) or `"up"`, for games that play cards face up.
	 * Holding Shift at release plays the other face. Seeded into the lobby's
	 * synced `state.table`, like `rotationStep` (tableplace-195).
	 */
	handPlayFace?: 'down' | 'up';
	/**
	 * `false` hides the first-run "things to try" checklist on this table, for
	 * players who already know it. Omitted (or `true`) shows it to anyone who
	 * has not dismissed it in their own browser. Seeded into the lobby's synced
	 * `state.table`, like `rotationStep` (tableplace-206).
	 */
	coach?: boolean;
};

/** The on-disk shape of a `.tbps.json` file. */
export type ScenarioFile = Scenario & {
	/** format discriminator + version */
	tbps: 1 | 2;
	/** optional editor-validation hint; always written on export */
	$schema?: string;
	/**
	 * Semver of the scenario spec this document was authored against. Always
	 * written on export; optional on read so files predating spec versioning
	 * still validate and still import. 0.x — see `SCENARIO_SPEC_VERSION`.
	 */
	specVersion?: string;
};

/** v2 iff it references packs — a hand-placed table still exports as v1. */
export function scenarioVersion(scenario: Scenario): 1 | 2 {
	return scenario.packs?.length || scenario.placements?.length ? 2 : 1;
}

export function scenarioFileName(name: string): string {
	return `${name}.tbps.json`;
}

/** Serialize a scenario for download as `<name>.tbps.json`. */
export function serializeScenarioFile(scenario: Scenario): string {
	const { packs, placements, ...fields } = scenario;
	// a hold is a pointer on a live table: no file carries one (tableplace-199)
	const rest = { ...fields, state: withoutHolds(fields.state ?? {}) };
	const version = scenarioVersion(scenario);
	const file: ScenarioFile =
		version === 2
			? {
					$schema: SCENARIO_SCHEMA_URL,
					tbps: 2,
					specVersion: SCENARIO_SPEC_VERSION,
					...rest,
					packs: packs ?? [],
					placements: placements ?? []
				}
			: { $schema: SCENARIO_SCHEMA_URL, tbps: 1, specVersion: SCENARIO_SPEC_VERSION, ...rest };
	return JSON.stringify(file, null, '\t');
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
	throw new Error(message);
}

function vec3(v: unknown, path: string): [number, number, number] {
	if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number')) {
		fail(`${path} must be [x, y, z]`);
	}
	return v as [number, number, number];
}

function parsePackRef(v: unknown, path: string): PackRef {
	if (!isRecord(v)) fail(`${path} must be an object`);
	if (typeof v.id !== 'string' || v.id === '') fail(`${path}.id must be a non-empty string`);
	const ref: PackRef = { id: v.id };
	if (v.source !== undefined) {
		if (typeof v.source !== 'string' || v.source === '') {
			fail(`${path}.source must be 'builtin', 'local' or a URL`);
		}
		ref.source = v.source;
	}
	return ref;
}

const PLACEMENT_KINDS = ['deck', 'piece', 'overlay'] as const;

function parsePlacement(v: unknown, path: string): PackPlacement {
	if (!isRecord(v)) fail(`${path} must be an object`);
	const kind = v.kind as PackPlacement['kind'];
	if (!PLACEMENT_KINDS.includes(kind)) {
		fail(`${path}.kind must be one of ${PLACEMENT_KINDS.join(', ')}`);
	}
	if (typeof v.pack !== 'string' || v.pack === '') fail(`${path}.pack must be a non-empty string`);
	if (typeof v.content !== 'string' || v.content === '') {
		fail(`${path}.content must be a non-empty string`);
	}
	const placement: PackPlacement = { kind, pack: v.pack, content: v.content };
	if (v.seat !== undefined) {
		if (typeof v.seat !== 'number' || ![0, 1, 2, 3].includes(v.seat)) {
			fail(`${path}.seat must be 0, 1, 2 or 3`);
		}
		placement.seat = v.seat as SeatIndex;
	}
	if (v.position !== undefined) placement.position = vec3(v.position, `${path}.position`);
	if (v.rotation !== undefined) placement.rotation = vec3(v.rotation, `${path}.rotation`);
	if (v.isFaceUp !== undefined) placement.isFaceUp = Boolean(v.isFaceUp);
	if (v.order !== undefined) {
		if (!Array.isArray(v.order) || v.order.some((c) => typeof c !== 'string')) {
			fail(`${path}.order must be an array of card codes`);
		}
		placement.order = v.order as string[];
	}
	if (v.shuffleOnLoad !== undefined) placement.shuffleOnLoad = Boolean(v.shuffleOnLoad);
	if (v.loose !== undefined) {
		if (typeof v.loose !== 'boolean') fail(`${path}.loose must be true or false`);
		if (v.loose && kind !== 'deck') {
			fail(
				`${path}.loose is for deck placements only — ${kind === 'overlay' ? 'an' : 'a'} ${kind} can't be placed loose`
			);
		}
		// `false` on a piece or overlay says nothing, so it is not kept
		if (kind === 'deck') placement.loose = v.loose;
	}
	if (v.value !== undefined) {
		if (typeof v.value !== 'number') fail(`${path}.value must be a number`);
		placement.value = v.value;
	}
	if (v.state !== undefined) {
		if (typeof v.state !== 'number' || !Number.isInteger(v.state) || v.state < 0) {
			fail(`${path}.state must be a state index (a non-negative integer)`);
		}
		placement.state = v.state;
	}
	if (v.scale !== undefined) {
		if (typeof v.scale !== 'number') fail(`${path}.scale must be a number`);
		placement.scale = v.scale;
	}
	if (v.locked !== undefined) placement.locked = Boolean(v.locked);
	return placement;
}

function parseSnapPoint(v: unknown, path: string): SnapPoint {
	if (!isRecord(v)) fail(`${path} must be an object`);
	const position = v.position;
	if (
		!Array.isArray(position) ||
		position.length !== 2 ||
		position.some((n) => typeof n !== 'number' || !Number.isFinite(n))
	) {
		fail(`${path}.position must be [x, z] in table space`);
	}
	const point: SnapPoint = { position: position as [number, number] };
	if (v.y !== undefined) {
		if (typeof v.y !== 'number' || !Number.isFinite(v.y)) {
			fail(`${path}.y must be an elevation in world units`);
		}
		point.y = v.y;
	}
	if (v.rotation !== undefined) {
		if (typeof v.rotation !== 'number' || !Number.isFinite(v.rotation)) {
			fail(`${path}.rotation must be a yaw in degrees`);
		}
		point.rotation = v.rotation;
	}
	if (v.radius !== undefined) {
		if (typeof v.radius !== 'number' || !Number.isFinite(v.radius) || v.radius <= 0) {
			fail(`${path}.radius must be a positive number of world units`);
		}
		point.radius = v.radius;
	}
	if (v.kind !== undefined && v.kind !== 'point' && v.kind !== 'grid') {
		fail(`${path}.kind must be 'point' or 'grid'`);
	}
	if (v.kind === 'grid') {
		point.kind = 'grid';
		if (typeof v.pitch !== 'number' || !Number.isFinite(v.pitch) || v.pitch <= 0) {
			fail(`${path}.pitch must be a positive cell size in world units`);
		}
		point.pitch = v.pitch;
		for (const field of ['cols', 'rows'] as const) {
			const cells = v[field];
			if (typeof cells !== 'number' || !Number.isInteger(cells) || cells < 1) {
				fail(`${path}.${field} must be a positive whole number of cells`);
			}
			point[field] = cells;
		}
		if (v.yawStep !== undefined) {
			if (typeof v.yawStep !== 'number' || !Number.isFinite(v.yawStep) || v.yawStep <= 0) {
				fail(`${path}.yawStep must be a positive number of degrees`);
			}
			point.yawStep = v.yawStep;
		}
	}
	for (const field of ['links', 'outLinks', 'tags'] as const) {
		const list = v[field];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
			fail(`${path}.${field} must be an array of strings`);
		}
		if (list.length) point[field] = [...(list as string[])];
	}
	return point;
}

/**
 * A snapshot counter carries its own range, so the file can be held to it:
 * a `value` outside `[minValue, maxValue]` is refused here, naming both
 * bounds. (A placement's `value` is checked where its pack piece is known —
 * `composePackPiece`.) Only whole counters are checked: a partial override
 * that names no `kind` inherits its range from the placement it lays over.
 */
function assertCounterValues(state: Partial<GameDTO>) {
	for (const [id, piece] of Object.entries(state.pieces ?? {})) {
		if (piece?.kind !== 'counter' || typeof piece.value !== 'number') continue;
		const refusal = counterValueRefusal(piece.value, counterRange(piece));
		if (refusal) fail(`state.pieces[${JSON.stringify(id)}].value ${refusal}`);
	}
}

/**
 * A snapshot piece's `shape` is one of the token shapes or absent — a typo
 * would otherwise load as a silent disc.
 */
function assertTokenShapes(state: Partial<GameDTO>) {
	const known: readonly unknown[] = TOKEN_SHAPES;
	const check = (shape: unknown, path: string) => {
		if (shape !== undefined && !known.includes(shape)) {
			fail(`${path}.shape must be one of ${TOKEN_SHAPES.join(', ')}`);
		}
	};
	for (const [id, piece] of Object.entries(state.pieces ?? {})) {
		const path = `state.pieces[${JSON.stringify(id)}]`;
		check(piece?.shape, path);
		(piece?.contents ?? []).forEach((item, i) => {
			if (item?.kind !== 'card') check(item?.shape, `${path}.contents[${i}]`);
		});
	}
}

/**
 * Parse + validate a scenario file. Accepts v2 (pack-referencing), v1
 * (self-contained snapshot) and, as a v0 fallback, the legacy
 * `scenario-<name>.json` shape (no `tbps` field) so existing exports keep
 * importing. Throws a human-readable Error.
 */
export function parseScenarioFile(text: string): Scenario {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('Not valid JSON');
	}
	if (!isRecord(raw)) {
		throw new Error('Not a scenario file: expected a JSON object');
	}
	const obj = raw;
	if (obj.tbps !== undefined && !TBPS_SUPPORTED.includes(obj.tbps as 1 | 2)) {
		throw new Error(
			`Unsupported scenario version ${JSON.stringify(obj.tbps)} — this app reads tbps ${TBPS_SUPPORTED.join(' and ')}`
		);
	}
	// validate against what the DOCUMENT declares, not against our own version
	assertReadableSpecVersion(obj.specVersion, SCENARIO_SPEC_VERSION, 'scenario');
	if (typeof obj.name !== 'string' || obj.name === '') {
		throw new Error('Not a scenario file: `name` must be a non-empty string');
	}
	// v2 may carry no ad-hoc state at all; v0/v1 always have a snapshot
	const hasPacks = obj.packs !== undefined || obj.placements !== undefined;
	if (obj.state !== undefined ? !isRecord(obj.state) : !hasPacks) {
		throw new Error('Not a scenario file: `state` must be an object');
	}

	const scenario: Scenario = {
		name: obj.name,
		createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
		// a stray hold (tableplace-199) is live-table state, never a file's
		state: withoutHolds((obj.state ?? {}) as Partial<GameDTO>)
	};
	assertCounterValues(scenario.state);
	assertTokenShapes(scenario.state);
	if (obj.packs !== undefined) {
		if (!Array.isArray(obj.packs)) throw new Error('`packs` must be an array');
		scenario.packs = obj.packs.map((p, i) => parsePackRef(p, `packs[${i}]`));
	}
	if (obj.placements !== undefined) {
		if (!Array.isArray(obj.placements)) throw new Error('`placements` must be an array');
		scenario.placements = obj.placements.map((p, i) => parsePlacement(p, `placements[${i}]`));
	}
	// additive and version-gated by absence: a file without `snapPoints` parses
	// to a scenario without the key, byte-identical to how it always did
	if (obj.snapPoints !== undefined) {
		if (!Array.isArray(obj.snapPoints)) throw new Error('`snapPoints` must be an array');
		scenario.snapPoints = obj.snapPoints.map((p, i) => parseSnapPoint(p, `snapPoints[${i}]`));
	}
	if (obj.rotationStep !== undefined) {
		const step = validRotationStep(obj.rotationStep);
		if (step === undefined) {
			throw new Error(
				`\`rotationStep\` must be a number of degrees above 0 and at most 360, got ${JSON.stringify(obj.rotationStep)}`
			);
		}
		scenario.rotationStep = step;
	}
	if (obj.handPlayFace !== undefined) {
		const face = validHandPlayFace(obj.handPlayFace);
		if (face === undefined) {
			throw new Error(
				`\`handPlayFace\` must be "down" or "up", got ${JSON.stringify(obj.handPlayFace)}`
			);
		}
		scenario.handPlayFace = face;
	}
	if (obj.coach !== undefined) {
		const coach = validCoach(obj.coach);
		if (coach === undefined) {
			throw new Error(`\`coach\` must be true or false, got ${JSON.stringify(obj.coach)}`);
		}
		scenario.coach = coach;
	}
	return scenario;
}
