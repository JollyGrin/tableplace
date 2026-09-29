/**
 * The verb registry: the one list of what you can do to the thing under the
 * pointer.
 *
 * Before this, the same verbs were written four times — the keydown handlers
 * on /play and /setup, the radial wheel's entries, and the Keybinds folder's
 * hand-typed reference — and the copies drifted (#113 shipped a wrong label).
 * Now a verb is defined once here and every surface reads it:
 *
 * - `keyboard.ts` dispatches a keypress to the first verb whose hotkey matches
 *   on the thing under the pointer (both routes bind only that);
 * - `radial/actions.ts` offers the verbs marked `radial`, in this order;
 * - the Keybinds folder is `keybindReference()`.
 *
 * Verbs are keyed by entity kind and capability ("has states", "is a
 * container"), never by game. Every run goes through the same call it always
 * did — the hotkey wrappers for shuffle and ungroup, so a refusal toasts the
 * same way from a key or a wedge.
 */

import { get } from 'svelte/store';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { isDeckOwnedBy, ungroupRefusal, UNGROUP_MAX_CARDS } from '$lib/store/game/actions/deck';
import { grabDeck } from '$lib/drop/grab';
import { shuffleHoveredDeck, SHUFFLE_NOT_MINE } from '$lib/hotkeys/shuffle';
import { ungroupHoveredDeck, ungroupRefusalText } from '$lib/hotkeys/ungroup';
import { cameraTransforms } from '$lib/utils/transforms/camera';
import { SNAP_GRID_YAW_STEP_DEFAULT } from '$lib/utils/constants-snap';
import { toggleHelp } from '$lib/hint/hintUi';
import type { DropKind } from '$lib/utils/transforms/drop';
import type { PieceDTO } from '$lib/store/game/types';
import type {
	Hotkey,
	PieceCapabilities,
	Verb,
	VerbActor,
	VerbContext,
	VerbDef,
	VerbTarget,
	VerbTargetKind
} from './types';

/** the id of an entity target (every kind but table and selection has one) */
function idOf(ctx: VerbContext): string {
	return 'id' in ctx.target ? ctx.target.id : '';
}

const on =
	(kind: VerbTargetKind, cap?: (piece: PieceCapabilities) => boolean) => (ctx: VerbContext) =>
		ctx.target.kind === kind && (!cap || (!!ctx.piece && cap(ctx.piece)));

const key = (code: string, label: string, shift?: boolean): Hotkey => ({
	codes: [code],
	label,
	...(shift === undefined ? {} : { shift })
});

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => `Digit${n}`);

const STEP = SNAP_GRID_YAW_STEP_DEFAULT;

/**
 * The built-in verbs. Order matters twice: within a kind it is the radial
 * wheel's layout (top, then clockwise), and overall it is the Keybinds
 * folder's order.
 */
