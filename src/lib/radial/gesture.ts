/**
 * The opener state machine: one press, two entry points, three outcomes.
 *
 *   right press → travel               → camera pan (we let go, OrbitControls
 *                                        never knew we were interested)
 *   right press → held still ~200ms    → flick wheel (move to a wedge, release)
 *   right press → quick release        → sticky wheel (move, then click)
 *   left  press → travel               → the entity's own drag, untouched
 *   left  press → held still           → flick wheel
 *
 * The entity only calls `armRadialPress` from its pointerdown and hands over a
 * way to abandon its own pending gesture (`onOpen`). Everything after that —
 * the timer, the movement veto, the highlight, the release — lives here on
 * window listeners, because a flick leaves the entity's pixel immediately and
 * OrbitControls captures the pointer to the canvas for the rest of the gesture.
 *
 * Nothing here reads a hover store to decide WHAT to act on: the target is
 * whatever the press landed on, carried through to the options (see actions.ts).
 * The one hover read is a veto — a piece under the pointer opens its own
 * wheel, so the felt behind it must not open the table's over the top of it.
 */

import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { hoveredPiece } from '$lib/store/pieceUi';
import {
	closeRadialMenu,
	hasRadialSurface,
	openRadialMenu,
	radialMenu,
	setRadialHover
} from '$lib/store/radialUi';
import { radialOptions, type RadialTarget } from './actions';
import { selectWedge } from './geometry';

/**
 * How long a press must hold still to become a wheel — ONE number, for every
 * button and every kind of thing you can press.
 *
 * It was briefly three: the deck held its long press for the pile move
 * (tableplace-103), so the wheel had to wait that out at 800ms while a card
 * answered at 350. A gesture whose timing depends on what is underneath it is
 * a gesture nobody can learn. The pile move has moved onto the wheel itself
 * (the "Move pile" wedge), which freed the slot — press and hold anything for
 * this long and you get its verbs.
 */
export const RADIAL_HOLD_MS = 400;
/** travel that vetoes the wheel — same threshold every drag in the app uses */
export const RADIAL_MOVE_CANCEL_PX = 5;

/**
 * While a press is PENDING, movement is watched on `pointerrawupdate` as well
 * as `pointermove`, because `pointermove` delivery is rAF-aligned: on a
 * slow-framed client (a big table under software GL) a flick's first move can
 * be handed to the page AFTER the hold timer has fired, and the wheel would
 * open over a gesture that had visibly moved. Raw updates are not frame-gated,
 * which is what they exist for.
 *
 * Deliberately scoped to the pending window only — a raw-update listener
 * changes how Chrome delivers pointer input to the WHOLE page, and this module
 * has no business perturbing that a millisecond longer than the ~200-800ms it
 * is deciding what a press meant. Once a wheel is open, plain `pointermove`
 * plus the event-time veto below is enough. And no listener of either kind
 * survives the start of a drag (see the drag watch).
 */
// `pointerrawupdate` is not in lib.dom's WindowEventMap, so these are typed as
// plain strings and the listeners as EventListener
const PENDING_MOVE_EVENTS = ['pointerrawupdate', 'pointermove'];
const WHEEL_MOVE_EVENTS = ['pointermove'];

/**
 * How late the hold timer may fire and still be believed. A timer that runs
 * well past its deadline ran behind a busy main thread, and whatever the
 * pointer did during that stall is still QUEUED — raw updates included, since
 * they wait for the thread like any other task. Opening then decides the
 * gesture on input the page has not been handed yet: the wheel opens, the
 * entity abandons its lift (`onOpen`), and the travel that arrives a moment
 * later can only veto the wheel, not give the drag back (tableplace-245).
 * A late timer waits one frame instead: Blink dispatches queued pointer input
 * at the start of a frame, before its animation callbacks, so by then any
 * travel has reached `onPendingMove` and dropped the press.
 */
const HOLD_LATE_MS = 50;

type Pending = {
	target: RadialTarget;
	button: number;
	x: number;
	y: number;
	/** event time of the press — see the veto in onWheelMove */
	pressedAt: number;
	holdMs: number;
	onOpen?: () => void;
	timer: ReturnType<typeof setTimeout> | null;
	/** the frame a late hold timer waits for before deciding (see HOLD_LATE_MS) */
	frame: number | null;
};

