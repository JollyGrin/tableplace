import { get, writable } from 'svelte/store';
import type { Vector3 } from 'three';
import { MOVE_ENTITY, refuse, refusalToMove } from '$lib/gate';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { collectStackGroup } from '$lib/utils/transforms/stacking';

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
	 * Why the referee refused this drag (tableplace-171), when it did.
	 *
	 * A refused drag still HAPPENS — locally. The entity follows the pointer, and
	 * on release it goes back to `origin` and says why; none of it is broadcast,
	 * so a peer sees nothing at all. Letting the gesture play out is the point:
	 * the table teaches the rule, where an entity that simply would not lift
	 * leaves the player guessing whether the game is refereed or broken.
	 *
	 * Decided once, at the pickup, so the answer cannot change under the pointer
	 * halfway through. Render-only, like everything else here.
	 */
	denied?: string;
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
	denied: undefined,
	hoveredStack: null,
	noSnap: false
};

const dragStore = writable<DragState>(initialState);

// Start dragging a card
function dragStart(id: string, height: number, origin?: [number, number, number]) {
	// The referee gets asked at the PICKUP, not only at the drop: the per-frame
	// positions a drag streams are patches like any other, and a refused gesture
	// that broadcast them would show a peer a move that is about to be undone.
	// `refusalToMove` costs nothing when no validator is registered.
	//
	// Without an origin there is nowhere to snap back TO — a card coming out of a
	// deck or a hand never had a table position — so a refusal there ends the
	// gesture before it starts rather than leaving the entity stranded mid-air.
	const denied = refusalToMove(id) ?? undefined;
	if (denied && !origin) return refuse(MOVE_ENTITY, denied);

	dragStore.update((state) => ({
		...state,
		isDragging: id,
		isHovered: id,
		dragHeight: height,
		origin,
		denied,
		// the pile you just picked a card out of is no longer a pile to preview
		hoveredStack: null
	}));
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
	dragStore.update((state) => ({
		...state,
		isDragging: null,
		origin: undefined,
		denied: undefined
	}));
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
	type DragState
};
