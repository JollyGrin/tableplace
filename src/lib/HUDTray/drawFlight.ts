/**
 * Deck → hand flights (tableplace-194). A card drawn into your hand should be
 * seen leaving the deck, but the hand is a separate HUD scene with its own
 * orthographic camera, and the deck lives in the table scene. So the drawer
 * records WHERE on the table each card came from, and the TrayCard that mounts
 * for it projects that point through the table camera into its own space and
 * glides home from there.
 *
 * Local only: a flight is never synced. Remote players see what they always
 * see — the deck count drop and the hand count rise.
 */

import type * as THREE from 'three';

export type Flight = {
	/** world point on the table the card starts from (the deck's top) */
	from: [number, number, number];
	/** ms to sit on the deck before leaving — staggers a multi-card draw */
	delayMs: number;
};

/** how long one card takes to reach its slot */
export const FLIGHT_MS = 420;
/** gap between cards of one multi-card draw leaving the deck */
export const FLIGHT_STAGGER_MS = 110;
/** unclaimed flights older than this are stale — the tray never mounted them */
const FLIGHT_TTL_MS = 2000;

const pending = new Map<string, Flight & { at: number }>();

let tableCamera: (() => THREE.Camera | undefined) | undefined;

/** TableScene hands over its camera once; returns the unregister, for `onMount` */
export function registerTableCamera(getter: () => THREE.Camera | undefined): () => void {
	tableCamera = getter;
	return () => {
		if (tableCamera === getter) tableCamera = undefined;
	};
}

export function getTableCamera(): THREE.Camera | undefined {
	return tableCamera?.();
}

/** Queue flights for cards about to appear in the hand, in draw order. */
export function launchFlights(cardIds: string[], from: [number, number, number]) {
	const at = Date.now();
	for (const [cardId, flight] of pending) {
		if (at - flight.at > FLIGHT_TTL_MS) pending.delete(cardId);
	}
	cardIds.forEach((cardId, index) =>
		pending.set(cardId, { from, delayMs: index * FLIGHT_STAGGER_MS, at })
	);
}

/** One-shot: the TrayCard that mounts for `cardId` takes its flight, if any. */
export function takeFlight(cardId: string): Flight | undefined {
	const flight = pending.get(cardId);
	pending.delete(cardId);
	if (!flight || Date.now() - flight.at > FLIGHT_TTL_MS) return undefined;
	return { from: flight.from, delayMs: flight.delayMs };
}

export function prefersReducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
