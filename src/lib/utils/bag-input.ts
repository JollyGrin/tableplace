import type { IntersectionEvent } from '@threlte/extras';
import { createSingleDispatchGuard } from './single-hit-dispatch';
import { DRAG_THRESHOLD_PX } from './counter-input';

export type BagInputDeps = {
	/** the piece these handlers belong to (a getter: it's a component prop) */
	id: () => string;
	/** only bags draw; every other kind ignores this input entirely */
	isBag: () => boolean;
	/** true once this pointer press travelled far enough to become a drag */
	wasDrag: () => boolean;
	/** gameActions.drawFromBag, injected so the input logic is testable */
	draw: (id: string) => unknown;
};

/**
 * Click a bag to draw one item out of it — the same shape as
 * `createCounterInput`, and for the same reason: a bag group has several
 * raycastable children (pouch, neck, count label), and Threlte queues the group
 * once per child the ray pierces, so an unguarded handler would draw two or
 * three items per click (tableplace-84).
 *
 * Claiming happens before the drag-threshold check, again matching the counter:
 * bailing out first would leak the event to the duplicate dispatch entry, which
 * would then draw.
 */
export function createBagInput({ id, isBag, wasDrag, draw }: BagInputDeps) {
	const claimDispatch = createSingleDispatchGuard();

	function drawOnce(e: IntersectionEvent<MouseEvent>): void {
		if (!isBag()) return;
		if (!claimDispatch(e)) return;
		// a press that turned into a drag moved the bag; it didn't ask for a draw
		if (wasDrag() || e.delta > DRAG_THRESHOLD_PX) return;
		draw(id());
	}

	return {
		onclick: drawOnce
	};
}