export const BUILTIN_VERBS: readonly VerbDef[] = [
	// ---- the table: always under the pointer, whatever else is ----
	{
		// Space is bound here; Alt opens the same preview as the no-snap modifier
		// TableScene already tracks (see HUDPreview/preview.ts `isPreviewOpen`).
		// It is deliberately NOT a code on this hotkey: Alt must stay a modifier
		// the registry never claims, so a held Alt still reaches every verb.
		id: 'preview',
		label: 'Preview',
		reference: 'Preview hovered (card, hand, deck, piece)',
		applies: on('table'),
		hotkey: { codes: ['Space'], label: 'hold Space or Alt' },
		run: () => cameraTransforms.togglePreviewHud(true),
		release: () => cameraTransforms.togglePreviewHud(false)
	},
	// the camera presets (tableplace-185), the table wheel's three wedges
	{
		id: 'reset-view',
		label: 'Seat view',
		reference: 'Seat view (reset camera)',
		applies: on('table'),
		hotkey: key('KeyC', 'C'),
		radial: true,
		run: () => cameraTransforms.resetView()
	},
	{
		id: 'top-down',
		label: 'Top-down',
		reference: 'Toggle top-down / seat view',
		applies: on('table'),
		hotkey: key('KeyP', 'P'),
		radial: true,
		run: () => cameraTransforms.toggleTopDown()
	},
	{
		// only reached with nothing on the table under the pointer: a hovered
		// card, deck or piece takes Z first (the entity verb below)
		id: 'focus',
		label: 'Focus last moved',
		reference: 'Focus what you moved last',
		applies: on('table'),
		hotkey: key('KeyZ', 'Z'),
		radial: true,
		run: () => cameraTransforms.focus()
	},
	{
		// '?' is Shift + Slash on the layouts `code` matching assumes; the list
		// it opens is `verbReference()`, so it can never miss a verb
		id: 'help',
		label: 'All keys',
		reference: 'Every verb on the table',
		applies: on('table'),
		hotkey: key('Slash', '?', true),
		run: () => toggleHelp()
	},

	// ---- a loose card ----
	{
		id: 'flip',
		label: 'Flip',
		reference: 'Flip card',
		applies: on('card'),
		hotkey: key('KeyF', 'F'),
		radial: true,
		run: (ctx) => void gameActions.flipCard(idOf(ctx))
	},
	{
		id: 'tap',
		label: 'Tap',
		reference: 'Tap card',
		applies: on('card'),
		hotkey: key('KeyT', 'T'),
		radial: true,
		run: (ctx) => gameActions.tapCard(false, idOf(ctx))
	},
	{
		id: 'tap-reverse',
		label: 'Tap ⟲',
		reference: 'Reverse tap card',
		applies: on('card'),
		hotkey: key('KeyR', 'R'),
		radial: true,
		run: (ctx) => gameActions.tapCard(true, idOf(ctx))
	},
	{
		id: 'group',
		label: 'Group into deck',
		reference: 'Group stack into deck',
		applies: on('card'),
		hotkey: key('KeyG', 'G', false),
		radial: true,
		// never swallow the card you are holding into a deck
		refusal: (ctx) =>
			ctx.target.kind === 'card' && ctx.target.dragging ? 'Put the card down first' : null,
		run: (ctx) => {
			if (ctx.target.kind === 'card' && ctx.target.dragging) return;
			void gameActions.groupStackIntoDeck(idOf(ctx));
		}
	},
	{
		id: 'raise',
		label: 'Nudge higher',
		reference: 'Nudge card higher',
		applies: on('card'),
		hotkey: key('ArrowUp', 'Arrow Up'),
		run: (ctx) => gameActions.incrementHeight(0.01, idOf(ctx))
	},
	{
		id: 'lower',
		label: 'Nudge lower',
		// #113 fixed this label — it is Arrow Down, not the Shift chord it used to claim
		reference: 'Nudge card lower',
		applies: on('card'),
		hotkey: key('ArrowDown', 'Arrow Down'),
		run: (ctx) => gameActions.incrementHeight(-0.01, idOf(ctx))
	},

	// ---- a deck ----
	{
		id: 'draw',
		label: 'Draw 1',
		reference: 'Draw that many from hovered deck',
		applies: on('deck'),
		// the digit is the count, fanned toward you; the wheel draws one
		hotkey: { codes: DIGITS, label: '1 – 9', arg: (code) => Number(code.slice('Digit'.length)) },
		radial: true,
		run: (ctx, count = 1) => void gameActions.drawFromTop(idOf(ctx), count)
	},
	{
		id: 'flip',
		label: 'Flip',
		reference: 'Flip hovered deck',
		applies: on('deck'),
		hotkey: key('KeyF', 'F'),
		radial: true,
		run: (ctx) => void gameActions.flipDeck(idOf(ctx))
	},
	{
		id: 'shuffle',
		label: 'Shuffle',
		reference: 'Shuffle hovered deck',
		applies: on('deck'),
		// Shift+S, not S: W/A/S/D pan the camera and auto-repeat while held, so a
		// bare S would shuffle-spam the moment you panned toward yourself
		hotkey: key('KeyS', 'Shift + S', true),
		radial: true,
		refusal: (ctx) => (isDeckOwnedBy(idOf(ctx), ctx.actor.playerId) ? null : SHUFFLE_NOT_MINE),
		run: (ctx) => void shuffleHoveredDeck(idOf(ctx))
	},
	{
		id: 'ungroup',
		label: 'Ungroup',
		reference: `Ungroup deck (max ${UNGROUP_MAX_CARDS} cards)`,
		applies: on('deck'),
		hotkey: key('KeyG', 'Shift + G', true),
		radial: true,
		refusal: (ctx) => {
			const refusal = ungroupRefusal(idOf(ctx), ctx.actor.playerId);
			return refusal && (ungroupRefusalText(refusal) ?? 'No deck there');
		},
		run: (ctx) => void ungroupHoveredDeck(idOf(ctx))
	},
	{
		// moving a pile is a wedge, not a long press: dragging a deck draws off
		// its top, and the hold it used to need is the wheel itself. The pile
		// follows the pointer until you click it down (see drop/grab).
		id: 'move',
		label: 'Move pile',
		applies: on('deck'),
		radial: true,
		run: (ctx) => void grabDeck(idOf(ctx))
	},

	// ---- a piece, by what it can do ----
	{
		id: 'rotate-cw',
		label: `Rotate +${STEP}°`,
		reference: `Rotate hovered model +${STEP}°`,
		applies: on('piece', (piece) => piece.isGridRotatable),
		hotkey: key('KeyT', 'T'),
		run: (ctx) => gameActions.rotatePiece(idOf(ctx), STEP)
	},
	{
		id: 'rotate-ccw',
		label: `Rotate −${STEP}°`,
		reference: `Rotate hovered model −${STEP}°`,
		applies: on('piece', (piece) => piece.isGridRotatable),
		hotkey: key('KeyR', 'R'),
		run: (ctx) => gameActions.rotatePiece(idOf(ctx), -STEP)
	},
	{
		id: 'state-next',
		label: 'Next state',
		reference: "Hovered piece's next state",
		applies: on('piece', (piece) => piece.hasStates),
		hotkey: key('KeyX', 'X', false),
		gesture: 'right-click to pick',
		run: (ctx) => gameActions.cyclePieceState(idOf(ctx), 1)
	},
	{
		id: 'state-prev',
		label: 'Previous state',
		reference: "Hovered piece's previous state",
		applies: on('piece', (piece) => piece.hasStates),
		hotkey: key('KeyX', 'Shift + X', true),
		run: (ctx) => gameActions.cyclePieceState(idOf(ctx), -1)
	},
	// pointer-only piece verbs: Piece.svelte's inputs dispatch these (they need
	// the click's drag guard); they are listed so the hint bar can name them
	{
		id: 'count-down',
		label: '−1',
		applies: on('piece', (piece) => piece.isCounter),
		gesture: 'click',
		run: (ctx) => gameActions.incrementCounter(idOf(ctx), -1)
	},
	{
		id: 'count-up',
		label: '+1',
		applies: on('piece', (piece) => piece.isCounter),
		gesture: 'right-click or Shift+click',
		run: (ctx) => gameActions.incrementCounter(idOf(ctx), 1)
	},
	{
		id: 'roll',
		label: 'Roll',
		applies: on('piece', (piece) => piece.isRandomiser),
		gesture: 'click',
		run: (ctx) => void gameActions.rollDie(idOf(ctx))
	},
	{
		id: 'take-out',
		label: 'Take one out',
		applies: on('piece', (piece) => piece.isContainer),
		gesture: 'click',
		run: (ctx) => void gameActions.drawFromBag(idOf(ctx))
	},
	// ---- anything on the table: last, so it never reorders a kind's own verbs ----
	{
		id: 'focus',
		label: 'Focus',
		reference: 'Focus hovered card, deck or piece',
		applies: (ctx) =>
			ctx.target.kind === 'card' || ctx.target.kind === 'deck' || ctx.target.kind === 'piece',
		hotkey: key('KeyZ', 'Z'),
		gesture: 'double-click',
		run: (ctx) => {
			const { kind } = ctx.target;
			if (kind === 'card' || kind === 'deck' || kind === 'piece')
				cameraTransforms.focus({ kind, id: idOf(ctx) });
		}
	}
];

