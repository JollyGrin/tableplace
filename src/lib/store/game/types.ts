/**
 * Cards on the Table
 * */
export type CardDTO = {
	position: [number, number, number];
	rotation: [number, number, number];
	faceImageUrl: string;
	backImageUrl?: string;
	/**
	 * Display name (pack `PackCardDef.name`, TTS `Nickname`). Shown as the
	 * zoomed preview's caption, and only while the card is face up to the
	 * viewer — a face-down card never reveals it. Absent = no caption.
	 */
	name?: string;
	/**
	 * Default resting orientation (pack `PackCardDef.orientation`). Landscape
	 * cards render turned 90° in every renderer, while `rotation` stays
	 * orientation-relative — `tapCard` is additive on `rotation[2]` and the
	 * snap/group logic assumes a squared-up yaw is `z % 180 == 0`, so the
	 * quarter turn must never be baked into the persisted rotation. Its own
	 * field (not part of `rotation`) so it survives the `CardInDeck` hop,
	 * which strips `rotation`. Absent = 'portrait'.
	 */
	orientation?: 'portrait' | 'landscape';
	/**
	 * Pinned in place (tableplace-189, TTS `Locked`): it can't be dragged,
	 * flipped, turned or grouped, only previewed — and `L` unpins it. Absent
	 * means unlocked.
	 */
	locked?: boolean;
	/**
	 * Player id of whoever laid this card face-down out of their hand
	 * (tableplace-193). For that player alone the zoomed preview shows the face
	 * — a peek. A display rule only: the face is in synced state for everyone,
	 * this just decides what the UI draws. Cleared when the card is flipped
	 * face up or goes into a hand; a pile never carries it. Absent = nobody
	 * may peek.
	 */
	placedBy?: string;
	/**
	 * Where this card sits in its holder's hand, left to right (tableplace-195):
	 * a sort key, lowest first, so a reorder is one patch of numbers and the
	 * order survives a reload (the relay does not keep object key order).
	 * Only meaningful inside `players[id].tray`; a card leaving the hand drops
	 * it. Absent sorts after every numbered card.
	 */
	handOrder?: number;
	/**
	 * Player id of whoever is carrying this card right now (tableplace-199).
	 * Written in the same patch as the first carried position and cleared
	 * (`null`) by the patch that lands it, so it costs no message of its own.
	 * Everyone else draws the holder's colour around it and refuses a second
	 * grab. A hold by a player whose `connected` is false reads as released.
	 * Live-table state only: never saved into a scenario, stripped on load.
	 * Absent = nobody holds it.
	 */
	heldBy?: string;
};

/**
 * a card in a pile has no place of its own to be pinned to, and nobody's peek
 * survives the shuffle into one
 */
export type CardInDeck = Omit<
	CardDTO,
	'position' | 'rotation' | 'locked' | 'placedBy' | 'handOrder' | 'heldBy'
> & {
	id: string;
};

/**
 * Provenance stamped on pack-spawned entities so a scenario export (tbps v2)
 * can reference the pack instead of inlining its content. Wire-safe: the
 * relay server merges state schema-agnostically.
 */
export type PackOrigin = {
	/** pack id, e.g. 'standard-52' */
	pack: string;
	/** content id within the pack: deck slot, or piece/overlay index */
	content: string;
	/** where the pack re-resolves from: 'builtin' or a fetchable URL */
	source?: string;
};

export type DeckDTO = {
	/**
	 * id format
	 * deck:playername:id
	 * */
	id: string;
	deckBackImageUrl?: string;
	/**
	 * true if the deck is face up (like discard pile)
	 * */
	isFaceUp?: boolean;
	position: [number, number, number];
	rotation: [number, number, number];
	/**
	 * Cards in deck are an array instead of record
	 * */
	cards: CardInDeck[];
	packOrigin?: PackOrigin;
	/** scenario authoring intent (tbps v2): reshuffle this deck on scenario load */
	shuffleOnLoad?: boolean;
	/**
	 * wall-clock ms of the last shuffle. Its only job is to CHANGE in the same
	 * patch as the reordered cards — the reorder alone is invisible from the
	 * back, the changed timestamp is what remote clients turn into the wiggle.
	 */
	shuffledAt?: number;
	/**
	 * Pinned in place (tableplace-189): the pile can't be moved, flipped or
	 * ungrouped. Cards still come off its top — a locked draw pile is still a
	 * draw pile.
	 */
	locked?: boolean;
	/** player id of whoever is carrying the pile right now — see `CardDTO.heldBy` */
	heldBy?: string;
};

interface SeatState {
	seat:
		| 0 // 0deg
		| 1 // 180deg
		| 2 // 90deg
		| 3; // 270deg
}

