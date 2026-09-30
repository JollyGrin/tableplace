import toast from 'svelte-french-toast';
import { gameActions } from '$lib/store/game/actions';
import { UNGROUP_MAX_CARDS, type UngroupRefusal } from '$lib/store/game/actions/deck';
import { LOCKED_REFUSAL } from './lock';

/**
 * What a refused ungroup says out loud — the toast, and the verb registry's
 * `reasonDisabled`. Null for `no-deck`: that is a stray keypress, not a refusal.
 */
export function ungroupRefusalText(refusal: UngroupRefusal): string | null {
	switch (refusal.reason) {
		case 'no-deck':
			return null;
		case 'not-mine':
			return "That deck isn't yours to spread";
		case 'locked':
			return LOCKED_REFUSAL;
		case 'empty':
			return 'That deck is empty';
		case 'too-many':
			return `${refusal.count} cards is too many to spread — Shift+G is capped at ${UNGROUP_MAX_CARDS}`;
	}
}

/**
 * `Shift+G` on a hovered deck: spread it back into loose cards.
 *
 * Shared by /play and /setup so the refusal wording — the only place the
 * card cap is visible while playing — is written once. The radial menu passes
 * the pressed deck's id explicitly (the pointer has left it by the time a
 * wedge is chosen); the keybind passes nothing and keeps the hover fallback.
 */
export function ungroupHoveredDeck(deckId?: string) {
	const result = gameActions.ungroupDeck(deckId);
	if (result.ok) return result;
	// nothing under the pointer (Shift+G aimed at a card, not a deck) is
	// silent — a toast on every stray keypress is noise
	const text = ungroupRefusalText(result);
	if (text) toast.error(text);
	return result;
}
