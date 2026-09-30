/**
 * The opener, driven the way a hand drives it: press, maybe move, maybe wait,
 * release. Every branch here is a promise made to an existing gesture — a right
 * drag still belongs to the camera, a left drag still belongs to the entity —
 * so they are pinned rather than described.
 *
 * The options are stubbed to a spy wheel: what an option DOES is actions.ts's
 * test, what fires it is this one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const run = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
vi.mock('../actions', () => ({
	radialOptions: () => run.map((fn, index) => ({ id: `w${index}`, label: `w${index}`, run: fn })),
	radialTitle: () => 'Card'
}));

const { armRadialPress, cancelRadialPress, RADIAL_HOLD_MS } = await import('../gesture');
const { radialMenu, registerRadialSurface } = await import('$lib/store/radialUi');
const { dragStore } = await import('$lib/store/dragStore.svelte');
const { hoveredPiece } = await import('$lib/store/pieceUi');

const ORIGIN = { x: 400, y: 300 };
const target = { kind: 'card', id: 'card:me:AS' } as const;

/** jsdom has no PointerEvent; every field the gesture reads lives on MouseEvent */
function pointer(type: string, x: number, y: number, button = 0) {
	return new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true });
}

function press(button: number, options: { holdMs?: number; onOpen?: () => void } = {}) {
	armRadialPress({
		target,
		event: pointer('pointerdown', ORIGIN.x, ORIGIN.y, button) as unknown as PointerEvent,
		...options
	});
}

const move = (x: number, y: number) => window.dispatchEvent(pointer('pointermove', x, y));
const release = (x: number, y: number, button = 0) =>
	window.dispatchEvent(pointer('pointerup', x, y, button));

/** a route with the overlay mounted — without one the gesture is inert by design */
let unmount: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	run.forEach((fn) => fn.mockClear());
	unmount = registerRadialSurface();
});

afterEach(() => {
	unmount();
	cancelRadialPress();
	radialMenu.set(null);
	hoveredPiece.set(null);
	dragStore.update((state) => ({ ...state, isDragging: null }));
	vi.useRealTimers();
});

describe('right button', () => {
	it('opens the flick wheel once the press has held still', () => {
		press(2);
		expect(get(radialMenu)).toBeNull();
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		expect(get(radialMenu)?.mode).toBe('flick');
		expect(get(radialMenu)?.target).toEqual(target);
	});

	it('yields to the camera pan when the press travels first', () => {
		press(2);
		move(ORIGIN.x + 40, ORIGIN.y);
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 4);
		expect(get(radialMenu)).toBeNull();
	});

	it('sticks the wheel up on a quick click, and keeps it up after the release', () => {
		press(2);
		release(ORIGIN.x, ORIGIN.y, 2);
		expect(get(radialMenu)?.mode).toBe('sticky');
		// a stray pointerup elsewhere must not fire a wedge in sticky mode
		release(ORIGIN.x, ORIGIN.y - 90, 2);
		expect(get(radialMenu)?.mode).toBe('sticky');
		expect(run[0]).not.toHaveBeenCalled();
	});
});

