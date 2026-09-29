/**
 * What each kind of thing offers on its wheel — read from the verb registry.
 *
 * A wedge IS the registry verb the keybind runs — the hotkey wrappers for
 * shuffle and ungroup, not `gameActions` directly — so ownership refusals and
 * their toasts are written once and the wheel can never quietly become a
 * second, more permissive way to touch a deck.
 *
 * The target id is always the entity the press landed on, passed explicitly.
 * The hover fallback inside `flipCard`/`tapCard`/`flipDeck` must never decide a
 * wheel action: the wheel is up *because* you pressed something, and by the
 * time you flick to a wedge the pointer has left it.
 */

import { get } from 'svelte/store';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { verbsFor } from '$lib/verbs/registry';
import type { VerbTarget } from '$lib/verbs/types';

export type RadialTargetKind = 'card' | 'deck' | 'piece' | 'table';

/** what the press landed on; `id` is absent only for the table felt */
export type RadialTarget = { kind: RadialTargetKind; id?: string };

export type RadialOption = {
	/** stable slug — the wedge's `data-radial-action`, and what specs aim at */
	id: string;
	label: string;
	/**
	 * What else does this: the verb's hotkey, or failing that its click. The
	 * wheel prints it beside the label, so using the wheel teaches the key.
	 */
	key?: string;
	run: () => void;
};

/** shown in the wheel's hub, so you can see what you are about to act on */
export function radialTitle(target: RadialTarget): string {
	if (target.kind === 'card') return 'Card';
	if (target.kind === 'deck') return 'Deck';
	// a piece has a name of its own more often than not (a card may not reveal
	// one, so it never uses it)
	if (target.kind === 'piece')
		return (target.id && get(gameStore)?.pieces?.[target.id]?.name) || 'Piece';
	return 'Table';
}

/**
 * The verbs marked `radial` in the registry (`$lib/verbs/registry.ts`), in its
 * order. Wedges are laid out from the top, clockwise (see geometry.ts), so that
 * order is the layout: for four options that reads up / right / down / left.
 */
export function radialOptions(target: RadialTarget): RadialOption[] {
	return verbsFor(toVerbTarget(target), { playerId: gameActions.getMe()?.id })
		.filter((verb) => verb.radial)
		.map(({ id, label, hotkey, gesture, run }) => {
			const key = hotkey?.label ?? gesture;
			return { id, label, ...(key ? { key } : {}), run: () => run() };
		});
}

/** an entity target that lost its id falls back to the table's wheel */
function toVerbTarget({ kind, id }: RadialTarget): VerbTarget {
	return kind === 'table' || !id ? { kind: 'table' } : { kind, id };
}
