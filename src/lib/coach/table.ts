/**
 * The table's say over the first-run checklist (tableplace-206): a scenario's
 * `coach: false` hides it for everyone on that table. Seeded into the synced
 * `state.table` like `rotationStep` and `handPlayFace`.
 *
 * Relative imports only: the scenario parser reads `validCoach` and is loaded
 * by the schema scripts outside Vite.
 */

import type { GameDTO } from '../store/game/types';

export function validCoach(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/** does this table let the checklist show? Anything but an explicit `false` does */
export function tableAllowsCoach(game: Partial<GameDTO> | undefined): boolean {
	return validCoach(game?.table?.coach) !== false;
}