/**
 * Where verbs come from: only the built-ins in this ticket.
 *
 * This is the seam for verbs a pack or scenario defines. They would arrive as
 * data, be turned into `VerbDef`s keyed by kind and capability exactly like
 * the ones above, and be appended here — every surface picks them up for free.
 * Nothing reads a pack or scenario today; that is deliberate, not an omission.
 */
export const VERB_SOURCES: readonly (readonly VerbDef[])[] = [BUILTIN_VERBS];

/** a piece's capabilities, from its data alone */
export function pieceCapabilities(
	piece: Partial<Pick<PieceDTO, 'kind' | 'states'>>
): PieceCapabilities {
	return {
		hasStates: (piece.states?.length ?? 0) >= 2,
		isContainer: piece.kind === 'bag',
		isCounter: piece.kind === 'counter',
		isRandomiser: piece.kind === 'die',
		isGridRotatable: piece.kind === 'model'
	};
}

function contextFor(target: VerbTarget, actor: VerbActor): VerbContext {
	if (target.kind !== 'piece') return { target, actor };
	const piece = get(gameStore)?.pieces?.[target.id];
	return { target, actor, ...(piece ? { piece: pieceCapabilities(piece) } : {}) };
}

/** the verbs that apply to `target` for `actor`, in registry order */
export function verbsFor(
	target: VerbTarget,
	actor: VerbActor,
	sources: readonly (readonly VerbDef[])[] = VERB_SOURCES
): Verb[] {
	const ctx = contextFor(target, actor);
	return sources
		.flat()
		.filter((def) => def.applies(ctx))
		.map((def) => {
			const reason = def.refusal?.(ctx) ?? null;
			return {
				id: def.id,
				label: def.label,
				...(def.hotkey ? { hotkey: def.hotkey } : {}),
				...(def.gesture ? { gesture: def.gesture } : {}),
				radial: def.radial ?? false,
				run: (arg?: number) => def.run(ctx, arg),
				...(def.release ? { release: () => def.release!(ctx) } : {}),
				enabled: reason === null,
				...(reason === null ? {} : { reasonDisabled: reason })
			};
		});
}