describe('left button', () => {
	it('opens the same wheel on a long press', () => {
		press(0);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		expect(get(radialMenu)?.mode).toBe('flick');
	});

	it('lets the entity drag proceed when the press travels first — and tells it so', () => {
		const onOpen = vi.fn();
		press(0, { onOpen });
		move(ORIGIN.x, ORIGIN.y + 20);
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 4);
		expect(get(radialMenu)).toBeNull();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('abandons the entity gesture when the wheel does open', () => {
		const onOpen = vi.fn();
		press(0, { onOpen });
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('does nothing at all on a quick click', () => {
		press(0);
		release(ORIGIN.x, ORIGIN.y);
		expect(get(radialMenu)).toBeNull();
	});

	it('holds for the same beat whatever was pressed — one opener, no per-kind timing', () => {
		// the caller CAN override, but nothing in the app does any more: the deck's
		// 800ms special case died with its hold-to-move arm
		press(0);
		vi.advanceTimersByTime(RADIAL_HOLD_MS - 50);
		expect(get(radialMenu)).toBeNull();
		vi.advanceTimersByTime(50);
		expect(get(radialMenu)?.mode).toBe('flick');
	});
});

describe('the flick', () => {
	beforeEach(() => {
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
	});

	it('highlights the wedge the pointer is aimed at', () => {
		move(ORIGIN.x, ORIGIN.y - 90);
		expect(get(radialMenu)?.hover).toBe(0);
		move(ORIGIN.x + 90, ORIGIN.y);
		expect(get(radialMenu)?.hover).toBe(1);
		move(ORIGIN.x, ORIGIN.y);
		expect(get(radialMenu)?.hover).toBeNull();
	});

	it('fires exactly one action on release, and closes', () => {
		move(ORIGIN.x + 90, ORIGIN.y);
		release(ORIGIN.x + 90, ORIGIN.y, 2);
		expect(run[1]).toHaveBeenCalledTimes(1);
		expect(run[0]).not.toHaveBeenCalled();
		expect(get(radialMenu)).toBeNull();
	});

	it('judges the release position, not the last move it happened to see', () => {
		move(ORIGIN.x + 90, ORIGIN.y);
		release(ORIGIN.x, ORIGIN.y - 90, 2);
		expect(run[0]).toHaveBeenCalledTimes(1);
		expect(run[1]).not.toHaveBeenCalled();
	});

	it('does nothing when released in the deadzone', () => {
		move(ORIGIN.x, ORIGIN.y - 90);
		release(ORIGIN.x + 2, ORIGIN.y, 2);
		expect(run.some((fn) => fn.mock.calls.length)).toBe(false);
		expect(get(radialMenu)).toBeNull();
	});

	it('ignores the other button letting go mid-gesture', () => {
		move(ORIGIN.x, ORIGIN.y - 90);
		release(ORIGIN.x, ORIGIN.y - 90, 0);
		expect(get(radialMenu)).not.toBeNull();
		expect(run[0]).not.toHaveBeenCalled();
	});

	it('closes on Escape without acting', () => {
		move(ORIGIN.x, ORIGIN.y - 90);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(get(radialMenu)).toBeNull();
		expect(run[0]).not.toHaveBeenCalled();
		// and the flick listeners are gone with it — a later release fires nothing
		release(ORIGIN.x, ORIGIN.y - 90, 2);
		expect(run[0]).not.toHaveBeenCalled();
	});
});

/**
 * `pointermove` delivery is rAF-aligned, so on a slow-framed client the first
 * move of a drag can reach the page after the hold timer has already fired —
 * tableplace-103 learned this the hard way with the deck's arm timer, and the
 * headless harness reproduces it every time (a right quick-drag on a table with
 * a 52-card deck opened the wheel instead of panning). The fix is to judge by
 * EVENT time: a move that happened during the hold is a drag, however late it
 * arrives, and the wheel leaves without acting.
 */
describe('a late-delivered move', () => {
	function at(type: string, x: number, y: number, button: number, timeStamp: number) {
		const event = pointer(type, x, y, button);
		Object.defineProperty(event, 'timeStamp', { value: timeStamp });
		return event;
	}

	function pressAt(timeStamp: number) {
		armRadialPress({
			target,
			event: at('pointerdown', ORIGIN.x, ORIGIN.y, 2, timeStamp) as unknown as PointerEvent
		});
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
	}

	it('takes the wheel back down when the travel happened during the hold', () => {
		pressAt(1000);
		expect(get(radialMenu)).not.toBeNull();
		// delivered now, but it HAPPENED 100ms into the hold
		window.dispatchEvent(at('pointermove', ORIGIN.x + 120, ORIGIN.y, -1, 1100));
		expect(get(radialMenu)).toBeNull();
		expect(run.some((fn) => fn.mock.calls.length)).toBe(false);
	});

	it('leaves a genuine flick alone', () => {
		pressAt(1000);
		window.dispatchEvent(at('pointermove', ORIGIN.x, ORIGIN.y - 120, -1, 1400));
		expect(get(radialMenu)?.hover).toBe(0);
		window.dispatchEvent(at('pointerup', ORIGIN.x, ORIGIN.y - 120, 2, 1450));
		expect(run[0]).toHaveBeenCalledTimes(1);
	});
});

/**
 * The render harness caught this class on CI and nowhere else: under a stalled
 * renderer, input a hand delivered in one order reaches the page in another,
 * and a wheel that opened over a live drag left an entity stuck at drag height
 * because the release that should have dropped it went somewhere else.
 *
 * Timing cannot be tested by waiting for it, so the orderings are dispatched
 * directly here. The rule they pin is absolute: while ANYTHING is being
 * dragged, this module holds no listeners, opens nothing, and fires nothing.
 */
describe('a drag in flight always wins', () => {
	const lift = (id = 'piece:me:token') =>
		dragStore.update((state) => ({ ...state, isDragging: id }));

	it('drops a pending press the moment a drag starts, however late the timer is', () => {
		press(0);
		lift(); // the entity lifted under this very press
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 4);
		expect(get(radialMenu)).toBeNull();
	});

	it('takes an open wheel down the moment a drag starts, without acting', () => {
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		expect(get(radialMenu)).not.toBeNull();
		lift();
		expect(get(radialMenu)).toBeNull();
		expect(run.some((fn) => fn.mock.calls.length)).toBe(false);
	});

	it('leaves the release to the drop, not to a wedge', () => {
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		move(ORIGIN.x, ORIGIN.y - 90);
		// the wheel is up and aimed at a wedge when a drag appears from under it
		lift();
		release(ORIGIN.x, ORIGIN.y - 90, 2);
		expect(run.some((fn) => fn.mock.calls.length)).toBe(false);
		expect(get(radialMenu)).toBeNull();
	});

	it('stops listening to the window entirely while a drag is live', () => {
		const listen = vi.spyOn(window, 'addEventListener');
		press(0);
		lift();
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 2);
		// whatever it attached while arming, it has taken back off: a later move
		// or release cannot reach it
		move(ORIGIN.x + 200, ORIGIN.y);
		release(ORIGIN.x + 200, ORIGIN.y);
		expect(get(radialMenu)).toBeNull();
		expect(run.some((fn) => fn.mock.calls.length)).toBe(false);
		listen.mockRestore();
	});
});

describe('presses that must not open anything', () => {
	it('stays out of the way mid-drag', () => {
		dragStore.update((state) => ({ ...state, isDragging: 'card:me:KH' }));
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 2);
		expect(get(radialMenu)).toBeNull();
	});

	it('leaves a piece its own wheel — the felt behind it must not answer', () => {
		hoveredPiece.set('piece:me:bag');
		armRadialPress({
			target: { kind: 'table' },
			event: pointer('pointerdown', ORIGIN.x, ORIGIN.y, 2) as unknown as PointerEvent
		});
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 2);
		expect(get(radialMenu)).toBeNull();
	});

	it('stays inert on a route with no wheel to draw it (the /create preview)', () => {
		unmount();
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 2);
		expect(get(radialMenu)).toBeNull();
		unmount = registerRadialSurface(); // afterEach unmounts once
	});

	it('ignores the middle button', () => {
		press(1);
		vi.advanceTimersByTime(RADIAL_HOLD_MS * 4);
		expect(get(radialMenu)).toBeNull();
	});

	it('does not stack a second wheel on top of an open one', () => {
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		const first = get(radialMenu);
		press(2);
		vi.advanceTimersByTime(RADIAL_HOLD_MS);
		expect(get(radialMenu)).toBe(first);
	});
});
