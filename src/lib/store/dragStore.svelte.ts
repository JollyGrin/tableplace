import { get, writable } from 'svelte/store';
import type { Vector3 } from 'three';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { collectStackGroup } from '$lib/utils/transforms/stacking';
import { clearSelection, collectionOf, currentSelection } from '$lib/store/selection';
import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
import { PIECE_DRAG_Y } from '$lib/utils/constants-pieces';
import { clampToTable } from '$lib/utils/transforms/drop';
import type { GameDTO } from '$lib/store/game/types';
import { heldByOther, myHoldId } from '$lib/store/hold';
import { toastHeld } from '$lib/hotkeys/held';

type Vec3 = [number, number, number];

/**
 * One entity carried along with the lead of a group drag (tableplace-202):
 * where it sits relative to the lead, and where Esc puts it back.
 */
export type GroupMember = { id: string; offset: [number, number]; origin: Vec3 };

interface DragState {
	isDragging: string | null;
	isHovered: string | null;
	isDeckHovered: string | null;
	/** id of the bag piece under the pointer — a drop there goes into the bag */
	isBagHovered: string | null;
	isTrayHovered: boolean;
	isPreview?: boolean;
	dragHeight?: number;
	intersectionPoint?: Vector3;
	/**
	 * Members of the loose stack under the pointer, bottom → top — the set
	 * `G` would swallow — so the whole pile can fan on hover instead of only
	 * the top card glowing. Null for a lone card and while dragging.
	 *
	 * Render-only: nothing here is ever patched into `GameDTO`.
	 */
	hoveredStack?: string[] | null;
	/**
	 * Alt held: the pending drop opts out of the loose-stack square-up and
	 * commits at the raw pointer point. Read by both the drop indicator and
	 * the commit, so preview and landing can't disagree.
	 */
	noSnap?: boolean;
	/**
	 * Where the dragged entity sat before it was picked up, so Esc can put it
	 * back. Only set for entities that were already on the table — a card
	 * drawn out of a deck or tray has no table origin to return to.
	 */
	origin?: [number, number, number];
	/**
	 * The rest of a group drag: every other selected entity, carried at its
	 * offset from `isDragging` (the lead — the one the pointer grabbed). Empty
	 * for an ordinary one-entity drag. A group drop lands on the table only —
	 * decks, bags and the hand take one thing at a time — and each member
	 * resolves its own snap (see utils/transforms/group-drop.ts).
	 */
	group?: GroupMember[];
}

const initialState: DragState = {
	isDragging: null,
	isHovered: null,
	isDeckHovered: null,
	isBagHovered: null,
	isTrayHovered: false,
	isPreview: false,
	dragHeight: undefined,
	intersectionPoint: undefined,
	origin: undefined,
	hoveredStack: null,
	noSnap: false,
	group: []
};

const dragStore = writable<DragState>(initialState);

/**
 * The followers a drag of `id` carries: the rest of the selection, when `id`
 * is in it. Only an entity already on the table (one with an origin) leads a
 * group — a card drawn out of a deck or the hand is never selected.
 */
function groupFor(id: string, origin: Vec3 | undefined): GroupMember[] {
	if (!origin) return [];
	const selected = currentSelection();
	if (!selected.includes(id)) return [];
	const state = get(gameStore);
	const [lx = 0, , lz = 0] = origin;
	return selected.flatMap((other) => {
		if (other === id) return [];
		// in someone else's hand: it stays with them, the rest still comes along
		if (heldByOther(state, other)) return [];
		const position = state?.[collectionOf(other)]?.[other]?.position as Vec3 | undefined;
		if (!position) return [];
		const [x = 0, , z = 0] = position;
		return [{ id: other, offset: [x - lx, z - lz] as [number, number], origin: position }];
	});
}

/**
 * Start dragging a card — and, when it is selected, the rest of the
 * selection. Refused (false, with a toast naming the holder) when another
 * player is carrying `id` right now (tableplace-199).
 */
function dragStart(id: string, height: number, origin?: [number, number, number]): boolean {
	const holder = heldByOther(get(gameStore), id);
	if (holder) {
		toastHeld(holder);
		return false;
	}
	const group = groupFor(id, origin);
	// grabbing something outside the selection lets go of the selection, the
	// way every desktop does. Only a table entity: drawing a card off a deck
	// or out of the hand leaves the selection alone.
	if (origin && group.length === 0 && currentSelection().length) clearSelection();
	dragStore.update((state) => ({
		...state,
		isDragging: id,
		isHovered: id,
		dragHeight: height,
		origin,
		group,
		// the pile you just picked a card out of is no longer a pile to preview
		hoveredStack: null
	}));
	return true;
}

/** every id a drag is carrying: the lead, then its group */
function carriedIds(state: Pick<DragState, 'isDragging' | 'group'>): string[] {
	if (!state.isDragging) return [];
	return [state.isDragging, ...(state.group ?? []).map((member) => member.id)];
}