let pending: Pending | null = null;
/** the press a wheel is open for; null while nothing is up */
let opened: Pending | null = null;
/** the button that opened a flick wheel — only its release decides */
let flickButton: number | null = null;
let unwatch: (() => void) | null = null;
let dragWatch: (() => void) | null = null;

/**
 * A drag in flight beats the wheel, in every ordering.
 *
 * Checking `isDragging` when the press is armed is not enough: the drag it has
 * to yield to may not exist yet. A card lifts on its first travel, a deck's
 * pile move arms on a hold, and — the case that matters — on a stalled
 * renderer those events can reach the page in an order no hand produced. So
 * instead of asking once, this watches the drag store for the whole life of a
 * press and of an open wheel, and the moment anything starts dragging the
 * press is dropped, the wheel goes away without acting, and every listener
 * this module owns comes off the window.
 *
 * That is the invariant the render harness cares about: while an entity is in
 * the air, this file is not participating in input at all.
 */
function startDragWatch() {
	dragWatch?.();
	dragWatch = dragStore.subscribe((state) => {
		if (!state.isDragging) return;
		clearPending();
		if (get(radialMenu)) closeRadialMenu();
	});
}

function stopDragWatch() {
	const stop = dragWatch;
	dragWatch = null;
	stop?.();
}

function clearPending() {
	if (pending?.timer) clearTimeout(pending.timer);
	if (pending?.frame) cancelAnimationFrame(pending.frame);
	pending = null;
	for (const name of PENDING_MOVE_EVENTS)
		window.removeEventListener(name, onPendingMove as EventListener);
	window.removeEventListener('pointerup', onPendingUp);
	window.removeEventListener('pointercancel', onPendingCancel);
	// the open wheel keeps the watch alive; nothing pending and nothing open
	// means this module is fully detached
	if (!get(radialMenu)) stopDragWatch();
}

function onPendingMove(event: PointerEvent) {
	if (!pending) return;
	const travel = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
	if (travel < RADIAL_MOVE_CANCEL_PX) return;
	// the gesture is a drag (entity) or a pan (camera) — hand it back untouched
	clearPending();
}

function onPendingUp(event: PointerEvent) {
	if (!pending || event.button !== pending.button) return;
	const press = pending;
	clearPending();
	if (press.button !== 2) return; // a quick left click is just a click
	if (!canOpen(press)) return;
	// the sticky wheel is only vetoed by movement that happened while the button
	// was DOWN — after the release, moving toward a wedge is the whole point
	press.holdMs = Math.max(0, event.timeStamp - press.pressedAt);
	// a quick right-click leaves the wheel up
	open(press, 'sticky');
}

function onPendingCancel() {
	clearPending();
}

/**
 * Re-asked at OPEN time, not just when the press was armed: everything it
 * tests can change during the hold — a card can lift under the same press, a
 * piece can come under the pointer — and opening on a stale answer is how a
 * wheel ends up on top of a live drag.
 */
function canOpen(press: Pending): boolean {
	if (get(dragStore).isDragging) return false;
	if (press.target.kind === 'table' && get(hoveredPiece)) return false;
	return hasRadialSurface() && !get(radialMenu);
}

function open(press: Pending, mode: 'flick' | 'sticky') {
	// the entity abandons whatever it armed (a pending card lift, the deck's
	// move arm, the felt's snap-point click) — the wheel owns the gesture now
	press.onOpen?.();
	opened = press;
	openRadialMenu({
		target: press.target,
		mode,
		x: press.x,
		y: press.y,
		options: radialOptions(press.target)
	});
	for (const name of WHEEL_MOVE_EVENTS) window.addEventListener(name, onWheelMove as EventListener);
	if (mode === 'flick') {
		flickButton = press.button;
		window.addEventListener('pointerup', onWheelUp);
		window.addEventListener('pointercancel', dismiss);
	}
	window.addEventListener('keydown', onWheelKey);
	// whoever closes the menu — a wedge, the click-away catcher, an entity that
	// vanished — takes these listeners down with it
	unwatch?.();
	unwatch = radialMenu.subscribe((menu) => {
		if (!menu) detach();
	});
	// the open wheel inherits the watch — clearPending drops it on the way in
	// here, since at that instant there is neither a press nor a menu
	startDragWatch();
}

