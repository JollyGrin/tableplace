/**
 * Keyboard → verb. The only keydown/keyup handlers /play and /setup bind:
 * resolve what is under the pointer into targets, most specific first, and run
 * the first verb whose hotkey matches.
 *
 * The target order is the routing the routes used to hand-write: a hovered
 * deck takes a key before anything else (F flips the whole deck, not the card),
 * then a hovered piece (T/R turn a model rather than tapping a card), then the
 * hovered card, then the table (C, Space). A key a target has no verb for
 * falls through to the next one — G on a deck still groups the hovered card.
 */

import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { hoveredPiece } from '$lib/store/pieceUi';
import { gameActions } from '$lib/store/game/actions';
import { isTyping } from '$lib/hotkeys/is-typing';
import { verbsFor } from './registry';
import type { Hotkey, Verb, VerbActor, VerbTarget } from './types';

/** what is under the pointer right now, most specific first; the table is always last */
export function pointerTargets(): VerbTarget[] {
	const { isDeckHovered, isHovered, isDragging } = get(dragStore);
	const piece = get(hoveredPiece);
	const targets: VerbTarget[] = [];
	if (isDeckHovered) targets.push({ kind: 'deck', id: isDeckHovered });
	if (piece) targets.push({ kind: 'piece', id: piece });
	// a card you are carrying still takes F/T/R — the hovered one wins if both
	const cardId = isHovered || isDragging;
	if (cardId) targets.push({ kind: 'card', id: cardId, dragging: !!isDragging });
	targets.push({ kind: 'table' });
	return targets;
}

export function currentActor(): VerbActor {
	return { playerId: gameActions.getMe()?.id };
}

export function matchesHotkey(hotkey: Hotkey, event: Pick<KeyboardEvent, 'code' | 'shiftKey'>) {
	if (!hotkey.codes.includes(event.code)) return false;
	return hotkey.shift === undefined || hotkey.shift === event.shiftKey;
}

/** the verb a keypress means right now, or null */
export function verbForKey(
	event: Pick<KeyboardEvent, 'code' | 'shiftKey'>,
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
	const verb = verbForKey(event);
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
