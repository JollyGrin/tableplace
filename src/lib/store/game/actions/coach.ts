import { gameStore } from '../gameStore.svelte';

/**
 * Hide (`false`) or, with null, stop hiding the first-run checklist on this
 * table (tableplace-206). Only the opt-out is ever written: a table that says
 * nothing shows it.
 */
function setCoach(coach: false | null) {
	gameStore.updateState({ table: { coach } } as Parameters<typeof gameStore.updateState>[0]);
}

export const coachActions = { setCoach };