export type PlayerDTO = SeatState & {
	id: string;
	joinTimestamp: number;
	tray: Record<string, Partial<CardDTO | null>>;
	/**
	 * server-owned presence: merged into the lobby state on socket
	 * connect/disconnect. Absent until the server has said anything —
	 * treat undefined as offline-unknown, never as connected.
	 * */
	connected?: boolean;
	/**
	 * extend for future use with life/resources
	 * */
	metadata: any;
};

/**
 * Non-card table objects (tokens, pawns, counters, dice). One generic shape
 * with a kind discriminator — see SPEC.md §4a.
 */
export type PieceKind = 'token' | 'pawn' | 'counter' | 'die' | 'bag' | 'model';

/** Face count of a die piece — the shapes the primitive library can build. */
export type DieSides = 4 | 6 | 8 | 10 | 12 | 20;

/** Order a bag hands its contents out in (TTS analog: the container's Order). */
export type BagDrawMode = 'random' | 'lifo' | 'fifo';

/** A piece waiting inside a bag — no position: the draw decides where it lands. */
export type BagPieceItem = {
	kind: 'token' | 'pawn' | 'counter';
	name: string;
	color?: string;
	imageUrl?: string;
	radius?: number;
	maxValue?: number;
};

/** A card waiting inside a bag; `code` becomes part of the drawn card's id. */
export type BagCardItem = {
	kind: 'card';
	code: string;
	name?: string;
	face: string;
	back?: string;
	/** default resting orientation of the drawn card; absent = 'portrait' */
	orientation?: 'portrait' | 'landscape';
};

export type BagItem = BagPieceItem | BagCardItem;

/** One alternate face of a multi-state piece — see `PackPieceStateDef`. */
export type PieceStateDTO = {
	/** face ref, resolved like a card face */
	face: string;
	name?: string;
};

export type PieceDTO = {
	position: [number, number, number];
	rotation: [number, number, number];
	kind: PieceKind;
	name: string;
	/** hex tint; pawns/counters without images render in this color */
	color?: string;
	/** token top-face image ref (resolved like card faces) */
	imageUrl?: string;
	/**
	 * Faces this piece can be cycled through, `states[0]` being the base face.
	 * Carried on the entity (not looked up from the pack) so a client that
	 * never loaded the pack still renders whatever state the table is in.
	 */
	states?: PieceStateDTO[];
	/** index into `states`; absent = 0. Synced like every other mutation. */
	state?: number;
	/** world radius of the piece footprint */
	radius?: number;
	/**
	 * `kind: 'model'` only — a `model:<kit>/<name>` catalog ref (tableplace-135),
	 * resolved through the static manifest exactly the way face refs resolve
	 * through their schemes: the tiny ref string is all that syncs, never
	 * geometry. An unresolvable ref renders as a placeholder, not an error.
	 */
	model?: string;
	/** counter state — also the up-face of a die (1…sides) */
	value?: number;
	maxValue?: number;
	/** dice only: how many faces the die has */
	sides?: DieSides;
	/**
	 * dice only: bumped once per roll. The roll itself is sent as
	 * `{value, rollSeq}` in one patch — never a stream of frames — and every
	 * client plays the tumble locally when this number changes, settling on
	 * `value`. It is therefore both the animation trigger and the dedupe
	 * nonce: a client that has never seen this die seeds its last-seen seq on
	 * first sync, so joining after a roll shows the settled face with no replay.
	 */
	rollSeq?: number;
	/**
	 * bags only — the hidden pool a draw pulls from, in insertion order (lifo
	 * takes the last entry, fifo the first). Lives in synced state so a draw
	 * resolves once, on the acting client, and every client agrees on the result.
	 * No UI ever renders it.
	 */
	contents?: BagItem[];
	/** bags only — draw order; treated as `'random'` when absent */
	drawMode?: BagDrawMode;
	/** bags only — draws clone instead of removing (TTS Infinite_Bag) */
	infinite?: boolean;
	/**
	 * Whether snap points (and grids) pull this piece's drops. Absent means
	 * `true`; `false` is the per-piece opt-out — the drop resolves as if Alt
	 * were held, for snap resolution only (aimed-at targets like bags are
	 * unaffected). A big room section snaps to the grid; a loose prop doesn't.
	 */
	snap?: boolean;
	/**
	 * How many snap-point links this piece usually travels (tableplace-190).
	 * Advisory only: lifted from a linked snap point, the points within `reach`
	 * links glow brighter than the rest. Nothing is ever blocked. Absent means
	 * no reach rings.
	 */
	reach?: number;
	/**
	 * Pinned in place (tableplace-189): it can't be dragged or turned. What it
	 * does in place still works — a locked counter counts, a locked die rolls,
	 * a locked bag hands things out. Absent means unlocked.
	 */
	locked?: boolean;
	/** player id of whoever is carrying the piece right now — see `CardDTO.heldBy` */
	heldBy?: string;
	packOrigin?: PackOrigin;
};