/** is `id` in the pointer's hand right now — as the lead or as part of its group? */
function isCarried(state: Pick<DragState, 'isDragging' | 'group'>, id: string): boolean {
	return state.isDragging === id || !!state.group?.some((member) => member.id === id);
}

/** the height a carried entity floats at, by its kind */
function carryY(id: string): number {
	return id.startsWith('piece:') ? PIECE_DRAG_Y : CARD_DRAG_Y;
}

/**
 * The one patch a pointer move writes while carrying: the lead under the
 * pointer, every group member at its offset from it — all in the SAME patch,
 * so a group drag puts exactly as many messages on the wire as a single drag
 * does (the throttle in websocket/storeIntegration.ts coalesces by patch, not
 * by entity). Each member is clamped on its own, the same clamp the drop
 * commits with, so nothing tracks somewhere it could not land.
 *
 * Every carried entity is stamped `heldBy` with this client's id in the same
 * patch (tableplace-199) — the hold rides the move, never a message of its own,
 * and re-sending it with each position means a peer who joins mid-drag, or a
 * coalesced first frame, still learns who has it. The drop clears it.
 */
function carryPatch(
	state: Pick<DragState, 'isDragging' | 'group'>,
	x: number,
	z: number
): Partial<GameDTO> | null {
	const lead = state.isDragging;
	if (!lead) return null;
	const patch: Record<string, Record<string, { position: Vec3; heldBy?: string }>> = {};
	const me = myHoldId();
	const place = (id: string, px: number, pz: number) => {
		const [cx, cz] = clampToTable(px, pz);
		(patch[collectionOf(id)] ??= {})[id] = {
			position: [cx, carryY(id), cz],
			...(me ? { heldBy: me } : {})
		};
	};
	place(lead, x, z);
	for (const member of state.group ?? [])
		place(member.id, x + member.offset[0], z + member.offset[1]);
	return patch as Partial<GameDTO>;
}

// Update intersection point during drag
function updateIntersection(point: Vector3) {
	dragStore.update((state) => {
		// Only update if we're actually dragging
		if (!state.isDragging) return state;

		return {
			...state,
			intersectionPoint: point
		};
	});
}

// End dragging and reset state
function dragEnd() {
	dragStore.update((state) => ({ ...state, isDragging: null, origin: undefined, group: [] }));
}

// Set hover state, and with it the loose stack the hovered card belongs to —
// membership comes from `collectStackGroup`, the same set `G` groups, so the
// fan preview can never disagree with the action.
function setHover(id: string | null) {
	dragStore.update((state) => {
		if (state.isDragging) return state; // hover is frozen mid-drag
		const group = id ? collectStackGroup(get(gameStore)?.cards, id) : null;
		return {
			...state,
			isHovered: id,
			// a lone card is a valid group but has nothing to fan
			hoveredStack: group && group.ids.length > 1 ? group.ids : null
		};
	});
}

/**
 * Drop the hover when the pointer leaves `id`.
 *
 * Guarded on the id: fanning moves cards, so a leave can arrive after the
 * pointer has already entered the next member of the same pile, and an
 * unguarded clear would drop that fresh hover on the floor.
 */
function clearHover(id: string) {
	dragStore.update((state) =>
		state.isHovered === id ? { ...state, isHovered: null, hoveredStack: null } : state
	);
}

/** Alt held — see `DragState.noSnap`. Cheap enough to write on every keypress. */
function setNoSnap(noSnap: boolean) {
	dragStore.update((state) => (state.noSnap === noSnap ? state : { ...state, noSnap }));
}

function setTrayHover(isTrayHovered: boolean) {
	dragStore.update((state) => ({
		...state,
		isTrayHovered
	}));
}

function setDeckHover(deckId: string | null) {
	dragStore.update((state) => ({
		...state,
		isDeckHovered: deckId
	}));
}

/**
 * Pointer over a bag. Guarded on the id when clearing, like `clearHover`: two
 * bags side by side deliver the second enter before the first leave, and an
 * unguarded clear would drop the fresh target.
 */
function setBagHover(bagId: string | null) {
	dragStore.update((state) => ({ ...state, isBagHovered: bagId }));
}

function clearBagHover(bagId: string) {
	dragStore.update((state) =>
		state.isBagHovered === bagId ? { ...state, isBagHovered: null } : state
	);
}

// Create store actions object
const dragActions = {
	subscribe: dragStore.subscribe,
	start: dragStart,
	end: dragEnd,
	hover: setHover,
	clearHover,
	trayHover: setTrayHover,
	updateIntersection,
	reset: () => dragStore.set(initialState)
};

// Export all public API
export {
	dragStore,
	dragStart,
	dragEnd,
	setHover,
	clearHover,
	setNoSnap,
	setDeckHover,
	setBagHover,
	clearBagHover,
	setTrayHover,
	updateIntersection,
	dragActions,
	carriedIds,
	isCarried,
	carryPatch,
	type DragState
};
