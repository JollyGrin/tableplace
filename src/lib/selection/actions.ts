/**
 * What the selection verbs do (tableplace-202): F, Q/E, L and G on every
 * selected entity at once.
 *
 * Each builds ONE patch for the whole selection and sends it as one message.
 * Running the single-entity action per member would put a message on the
 * wire per member — ten flipped cards would be ten messages in one instant,
 * most of the relay's burst allowance (15) for a single keypress.
 *
 * The patch builders are pure over the state so every rule is unit-tested
 * without a canvas. Pinned entities are never selected (store/selection), and
 * the builders skip one anyway: the pin is re-checked against the state they
 * are handed, since another player may have locked it a moment ago.
 */

import { get } from 'svelte/store';
import toast from 'svelte-french-toast';
import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { clearSelection, collectionOf } from '$lib/store/selection';
import { SNAP_GRID_YAW_STEP_DEFAULT } from '$lib/utils/constants-snap';
import type { GameDTO } from '$lib/store/game/types';

type Vec3 = [number, number, number];
type Patch = Record<string, Record<string, Record<string, unknown>>>;

function entityOf(state: Partial<GameDTO> | undefined | null, id: string) {
	return state?.[collectionOf(id)]?.[id] as
		| { rotation?: Vec3; locked?: boolean; isFaceUp?: boolean; kind?: string }
		| null
		| undefined;
}

function put(patch: Patch, id: string, fields: Record<string, unknown>) {
	(patch[collectionOf(id)] ??= {})[id] = fields;
}

/** the patch, or null when it would change nothing */
function nonEmpty(patch: Patch): Partial<GameDTO> | null {
	return Object.keys(patch).length ? (patch as Partial<GameDTO>) : null;
}

/**
 * F: turn every selected card over, and every selected deck (a deck's flip is
 * its `isFaceUp`, as `flipDeck` does it). Pieces have no back to show.
 */
export function flipPatch(
	state: Partial<GameDTO> | undefined | null,
	ids: readonly string[]
): Partial<GameDTO> | null {
	const patch: Patch = {};
	for (const id of ids) {
		const entity = entityOf(state, id);
		if (!entity || entity.locked) continue;
		if (id.startsWith('deck:')) put(patch, id, { isFaceUp: !(entity.isFaceUp ?? false) });
		else if (!id.startsWith('piece:')) {
			const [x = 0, y = 0, z = 0] = entity.rotation ?? [];
			put(patch, id, { rotation: [x === 180 ? 0 : 180, y, z] });
		}
	}
	return nonEmpty(patch);
}

/**
 * Q/E: turn every selected entity a step in place — `direction` 1 is
 * clockwise seen from above (E), -1 anticlockwise (Q). A card turns a quarter
 * (a tap), a deck a quarter, a piece that turns by the grid step (a model)
 * by that step. Each turns about its own centre; the group's layout stays.
 *
 * The units and signs are each kind's own: a card's yaw is `rotation[2]` in
 * degrees drawn as -z, a piece's `rotation[1]` in degrees drawn as -y, a
 * deck's `rotation[1]` in radians drawn as +y.
 */
export function rotatePatch(
	state: Partial<GameDTO> | undefined | null,
	ids: readonly string[],
	direction: 1 | -1
): Partial<GameDTO> | null {
	const patch: Patch = {};
	for (const id of ids) {
		const entity = entityOf(state, id);
		if (!entity || entity.locked) continue;
		const [x = 0, y = 0, z = 0] = entity.rotation ?? [];
		if (id.startsWith('deck:')) {
			put(patch, id, { rotation: [x, y - direction * 90 * DEG2RAD, z] });
		} else if (id.startsWith('piece:')) {
			// only a piece that turns by the grid step (`isGridRotatable` in the
			// verb registry — a model); a disc token or a dial has no facing to turn
			if (entity.kind !== 'model') continue;
			const next = (((y + direction * SNAP_GRID_YAW_STEP_DEFAULT) % 360) + 360) % 360;
			put(patch, id, { rotation: [x, next, z] });
		} else {
			put(patch, id, { rotation: [x, y, z + direction * 90] });
		}
	}
	return nonEmpty(patch);
}

/** L: pin every selected entity */
export function lockPatch(
	state: Partial<GameDTO> | undefined | null,
	ids: readonly string[]
): Partial<GameDTO> | null {
	const patch: Patch = {};
	for (const id of ids) {
		const entity = entityOf(state, id);
		if (entity && !entity.locked) put(patch, id, { locked: true });
	}
	return nonEmpty(patch);
}

function send(patch: Partial<GameDTO> | null) {
	if (patch) gameStore.updateState(patch);
}

export function flipSelection(ids: readonly string[]) {
	send(flipPatch(get(gameStore), ids));
}

export function rotateSelection(ids: readonly string[], direction: 1 | -1) {
	send(rotatePatch(get(gameStore), ids, direction));
}

/**
 * Pinning takes the entities out of the selection — a locked thing is never
 * selected — so the selection is let go of outright, and the toast says how
 * many were pinned.
 */
export function lockSelection(ids: readonly string[]) {
	const patch = lockPatch(get(gameStore), ids);
	if (!patch) return;
	const count = Object.values(patch).reduce((n, records) => n + Object.keys(records).length, 0);
	send(patch);
	clearSelection();
	toast(`Locked ${count} in place`, { id: 'locked-refusal', icon: '🔒', duration: 1400 });
}

/** what G says when the selection holds no loose card to group */
export const GROUP_NO_CARDS = 'No loose cards selected';

export function selectionHasCards(ids: readonly string[]): boolean {
	return ids.some((id) => collectionOf(id) === 'cards');
}

/** G: every selected loose card into one deck; the rest of the selection stays */
export function groupSelection(ids: readonly string[]) {
	if (!selectionHasCards(ids)) {
		toast(GROUP_NO_CARDS, { id: 'selection-group', duration: 1600 });
		return;
	}
	gameActions.groupCardsIntoDeck(ids);
}