export type OverlayDTO = {
	id: string;
	position: [number, number, number];
	rotation: [number, number, number];
	imageUrl: string;
	/**
	 * ratio of width/height
	 * */
	ratio: number;
	scale: number;
	/**
	 * Pinned in place (tableplace-189). Overlays can't be picked up in play
	 * today, so this records authoring intent a board keeps across exports
	 * and imports (TTS `Locked`).
	 */
	locked?: boolean;
	packOrigin?: PackOrigin;
};

/**
 * An authored placement guide on the felt: a card or piece released inside
 * `radius` of one finishes exactly on it. Table-scoped like overlays — snap
 * points belong to the board, not to a seat — and inert: nothing renders them
 * in /play, they only steer where a drop lands (see `utils/transforms/snap`).
 */
export type SnapPointDTO = {
	id: string;
	/**
	 * Table-space `[x, z]`. Stays a 2-tuple on purpose — its arity is asserted
	 * in four independent places (this type, `xz()` in transforms/snap,
	 * `parseSnapPoint`, the generated schema), so elevation is the separate
	 * optional `y` beside it rather than a breaking third element.
	 */
	position: [number, number];
	/**
	 * Elevation: redefines the local floor for whatever lands on this point.
	 * The landing's rest height is computed exactly as on the felt, with `y`
	 * substituted for the table top — so a card dropped on a card on an
	 * elevated point still stacks. Omitted means the table top.
	 */
	y?: number;
	/**
	 * Yaw the landing snaps to, in **degrees**, or omitted to keep whatever
	 * rotation the entity already had. Degrees to match the card DTO's tap
	 * rotation (`actions/card.ts`) and TTS's `SnapPoints`. On a grid this is
	 * the lattice's yaw instead, and the landing's yaw steps by `yawStep`.
	 */
	rotation?: number;
	/** catch radius in world units; omitted means `SNAP_RADIUS_DEFAULT` */
	radius?: number;
	/**
	 * `'grid'` makes this one entry a whole lattice of square cells: a drop
	 * anywhere over the grid pulls to the nearest cell centre. Absent (or
	 * `'point'`) is the discrete spot it always was — fully backward
	 * compatible, and no sibling collection to teach a dozen call sites about.
	 */
	kind?: 'point' | 'grid';
	/** grid only — cell size in world units */
	pitch?: number;
	/** grid only — extent in cells; `position` is the grid's centre */
	cols?: number;
	/** grid only — extent in cells */
	rows?: number;
	/**
	 * grid only — degrees; a snapped entity's yaw rounds to the nearest
	 * multiple, measured from the grid's own `rotation`. Default 90 (the
	 * modular-kit case).
	 */
	yawStep?: number;
	/**
	 * Ids of the snap points this one connects to — an optional board graph
	 * (tableplace-190). A link is undirected: authored on either end, it joins
	 * both. A target that doesn't exist is ignored. Inert unless a lifted piece
	 * carries `reach`.
	 */
	links?: string[];
	/** free-form labels a scenario can group points by; the table reads none of them */
	tags?: string[];
};

/**
 * Table-wide settings a scenario lays down (tableplace-200). Synced like any
 * entity, so a player who joins after the scenario was seeded turns things by
 * the same step as everyone else.
 */
export type TableSettingsDTO = {
	/**
	 * How far Q and E turn a card, deck or piece, in degrees — any value in
	 * (0, 360]. Absent means `ROTATION_STEP_DEFAULT` (45). T and R on a card
	 * stay 90° taps whatever this says.
	 */
	rotationStep?: number;
	/**
	 * How a card dragged out of a hand lands when no modifier is held
	 * (tableplace-195): `'down'` (absent) or `'up'`. Holding Shift at release
	 * plays the other face.
	 */
	handPlayFace?: HandPlayFace;
	/**
	 * `false` hides the first-run "things to try" strip on this table
	 * (tableplace-206) — for a table whose players already know it. Absent
	 * (or `true`) shows it to anyone who has not dismissed it in their browser.
	 */
	coach?: boolean;
};

/** which face a card played out of a hand lands on */
export type HandPlayFace = 'down' | 'up';

// index signatures (not Record<…>) so the generated JSON Schema keeps the
// entity value shapes — typescript-json-schema drops Record value types
export interface GameDTO {
	cards: { [cardId: string]: Partial<CardDTO> };
	decks: { [deckId: string]: Partial<DeckDTO> };
	players: { [playerId: string]: Partial<PlayerDTO> };
	/** null = remove */
	overlays?: { [overlayId: string]: Partial<OverlayDTO> | null };
	/** null = remove */
	pieces?: { [pieceId: string]: Partial<PieceDTO> | null };
	/** authored placement guides, keyed `snap:<n>`. null = remove */
	snapPoints?: { [snapId: string]: Partial<SnapPointDTO> | null };
	/** table-wide settings (`rotationStep`, `handPlayFace`, `coach`); a field set to null is removed */
	table?: TableSettingsDTO;
}
