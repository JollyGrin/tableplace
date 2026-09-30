import { get } from 'svelte/store';
import { carriedIds, dragEnd, dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { tableFeatures } from '$lib/store/tableFeatures';
import { modelSurfaceYAt } from '$lib/models/surface';
import { resolveDrop, type DropTarget } from '$lib/utils/transforms/drop';
import { resolveGroupDrop } from '$lib/utils/transforms/group-drop';
import { collectionOf } from '$lib/store/selection';
import { handDropIndex } from '$lib/HUDTray/handGesture';
import type { GameDTO } from '$lib/store/game/types';

/**
 * Ending a drag, in one place.
 *
 * Every release funnels through `commitActiveDrag` — the table mesh's
 * pointerup and the window-level fallback for releases that never reach it
 * (pointer left the canvas, or came up over the HUD). The window listener
 * runs last in the bubble order, so a normal on-table release has already
 * cleared `isDragging` by the time it fires and it no-ops.
 */
export function commitActiveDrag() {
	const {
		isDragging: id,
		intersectionPoint,
		isDeckHovered,
		isBagHovered,
		isTrayHovered,
		noSnap,
		group = []
	} = get(dragStore);
	if (!id) return;

	if (group.length) {
		// a group lands on the table, every member resolving its own snap — see
		// utils/transforms/group-drop.ts. One patch for the lot: one message.
		const landings = resolveGroupDrop(get(gameStore), id, intersectionPoint, group, {
			noSnap,
			hand: get(tableFeatures).hand,
			// the whole group floats: none of it may be a floor to the rest
			surfaceYAt: () => modelSurfaceYAt(carriedIds(get(dragStore)))
		});
		const patch: Record<string, Record<string, ReturnType<typeof dropPatch>>> = {};
		for (const [memberId, drop] of landings)
			(patch[collectionOf(memberId)] ??= {})[memberId] = dropPatch(drop);
		if (landings.length) gameStore.updateState(patch as Partial<GameDTO>);
		dragEnd();
		return;
	}

	// resolved by the same pure function the DropIndicator previews with, so
	// what the player saw while dragging is what gets committed — including
	// whether Alt was down (noSnap), which the release writes into the store
	// from the pointer event before calling in, and whether this route has a
	// hand at all. The options must match the indicator's exactly.
	const drop = resolveDrop(
		get(gameStore),
		id,
		intersectionPoint,
		{ deckId: isDeckHovered, bagId: isBagHovered, tray: isTrayHovered },
		// surfaceYAt: model meshes redefine the local floor (excluding the piece
		// being dragged, which floats over its own drop point). The indicator
		// passes the identical callback, keeping the preview honest.
		{ noSnap, hand: get(tableFeatures).hand, surfaceYAt: modelSurfaceYAt(id) }
	);

	if (drop?.kind === 'tray') {
		// into the gap the fan opened under the pointer (tableplace-195)
		gameActions.moveCardToTray(
			id,
			gameActions?.getMe()?.id as string,
			get(handDropIndex) ?? undefined
		);
		handDropIndex.set(null);
	} else if (drop?.kind === 'deck' && drop.targetId) {
		gameActions.placeOnTopOfDeck(drop.targetId, id);
	} else if (drop?.kind === 'bag' && drop.targetId) {
		// the bag can refuse (it was emptied of its target, or removed, by another
		// client between the preview and this release) — then the entity has to
		// land somewhere rather than stay floating at drag height
		if (!gameActions.returnToBag(drop.targetId, id)) commitActiveDragAtRest(id);
	} else if (drop && id.startsWith('piece:')) {
		landPiece(id, dropPatch(drop));
	} else if (drop && id.startsWith('deck:')) {
		gameStore.updateState({ decks: { [id]: dropPatch(drop) } });
	} else if (drop) {
		gameStore.updateState({ cards: { [id]: dropPatch(drop) } });
	} else {
		// nowhere to land (the entity is gone, or the pointer never met the
		// table): nothing moves, but a hold must never outlive the drag
		releaseHold(id);
	}

	dragEnd();
}

/**
 * The state patch a landing writes. Position always; rotation only when the
 * drop actually turned the entity — a snap point with an authored yaw. Every
 * other kind resolves the rotation the entity already has, and re-sending it
 * would put an unchanged field on the wire on every single drop.
 *
 * And the hold comes off in the same patch (tableplace-199): `heldBy: null`
 * rides the landing, so letting go costs no message of its own either.
 */
function dropPatch(drop: DropTarget): {
	position: [number, number, number];
	rotation?: [number, number, number];
	heldBy: null;
} {
	return drop.snap?.rotation !== undefined
		? { position: drop.position, rotation: drop.rotation, heldBy: null }
		: { position: drop.position, heldBy: null };
}

/**
 * A piece's landing. Its own writer only for the types: the store's patch type
 * does not reach into the optional `pieces` collection, so `heldBy: null`
 * (delete) would not type there the way it does on cards and decks.
 */
function landPiece(id: string, patch: ReturnType<typeof dropPatch>) {
	gameStore.updateState({ pieces: { [id]: patch } } as unknown as Partial<GameDTO>);
}

/** let go of `id` without moving it — only when it is recorded as held */
function releaseHold(id: string) {
	const collection = collectionOf(id);
	const entity = get(gameStore)?.[collection]?.[id] as { heldBy?: string } | null | undefined;
	if (!entity?.heldBy) return;
	gameStore.updateState({ [collection]: { [id]: { heldBy: null } } } as Partial<GameDTO>);
}

/**
 * Esc mid-drag: put the entity back where it was picked up and drop the drag.
 * Without a recorded origin (a card drawn out of a deck or tray never had a
 * table position) the next best thing is to let it settle where it floats,
 * which at least never leaves it stuck in the air.
 */
export function cancelActiveDrag() {
	const { isDragging: id, origin, group = [] } = get(dragStore);
	if (!id) return;

	if (group.length && origin) {
		// the whole group goes back where it was picked up, in one patch
		const patch: Record<
			string,
			Record<string, { position: [number, number, number]; heldBy: null }>
		> = {};
		for (const member of [{ id, origin }, ...group])
			(patch[collectionOf(member.id)] ??= {})[member.id] = {
				position: member.origin,
				heldBy: null
			};
		gameStore.updateState(patch as Partial<GameDTO>);
		dragEnd();
		return;
	}

	if (!origin) {
		// settle in place: resolve against the entity's own XZ, not the pointer
		commitActiveDragAtRest(id);
		return;
	}

	// back where it was, and out of the hand in the same patch
	const back = { position: origin, heldBy: null };
	if (id.startsWith('piece:')) landPiece(id, back);
	else if (id.startsWith('deck:')) gameStore.updateState({ decks: { [id]: back } });
	else gameStore.updateState({ cards: { [id]: back } });

	dragEnd();
}

function commitActiveDragAtRest(id: string) {
	const drop = resolveDrop(get(gameStore), id, null, {}, { surfaceYAt: modelSurfaceYAt(id) });
	if (drop && id.startsWith('piece:')) landPiece(id, dropPatch(drop));
	else if (drop && id.startsWith('deck:'))
		gameStore.updateState({ decks: { [id]: dropPatch(drop) } });
	else if (drop) gameStore.updateState({ cards: { [id]: dropPatch(drop) } });
	else releaseHold(id);
	dragEnd();
}