function detach() {
	flickButton = null;
	opened = null;
	for (const name of WHEEL_MOVE_EVENTS)
		window.removeEventListener(name, onWheelMove as EventListener);
	window.removeEventListener('pointerup', onWheelUp);
	window.removeEventListener('pointercancel', dismiss);
	window.removeEventListener('keydown', onWheelKey);
	const stop = unwatch;
	unwatch = null;
	stop?.();
	if (!pending) stopDragWatch();
}

function onWheelMove(event: PointerEvent) {
	const menu = get(radialMenu);
	if (!menu) return;
	const travel = Math.hypot(event.clientX - menu.x, event.clientY - menu.y);
	// Event time, not wall clock — the same lesson tableplace-103 learned about
	// the deck's arm timer. A move that HAPPENED while the press was still
	// supposed to be holding still is a drag whose delivery was late (see
	// MOVE_EVENTS): the wheel should never have opened, so it leaves without
	// acting and the gesture goes back to being a pan or a drag.
	if (
		opened &&
		travel >= RADIAL_MOVE_CANCEL_PX &&
		event.timeStamp - opened.pressedAt < opened.holdMs
	) {
		dismiss();
		return;
	}
	setRadialHover(selectWedge(event.clientX - menu.x, event.clientY - menu.y, menu.options.length));
}

function onWheelUp(event: PointerEvent) {
	if (flickButton !== null && event.button !== flickButton) return;
	const menu = get(radialMenu);
	if (!menu) return dismiss();
	// a release that ends a DROP is not a wedge choice — the drag watch should
	// already have taken this wheel down, and if ordering ever beats it, the
	// release still belongs to the entity in the air
	if (get(dragStore).isDragging) return dismiss();
	// the release position decides, not the last move we happened to see
	fireRadialOption(
		selectWedge(event.clientX - menu.x, event.clientY - menu.y, menu.options.length)
	);
}

function onWheelKey(event: KeyboardEvent) {
	if (event.key === 'Escape') dismiss();
}

/** close without acting — the deadzone release, Escape, a cancelled pointer */
export function dismiss() {
	closeRadialMenu();
}

/**
 * Run wedge `index` and close. Exported because the sticky wheel's buttons fire
 * the same way a flick release does — one action, one close, whichever it was.
 */
export function fireRadialOption(index: number | null) {
	const menu = get(radialMenu);
	closeRadialMenu();
	if (index === null || !menu) return;
	menu.options[index]?.run();
}

/**
 * Arm a press. Safe to call for any button: only 0 and 2 do anything, and a
 * press that never sits still leaves no trace.
 */
export function armRadialPress(options: {
	target: RadialTarget;
	event: PointerEvent;
	holdMs?: number;
	onOpen?: () => void;
}): void {
	const { target, event, onOpen } = options;
	if (event.button !== 0 && event.button !== 2) return;
	// no overlay on this route (the /create preview): a wheel nobody can see
	// must not fire actions on release
	if (!hasRadialSurface()) return;
	// mid-drag the pointer belongs to the thing in the air
	if (get(dragStore).isDragging) return;
	// a piece opens its own wheel — the felt behind it must not answer for it
	if (target.kind === 'table' && get(hoveredPiece)) return;
	if (get(radialMenu)) return;

	clearPending();
	const holdMs = options.holdMs ?? RADIAL_HOLD_MS;
	const press: Pending = {
		target,
		button: event.button,
		x: event.clientX,
		y: event.clientY,
		pressedAt: event.timeStamp,
		holdMs,
		onOpen,
		timer: null,
		frame: null
	};
	const decide = () => {
		press.frame = null;
		if (pending !== press) return;
		const allowed = canOpen(press);
		clearPending();
		if (allowed) open(press, 'flick');
	};
	const armedAt = performance.now();
	press.timer = setTimeout(() => {
		press.timer = null;
		if (pending !== press) return;
		if (performance.now() - armedAt - holdMs > HOLD_LATE_MS)
			press.frame = requestAnimationFrame(decide);
		else decide();
	}, holdMs);
	pending = press;
	for (const name of PENDING_MOVE_EVENTS)
		window.addEventListener(name, onPendingMove as EventListener);
	window.addEventListener('pointerup', onPendingUp);
	window.addEventListener('pointercancel', onPendingCancel);
	// last, so its immediate replay of the current (drag-free) state cannot
	// tear down the press it is meant to protect
	startDragWatch();
}

/** the entity's own gesture won (it lifted, it armed, it drew) — drop the press */
export function cancelRadialPress(): void {
	clearPending();
}