/**
 * Pointer and camera controls that are not verbs on a target — the wheel
 * itself, panning, and the drag modifiers — so they live with their gesture
 * code, not here. Listed so the Keybinds folder is still the whole card.
 */
const POINTER_BEFORE: KeybindRow[] = [
	// the wheel first: it is how you find the rest of this list (radial/gesture.ts)
	{ action: 'Actions on card / deck / table', key: 'right-click' },
	{ action: 'Same wheel, no right button', key: 'press & hold' },
	// held, auto-repeating camera motion (utils/transforms/pan.ts)
	{ action: 'Pan camera', key: 'W A S D' },
	// TableCamera.svelte's own listener, not a key
	{ action: 'Focus a card, deck or piece', key: 'double-click' }
];
const POINTER_AFTER: KeybindRow[] = [
	// both read by the drag itself (TableScene.svelte)
	{ action: 'Drop without snapping', key: 'hold Alt' },
	{ action: 'Cancel drag', key: 'Esc' }
];

export type KeybindRow = { action: string; key: string };

/**
 * The hint bar's idle line: how to move the camera and find the verbs, when
 * nothing is under the pointer. OrbitControls owns the drags and the wheel
 * (TableCamera.svelte); the wheel menu is radial/gesture.ts.
 */
export const TABLE_BASICS: readonly KeybindRow[] = [
	{ action: 'Orbit', key: 'drag' },
	{ action: 'Zoom', key: 'wheel' },
	{ action: 'Actions', key: 'right-click' }
];

