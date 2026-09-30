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
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { clearSelection, collectionOf } from '$lib/store/selection';
import { rotationStep } from '$lib/store/game/actions/rotate';
import { turnYaw } from '$lib/utils/yaw';
import type { GameDTO } from '$lib/store/game/types';

type Vec3 = [number, number, number];
type Patch = Record<string, Record<string, Record<string, unknown>>>;

function entityOf(state: Partial<GameDTO> | undefined | null, id: string) {
	return state?.[collectionOf(id)]?.[id] as
		| { rotation?: Vec3; locked?: boolean; isFaceUp?: boolean; kind?: string; placedBy?: string }
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
			const faceUp = x === 180;
			put(patch, id, {
				rotation: [faceUp ? 0 : 180, y, z],
				// as `flipCard`: face up is public, so the placer's peek mark goes
				...(faceUp && entity.placedBy ? { placedBy: null } : {})
			});
		}
	}
	return nonEmpty(patch);
}

/**
 * Q/E: turn every selected entity by the table's rotation step in place —
 * `direction` 1 is clockwise seen from above (E), -1 anticlockwise (Q). Every
 * card, deck and piece turns by the same step (tableplace-200), each about its
 * own centre; the group's layout stays.
 *
 * The units and signs are each kind's own — a card's yaw is `rotation[2]` in
 * degrees, a piece's `rotation[1]` in degrees, a deck's `rotation[1]` in
 * radians with the opposite sign — and `turnYaw` is the one place that knows.
 */
export function rotatePatch(
	state: Partial<GameDTO> | undefined | null,
	ids: readonly string[],
	direction: 1 | -1
): Partial<GameDTO> | null {
	const patch: Patch = {};
	const step = rotationStep(state ?? undefined);
	for (const id of ids) {
		const entity = entityOf(state, id);
		if (!entity || entity.locked) continue;
		const kind = id.startsWith('deck:') ? 'deck' : id.startsWith('piece:') ? 'piece' : 'card';
		put(patch, id, { rotation: turnYaw(kind, entity.rotation, direction * step) });
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
