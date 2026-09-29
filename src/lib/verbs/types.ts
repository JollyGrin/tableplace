/**
 * The vocabulary of the verb registry (see `registry.ts`): what a player can
 * do to the thing under the pointer, described once and read by every surface
 * that offers it — the hotkeys on /play and /setup, the radial wheel, the
 * Keybinds folder, and (next) the hint bar.
 */

/**
 * What a verb acts on. Entity targets always carry the id they act on — no
 * verb falls back to "whatever is hovered" on its own; the keyboard resolves
 * the hover into a target first (see `keyboard.ts`).
 */
export type VerbTarget =
	/** `dragging`: a card is in the hand of the pointer (group refuses then) */
	| { kind: 'card'; id: string; dragging?: boolean }
	| { kind: 'deck'; id: string }
	| { kind: 'piece'; id: string }
	/** a card in the local player's tray. Nothing acts on one by key today. */
	| { kind: 'hand-card'; id: string }
	/** the box selection (tableplace-202): every selected entity at once */
	| { kind: 'selection'; ids: string[] }
	| { kind: 'table' };

export type VerbTargetKind = VerbTarget['kind'];

/** who is acting — ownership gates read this, never the global "me" */
export type VerbActor = { playerId: string | null | undefined };

/**
 * What a piece can do, derived from its data rather than from what game it
 * belongs to. A verb asks for a capability ("has states"), never a kind's
 * name and never a game.
 */
export type PieceCapabilities = {
	/** two or more faces to step between */
	hasStates: boolean;
	/** holds other things and hands them out (a bag) */
	isContainer: boolean;
	/** a number you step up and down */
	isCounter: boolean;
	/** rolls to a random face */
	isRandomiser: boolean;
	/** turns by the snap grid's yaw step and carries its own snap toggle */
	isGridRotatable: boolean;
	/** can be taken off the table outright (a placed model) */
	isRemovable: boolean;
};

/**
 * A key chord. `codes` are `KeyboardEvent.code` values — layout-independent,
 * which is what every binding has always matched on. `shift` true/false
 * demands that state of the Shift key; absent means either (F, T, R and the
 * digits have always ignored Shift, and still do).
 */
export type Hotkey = {
	codes: readonly string[];
	shift?: boolean;
	/**
	 * true demands Ctrl (or ⌘); every other hotkey is bare and does not fire
	 * while either is held, so a browser chord is never also a table verb
	 */
	mod?: boolean;
	/** how the Keybinds folder, menus and (later) the wheel print it */
	label: string;
	/** a key that carries a number (the digits' draw count) */
	arg?: (code: string) => number;
};

/** what the registry hands a caller: one verb, bound to one target and actor */
export type Verb = {
	/** stable slug — also the wheel wedge's `data-radial-action` */
	id: string;
	/** short name: the wheel wedge's text */
	label: string;
	hotkey?: Hotkey;
	/** a pointer gesture that does this, for the reference and the hint bar */
	gesture?: string;
	/** offered on the radial wheel for this target */
	radial: boolean;
	/**
	 * Do it. Always safe to call, enabled or not: a refused verb says why (a
	 * toast) and changes nothing — the wheel and the key both rely on that.
	 */
	run: (arg?: number) => void;
	/** for a held key: what letting go does (Space's preview) */
	release?: () => void;
	enabled: boolean;
	reasonDisabled?: string;
};

/** the context a definition is instantiated with */
export type VerbContext<T extends VerbTarget = VerbTarget> = {
	target: T;
	actor: VerbActor;
	/** only set for a piece target whose piece exists */
	piece?: PieceCapabilities;
};

/**
 * One entry in the registry. `applies` keys it by entity kind and capability;
 * everything else is how it is offered and what it does.
 */
export type VerbDef = {
	id: string;
	label: string;
	/** a label that reads the target's state (a toggle naming what it will do) */
	labelFor?: (ctx: VerbContext) => string;
	/** the Keybinds folder's longer wording; defaults to `label` */
	reference?: string;
	applies: (ctx: VerbContext) => boolean;
	hotkey?: Hotkey;
	gesture?: string;
	radial?: boolean;
	run: (ctx: VerbContext, arg?: number) => void;
	release?: (ctx: VerbContext) => void;
	/** why this actor may not do it to this target right now, or null */
	refusal?: (ctx: VerbContext) => string | null;
	/**
	 * It moves, turns or swallows its target, so a pinned (`locked`) target
	 * refuses it — greyed with the reason, and a press toasts it instead of
	 * running (tableplace-189).
	 */
	movesTarget?: boolean;
};