/** the hint bar's drag line, after what the release does */
export const DRAG_MODIFIERS: readonly KeybindRow[] = [
	{ action: 'Free placement', key: 'hold Alt' },
	{ action: 'Put back', key: 'Esc' }
];

/**
 * What letting go of a drag does, by the landing `resolveDrop` picked — the
 * same resolution the drop indicator draws and the commit writes, so the
 * words never disagree with the landing.
 */
export const RELEASE_TEXT: Readonly<Record<DropKind, string>> = {
	table: 'Release to place',
	stack: 'Release to stack',
	snap: 'Release to snap into place',
	deck: 'Release onto the deck',
	bag: 'Release into the container',
	tray: 'Release to take into your hand'
};

/** what to call a thing that has no name of its own (or may not reveal it) */
export const TARGET_NOUNS: Readonly<Record<VerbTargetKind, string>> = {
	card: 'Card',
	deck: 'Deck',
	piece: 'Piece',
	'hand-card': 'Card in hand',
	selection: 'Selection',
	table: 'Table'
};

/** reference section order, and the heading each one reads under */
const REFERENCE_KINDS: readonly VerbTargetKind[] = ['table', 'card', 'deck', 'piece'];

export type VerbReferenceSection = { title: string; rows: KeybindRow[] };

/**
 * The `?` overlay: every verb that has a key or a gesture, grouped by what it
 * acts on, then the pointer controls. A verb that applies to several kinds is
 * listed under each (F flips a card and a deck).
 */
export function verbReference(
	sources: readonly (readonly VerbDef[])[] = VERB_SOURCES
): VerbReferenceSection[] {
	const defs = sources.flat();
	const sections = REFERENCE_KINDS.map((kind) => ({
		title: TARGET_NOUNS[kind],
		rows: defs
			.filter((def) => (def.hotkey || def.gesture) && def.applies(probe(kind)))
			.map((def) => ({
				action: def.reference ?? def.label,
				key: [def.hotkey?.label, def.gesture].filter(Boolean).join(' · ')
			}))
	}));
	return [
		...sections.filter((section) => section.rows.length > 0),
		{ title: 'Pointer', rows: uniqueByKey([...POINTER_BEFORE, ...TABLE_BASICS, ...POINTER_AFTER]) }
	];
}

function uniqueByKey(rows: KeybindRow[]): KeybindRow[] {
	return rows.filter((row, i) => rows.findIndex((other) => other.key === row.key) === i);
}

/** the Keybinds folder: every hotkey in the registry, plus the pointer controls */
export function keybindReference(
	sources: readonly (readonly VerbDef[])[] = VERB_SOURCES
): KeybindRow[] {
	const verbs = sources
		.flat()
		.filter((def) => def.hotkey)
		.map((def) => ({ action: def.reference ?? def.label, key: def.hotkey!.label }));
	return [...POINTER_BEFORE, ...verbs, ...POINTER_AFTER];
}

/** the printed hotkey of a registry verb, for a menu's footer */
export function hotkeyLabel(id: string, kind: VerbTargetKind): string | undefined {
	return VERB_SOURCES.flat().find((def) => def.id === id && def.applies(probe(kind)))?.hotkey
		?.label;
}

/** a context that satisfies any capability, for reading static metadata */
function probe(kind: VerbTargetKind): VerbContext {
	const target =
		kind === 'selection'
			? ({ kind, ids: [] } as VerbTarget)
			: kind === 'table'
				? ({ kind } as VerbTarget)
				: ({ kind, id: '' } as VerbTarget);
	const all = {
		hasStates: true,
		isContainer: true,
		isCounter: true,
		isRandomiser: true,
		isGridRotatable: true
	} as const;
	return { target, actor: { playerId: null }, piece: all };
}
