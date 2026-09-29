import type { IntersectionEvent } from '@threlte/extras';
import { createSingleDispatchGuard } from './single-hit-dispatch';

/** px the pointer may travel between down and up and still count as a click */
export const DRAG_THRESHOLD_PX = 5;

/** one increment per wheel notch; accumulate so trackpads don't spray them */
const WHEEL_NOTCH = 100;
/** deltaMode 1 reports lines, not pixels — call a notch three lines */
const LINES_PER_NOTCH = 3;

export type CounterInputDeps = {
	/** the piece these handlers belong to (a getter: it's a component prop) */
	id: () => string;
	/** tokens and pawns have no value, so they ignore counter input entirely */
	isCounter: () => boolean;
	/** true once this pointer press travelled far enough to become a drag */
	wasDrag: () => boolean;
	/** gameActions.incrementCounter, injected so the input logic is testable */
	increment: (id: string, delta: number) => void;
};

/**
 * The click / wheel handlers for a counter piece, kept out of
 * Piece.svelte so the single-dispatch guarantee can be tested against a
 * replica of Threlte's dispatch loop (see __tests__/counter-input.test.ts).
 *
 * Every handler claims the event through one per-instance guard, which is what
 * keeps a counter from moving by 2 when the ray pierces two of its child meshes
 * — see createSingleDispatchGuard for why that happens. The guard is claimed
 * before the drag-threshold returns on purpose: bailing out first would leak
 * the event to the duplicate dispatch entry.
 */
export function createCounterInput({ id, isCounter, wasDrag, increment }: CounterInputDeps) {
	const claimDispatch = createSingleDispatchGuard();
	let wheelAccum = 0;

	return {
		onclick(e: IntersectionEvent<MouseEvent>) {
			if (!isCounter()) return;
			if (!claimDispatch(e)) return;
			if (wasDrag() || e.delta > DRAG_THRESHOLD_PX) return; // was a drag, not a click
			// click deals damage; shift (or alt) heals
			const ne = e.nativeEvent;
			increment(id(), ne.shiftKey || ne.altKey ? 1 : -1);
		},

		onwheel(e: IntersectionEvent<WheelEvent>) {
			if (!isCounter()) return;
			e.stopImmediatePropagation(); // don't zoom the camera while adjusting
			if (!claimDispatch(e)) return;
			const ne = e.nativeEvent;
			wheelAccum += ne.deltaMode === 1 ? ne.deltaY * (WHEEL_NOTCH / LINES_PER_NOTCH) : ne.deltaY;
			while (wheelAccum >= WHEEL_NOTCH) {
				wheelAccum -= WHEEL_NOTCH;
				increment(id(), -1);
			}
			while (wheelAccum <= -WHEEL_NOTCH) {
				wheelAccum += WHEEL_NOTCH;
				increment(id(), 1);
			}
		}
	};
}
