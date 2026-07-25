/**
 * Cards on the Table
 * */
export type CardDTO = {
	position: [number, number, number];
	rotation: [number, number, number];
	faceImageUrl: string;
	backImageUrl?: string;
};

export type CardInDeck = Omit<CardDTO, 'position' | 'rotation'> & { id: string };

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
 * Non-card table objects (tokens, pawns, counters). One generic shape
 * with a kind discriminator — see SPEC.md §4a.
 */
export type PieceKind = 'token' | 'pawn' | 'counter';

export type PieceDTO = {
	position: [number, number, number];
	rotation: [number, number, number];
	kind: PieceKind;
	name: string;
	/** hex tint; pawns/counters without images render in this color */
	color?: string;
	/** token top-face image ref (resolved like card faces) */
	imageUrl?: string;
	/** world radius of the piece footprint */
	radius?: number;
	/** counter state */
	value?: number;
	maxValue?: number;
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
	packOrigin?: PackOrigin;
};

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
}
