/**
 * Left-drag on bare felt: the selection box (tableplace-202).
 *
 * Armed by the felt's own pointerdown (Table.svelte) — which only ever sees a
 * press nothing on the table claimed — and run on window listeners from
 * there, so a box dragged off the canvas or over a HUD pane still finishes.
 *
 * - travel past the drag threshold → a box; the release selects every entity
 *   whose centre projects inside it (Shift adds to what is already selected);
 * - a release without travel is a click on the felt: it clears the selection
 *   (Shift+click on felt keeps it).
 *
 * Locked entities are never selected (see store/selection). The box itself is
 * a plain DOM rectangle over the canvas: nothing in the scene moves while it
 * is drawn, so there is nothing to render in 3D, and it is gone the moment
 * the button comes up.
 */

import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { addToSelection, clearSelection, isSelectable, setSelection } from '$lib/store/selection';
import { DRAG_THRESHOLD_PX } from '$lib/utils/counter-input';
import type { GameDTO } from '$lib/store/game/types';

export type ScreenPoint = { x: number; y: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** world → client pixels, or null when the point is behind the camera */
export type Project = (world: [number, number, number]) => ScreenPoint | null;

/** the rectangle two corners span, whichever way the drag went */
export function rectBetween(a: ScreenPoint, b: ScreenPoint): ScreenRect {
	return {
		left: Math.min(a.x, b.x),
		top: Math.min(a.y, b.y),
		right: Math.max(a.x, b.x),
		bottom: Math.max(a.y, b.y)
	};
}

/**
 * Every selectable entity whose centre projects inside `rect`: loose cards,
 * decks and pieces, never a locked one. Cards first, then decks, then pieces,
 * each in store order.
 */
export function entitiesInRect(
	state: Partial<GameDTO> | undefined | null,
	rect: ScreenRect,
	project: Project
): string[] {
	const inside: string[] = [];
	for (const collection of ['cards', 'decks', 'pieces'] as const) {
		for (const [id, entity] of Object.entries(state?.[collection] ?? {})) {
			if (!entity || !isSelectable(state, id)) continue;
			const position = (entity as { position?: [number, number, number] }).position;
			if (!position) continue;
			const at = project(position);
			if (!at) continue;
			if (at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom)
				inside.push(id);
		}
	}
	return inside;
}

let active: (() => void) | null = null;

/** the on-screen rectangle, created on the first travel */
function createMarquee(): HTMLDivElement {
	const box = document.createElement('div');
	box.dataset.selectionBox = '';
	Object.assign(box.style, {
		position: 'fixed',
		pointerEvents: 'none',
		zIndex: '40',
		border: '1px solid #5ee7ff',
		background: 'rgba(94, 231, 255, 0.12)',
		borderRadius: '2px'
	});
	document.body.appendChild(box);
	return box;
}

/**
 * Start a box at the press. `project` maps a world point to client pixels
 * with the live camera; it is called once per entity on release, not per move.
 */
export function beginBoxSelect(press: PointerEvent, project: Project) {
	active?.();
	const start = { x: press.clientX, y: press.clientY };
	let marquee: HTMLDivElement | null = null;

	const onMove = (event: PointerEvent) => {
		const at = { x: event.clientX, y: event.clientY };
		if (!marquee && Math.hypot(at.x - start.x, at.y - start.y) < DRAG_THRESHOLD_PX) return;
		marquee ??= createMarquee();
		const rect = rectBetween(start, at);
		Object.assign(marquee.style, {
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.right - rect.left}px`,
			height: `${rect.bottom - rect.top}px`
		});
	};

	const onUp = (event: PointerEvent) => {
		const boxed = !!marquee;
		stop();
		const additive = event.shiftKey;
		if (!boxed) {
			// a click on bare felt lets go of the selection
			if (!additive) clearSelection();
			return;
		}
		const ids = entitiesInRect(
			get(gameStore),
			rectBetween(start, { x: event.clientX, y: event.clientY }),
			project
		);
		if (additive) addToSelection(ids);
		else setSelection(ids);
	};

	// a cancelled pointer (the browser took the gesture) selects nothing
	const onCancel = () => stop();

	function stop() {
		marquee?.remove();
		marquee = null;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onCancel);
		active = null;
	}

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onCancel);
	active = stop;
}
