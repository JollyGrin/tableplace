/**
 * Keyboard → verb. The only keydown/keyup handlers /play and /setup bind:
 * resolve what is under the pointer into targets, most specific first, and run
 * the first verb whose hotkey matches.
 *
 * The target order is the routing the routes used to hand-write, behind one
 * rule added with Q/E (tableplace-200): the thing being carried is asked
 * first. Otherwise a hovered deck takes a key before anything else (F flips the whole deck, not the card),
 * then a hovered piece (T/R turn a model rather than tapping a card), then the
 * hovered card or hand card, then the table (C, Space). A key a target has no
 * verb for falls through to the next one — G on a deck still groups the
 * hovered card.
 *
 * Nothing here calls `preventDefault` or `stopPropagation`, and no verb claims
 * Alt: it is the no-snap modifier and the second preview key, read by
 * TableScene's own listener, and it must reach it untouched. Ctrl/⌘ belongs
 * to the one verb that asks for it (undo); a bare key never fires under it.
 */

import { get } from 'svelte/store';
import { dragStore, type DragState } from '$lib/store/dragStore.svelte';
import { hoveredPiece } from '$lib/store/pieceUi';
import { hoveredTrayCard } from '$lib/HUDTray/trayHover';
import { gameActions } from '$lib/store/game/actions';
import { isTyping } from '$lib/hotkeys/is-typing';
import { searchingDeck } from '$lib/deckSearch/deckSearch';
import { selectedIds } from '$lib/store/selection';
import { verbsFor } from './registry';
import type { Hotkey, Verb, VerbActor, VerbTarget } from './types';

/** what is under the pointer right now, most specific first; the table is always last */
export function pointerTargets(): VerbTarget[] {
	return targetsUnder(get(dragStore), get(hoveredPiece), get(hoveredTrayCard), get(selectedIds));
}

/**
 * `pointerTargets` over values the caller already holds — the hint bar reads
 * the same stores reactively and must resolve them exactly the way a key does.
 */
export function targetsUnder(
	{
		isDeckHovered,
		isHovered,
		isDragging
	}: Pick<DragState, 'isDeckHovered' | 'isHovered' | 'isDragging'>,
	piece: string | null,
	handCard: string | null,
	selected: readonly string[] = []
): VerbTarget[] {
	const targets: VerbTarget[] = [];
	// the thing in your hand comes first, whatever it is carried over: Q/E turn
	// what you hold, F flips it (tableplace-200). Until then a carried deck or
	// piece reached no verb at all — its id was offered as a card.
	if (isDragging) targets.push(heldTarget(isDragging));
	if (isDeckHovered && isDeckHovered !== isDragging)
		targets.push({ kind: 'deck', id: isDeckHovered });
	if (piece && piece !== isDragging) targets.push({ kind: 'piece', id: piece });
	if (isHovered && isHovered !== isDragging)
		targets.push({ kind: 'card', id: isHovered, dragging: !!isDragging });
	// a card in your hand: no verbs yet, but a key over it must still reach the
	// table's (Space previews it — see HUDPreview/preview.ts)
	if (handCard) targets.push({ kind: 'hand-card', id: handCard });
	// The selection (tableplace-202) goes first while the pointer is on one of
	// its members, or on nothing: F there flips the lot. Over something NOT
	// selected, that thing keeps its keys and the selection is not a target
	// at all — pointing at a card and pressing F flips that card.
	if (selected.length) {
		const pointed = targets.filter((t) => 'id' in t && t.kind !== 'hand-card');
		if (!pointed.length || pointed.some((t) => 'id' in t && selected.includes(t.id)))
			targets.unshift({ kind: 'selection', ids: [...selected] });
	}
	targets.push({ kind: 'table' });
	return targets;
}

/** the dragged id as a target of its own kind (ids are `kind:owner:slug`) */
function heldTarget(id: string): VerbTarget {
	if (id.startsWith('deck:')) return { kind: 'deck', id };
	if (id.startsWith('piece:')) return { kind: 'piece', id };
	return { kind: 'card', id, dragging: true };
}

export function currentActor(): VerbActor {
	return { playerId: gameActions.getMe()?.id };
}

type KeyChord = Pick<KeyboardEvent, 'code' | 'shiftKey'> &
	Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>>;

export function matchesHotkey(hotkey: Hotkey, event: KeyChord) {
	if (!hotkey.codes.includes(event.code)) return false;
	if (!!hotkey.mod !== !!(event.ctrlKey || event.metaKey)) return false;
	return hotkey.shift === undefined || hotkey.shift === event.shiftKey;
}

/** the verb a keypress means right now, or null */
export function verbForKey(
	event: KeyChord,
	targets: VerbTarget[] = pointerTargets(),
	actor: VerbActor = currentActor()
): Verb | null {
	for (const target of targets) {
		const verb = verbsFor(target, actor).find((v) => v.hotkey && matchesHotkey(v.hotkey, event));
		if (verb) return verb;
	}
	return null;
}

/**
 * `svelte:window` keydown. A key typed into a pane field is text, not a table
 * command — and the table is synced, so a stray G would group a pile for
 * everyone.
 */
export function handleVerbKeyDown(event: KeyboardEvent) {
	if (isTyping(event.target)) return;
	// the search drawer is modal: the deck behind it still reads as hovered
	if (get(searchingDeck)) return;
	const verb = verbForKey(event);
	if (event.repeat && verb?.hotkey?.once) return;
	verb?.run(verb.hotkey?.arg?.(event.code));
}

/** `svelte:window` keyup: lets go of a held verb (Space's preview) */
export function handleVerbKeyUp(event: KeyboardEvent) {
	if (isTyping(event.target)) return;
	const held = verbsFor({ kind: 'table' }, currentActor()).find(
		(v) => v.release && v.hotkey?.codes.includes(event.code)
	);
	held?.release?.();
}
