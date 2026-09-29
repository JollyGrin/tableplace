import { get } from 'svelte/store';
import { MOVE_ENTITY, refuse } from '$lib/gate';
import { dragEnd, dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { withIntent } from '$lib/store/game/intents';
import { tableFeatures } from '$lib/store/tableFeatures';
import { modelSurfaceYAt } from '$lib/models/surface';
import { resolveDrop, type DropTarget } from '$lib/utils/transforms/drop';

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
		denied,
		origin
	} = get(dragStore);
	if (!id) return;

	// A drag the referee refused at the pickup (tableplace-171) commits nothing
	// at all: no drop is resolved, so none of the landing verbs run and there is
	// no patch, no broadcast and no minted intent. It goes back where it came
	// from instead, and says why.
	if (denied) return snapBack(id, denied, origin);

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
		gameActions.moveCardToTray(id, gameActions?.getMe()?.id as string);
	} else if (drop?.kind === 'deck' && drop.targetId) {
		gameActions.placeOnTopOfDeck(drop.targetId, id);
	} else if (drop?.kind === 'bag' && drop.targetId) {
		// the bag can refuse (it was emptied of its target, or removed, by another
		// client between the preview and this release) — then the entity has to
		// land somewhere rather than stay floating at drag height
		if (!gameActions.returnToBag(drop.targetId, id)) commitActiveDragAtRest(id);
	} else if (drop) {
		land(id, dropPatch(drop));
	}

	dragEnd();
}

/** What a landing writes: position, and rotation when the drop turned it. */
type Landing = { position: [number, number, number]; rotation?: [number, number, number] };

/**
 * A landing on plain felt — the one branch of a release with no `gameActions`
 * verb behind it. Named for the intent channel (tableplace-169) so a drag reads
 * as `moveEntity` in a game log rather than as an anonymous position patch; the
 * tray / deck / bag landings above already carry verbs of their own.
 *
 * The per-frame positions a drag streams while it is in flight are deliberately
 * NOT named: they go straight to `gameStore.updateState` from TableScene, and a
 * verb per pointer move is a flood, not a log. Only where it comes to rest is
 * an intent.
 */
const land = withIntent(MOVE_ENTITY, (id: string, patch: Landing) =>
	gameStore.updateState(landingPatch(id, patch))
);

/** Which collection an entity id belongs to — the only thing a landing branches on. */
function landingPatch(id: string, patch: Landing) {
	if (id.startsWith('piece:')) return { pieces: { [id]: patch } };
	if (id.startsWith('deck:')) return { decks: { [id]: patch } };
	return { cards: { [id]: patch } };
}

/**
 * Put a refused entity back where it was picked up, and say why
 * (tableplace-171).
 *
 * Deliberately `updateStateSilently` — the apply-without-broadcast path an
 * INBOUND patch uses. The refused drag never left this client (TableScene
 * streams a denied drag through the same silent path), so undoing it must not
 * leave either: a broadcast here would tell the peers about a position they were
 * carefully never shown, and the whole point of a denial is that nothing
 * crossed the wire. Their copy of the entity is still at `origin`, so a local
 * restore is what converges the table.
 */
function snapBack(id: string, reason: string, origin?: [number, number, number]) {
	// no origin means the drag never started (see dragStart) — belt and braces
	if (origin) gameStore.updateStateSilently(landingPatch(id, { position: origin }));
	refuse(MOVE_ENTITY, reason);
	dragEnd();
}

/**
 * The state patch a landing writes. Position always; rotation only when the
 * drop actually turned the entity — a snap point with an authored yaw. Every
 * other kind resolves the rotation the entity already has, and re-sending it
 * would put an unchanged field on the wire on every single drop.
 */
function dropPatch(drop: DropTarget): Landing {
	return drop.snap?.rotation !== undefined
		? { position: drop.position, rotation: drop.rotation }
		: { position: drop.position };
}

/**
 * Esc mid-drag: put the entity back where it was picked up and drop the drag.
 * Without a recorded origin (a card drawn out of a deck or tray never had a
 * table position) the next best thing is to let it settle where it floats,
 * which at least never leaves it stuck in the air.
 */
export function cancelActiveDrag() {
	const { isDragging: id, origin, denied } = get(dragStore);
	if (!id) return;

	// Esc on a refused drag lands in the same place a release does: back at the
	// origin, locally, with the reason said out loud. `land` here would be vetoed
	// at the seam and leave the entity wherever the local rehearsal left it.
	if (denied) return snapBack(id, denied, origin);

	if (!origin) {
		// settle in place: resolve against the entity's own XZ, not the pointer
		commitActiveDragAtRest(id);
		return;
	}

	land(id, { position: origin });

	dragEnd();
}

function commitActiveDragAtRest(id: string) {
	const drop = resolveDrop(get(gameStore), id, null, {}, { surfaceYAt: modelSurfaceYAt(id) });
	if (drop) land(id, dropPatch(drop));
	dragEnd();
}
