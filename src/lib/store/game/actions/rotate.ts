import { get } from 'svelte/store';
import { gameStore } from '../gameStore.svelte';
import { isLocked } from './lock';
import { turnYaw, validRotationStep, type YawKind } from '$lib/utils/yaw';
import { ROTATION_STEP_DEFAULT } from '$lib/utils/constants-rotation';
import type { GameDTO } from '../types';

/**
 * Rotation steps (tableplace-200): Q and E turn a card, deck or piece by the
 * table's rotation step. The yaw conventions each kind keeps are in
 * `utils/yaw.ts`; this only finds the entity and writes one patch.
 */

const COLLECTION = {
	card: 'cards',
	deck: 'decks',
	piece: 'pieces'
} as const satisfies Record<YawKind, keyof GameDTO>;

/** the table's rotation step in degrees: the scenario's, else the default */
export function rotationStep(game: Partial<GameDTO> | undefined = get(gameStore)): number {
	return validRotationStep(game?.table?.rotationStep) ?? ROTATION_STEP_DEFAULT;
}

/**
 * Turn one entity clockwise (seen from above) by `degrees`; negative turns
 * counter-clockwise. A pinned or missing entity is left alone — the guard
 * lives here, like every other `movesTarget` action's, so no route around the
 * keyboard can turn a locked thing.
 */
function rotateEntity(kind: YawKind, id: string, degrees: number) {
	const entity = get(gameStore)?.[COLLECTION[kind]]?.[id];
	if (!entity || isLocked(kind, id)) return;
	const rotation = turnYaw(kind, entity.rotation, degrees);
	gameStore.updateState({ [COLLECTION[kind]]: { [id]: { rotation } } } as Parameters<
		typeof gameStore.updateState
	>[0]);
}

/**
 * Set (or with null, clear) the table's rotation step. An out-of-range step
 * is refused rather than clamped: a scenario that says 720 is a typo.
 */
function setRotationStep(step: number | null) {
	if (step !== null && validRotationStep(step) === undefined) return;
	gameStore.updateState({ table: { rotationStep: step } } as Parameters<
		typeof gameStore.updateState
	>[0]);
}

export const rotateActions = { rotateEntity, setRotationStep };
