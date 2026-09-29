/**
 * What each kind of thing offers on its wheel.
 *
 * Every option routes through the SAME call the keybind does — the hotkey
 * wrappers for shuffle and ungroup, not `gameActions` directly — so ownership
 * refusals and their toasts are written once and the wheel can never quietly
 * become a second, more permissive way to touch a deck.
 *
 * The target id is always the entity the press landed on, passed explicitly.
 * The hover fallback inside `flipCard`/`tapCard`/`flipDeck` must never decide a
 * wheel action: the wheel is up *because* you pressed something, and by the
 * time you flick to a wedge the pointer has left it.
 */

import { gameActions } from '$lib/store/game/actions';
import { grabDeck } from '$lib/drop/grab';
import { shuffleHoveredDeck } from '$lib/hotkeys/shuffle';
import { drawHoveredDeckToHand } from '$lib/hotkeys/draw';
import { ungroupHoveredDeck } from '$lib/hotkeys/ungroup';
import { cameraTransforms } from '$lib/utils/transforms/camera';

export type RadialTargetKind = 'card' | 'deck' | 'table';

/** what the press landed on; `id` is absent only for the table felt */
export type RadialTarget = { kind: RadialTargetKind; id?: string };

export type RadialOption = {
	/** stable slug — the wedge's `data-radial-action`, and what specs aim at */
	id: string;
	label: string;
	run: () => void;
};

/** shown in the wheel's hub, so you can see what you are about to act on */
export function radialTitle(target: RadialTarget): string {
	if (target.kind === 'card') return 'Card';
	if (target.kind === 'deck') return 'Deck';
	return 'Table';
}

/**
 * Wedges are laid out from the top, clockwise (see geometry.ts), so this order
 * is the layout: for four options that reads up / right / down / left.
 */
export function radialOptions(target: RadialTarget): RadialOption[] {
	const id = target.id;
	if (target.kind === 'card' && id) {
		return [
			{ id: 'flip', label: 'Flip', run: () => void gameActions.flipCard(id) },
			{ id: 'tap', label: 'Tap', run: () => gameActions.tapCard(false, id) },
			{ id: 'tap-reverse', label: 'Tap ⟲', run: () => gameActions.tapCard(true, id) },
			{ id: 'group', label: 'Group into deck', run: () => void gameActions.groupStackIntoDeck(id) }
		];
	}
	if (target.kind === 'deck' && id) {
		return [
			// a click draws to your hand; the felt is the wheel's (and Shift+click's)
			{ id: 'draw', label: 'Draw to hand', run: () => void drawHoveredDeckToHand(id, 1) },
			{ id: 'draw-table', label: 'Draw to table', run: () => void gameActions.drawFromTop(id, 1) },
			{ id: 'flip', label: 'Flip', run: () => void gameActions.flipDeck(id) },
			{ id: 'shuffle', label: 'Shuffle', run: () => void shuffleHoveredDeck(id) },
			{ id: 'ungroup', label: 'Ungroup', run: () => void ungroupHoveredDeck(id) },
			// moving a pile lives here now rather than on a long press: dragging a
			// deck draws off its top, and the hold it used to need is this wheel.
			// The pile follows the pointer until you click it down (see drop/grab).
			{ id: 'move', label: 'Move pile', run: () => void grabDeck(id) }
		];
	}
	// deliberately sparse — the layout handles 1-8, so a table verb (spawn, ping)
	// is a line here and nothing else
	return [{ id: 'reset-view', label: 'Reset view', run: () => cameraTransforms.resetView() }];
}
