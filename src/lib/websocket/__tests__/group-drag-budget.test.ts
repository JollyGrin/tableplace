/**
 * The wire budget of a group drag (tableplace-202 acceptance): dragging ten
 * entities must stay within the 5 Hz a single drag owns. The relay
 * disconnects a client above 7 msg/s sustained, so a drag that sent one
 * message per member per tick would end the session.
 *
 * Driven through the real throttle (`wsWrapperUpdateGameState`) with the real
 * carry patch, at pointer rate, on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const sent: { value: Record<string, Record<string, unknown>> }[] = [];
vi.mock('$lib/websocket/connection', () => ({
	sendMessage: (message: never) => {
		sent.push(message);
		return true;
	}
}));
vi.mock('$lib/utils/transforms/websocket', () => ({
	createWsMetaData: () => ({ playerId: 'me', timestamp: Date.now(), type: 'update' })
}));

import { wsWrapperUpdateGameState } from '../storeIntegration';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { carryPatch, dragActions, dragStart, dragStore } from '$lib/store/dragStore.svelte';
import { clearSelection, setSelection } from '$lib/store/selection';
import { CARD_DRAG_Y } from '$lib/utils/constants-cards';

const TEN = Array.from({ length: 10 }, (_, i) => (i % 2 ? `card:me:${i}` : `piece:me:${i}`));

beforeEach(() => {
	vi.useFakeTimers();
	sent.length = 0;
	dragActions.reset();
	clearSelection();
	const cards: Record<string, unknown> = {};
	const pieces: Record<string, unknown> = {};
	TEN.forEach((id, i) => {
		const entity = { position: [i, 0.3, 0], rotation: [0, 0, 0] };
		if (id.startsWith('piece:')) pieces[id] = { ...entity, kind: 'token' };
		else cards[id] = { ...entity, faceImageUrl: 'f.png' };
	});
	gameStore.set({ players: {}, cards, pieces } as never);
});

afterEach(() => vi.useRealTimers());

describe('a group drag of ten entities', () => {
	it('stays within 5 Hz, and every message carries all ten', () => {
		setSelection(TEN);
		dragStart(TEN[0], CARD_DRAG_Y, [0, 0.3, 0]);
		const update = wsWrapperUpdateGameState((patch: never) => gameStore.updateStateSilently(patch));

		const SECONDS = 4;
		const POINTER_HZ = 60;
		for (let tick = 0; tick < SECONDS * POINTER_HZ; tick++) {
			update(carryPatch(get(dragStore), tick * 0.01, 0));
			vi.advanceTimersByTime(1000 / POINTER_HZ);
		}
		vi.advanceTimersByTime(500); // the trailing send

		// one leading send, then at most one per 200 ms window
		expect(sent.length).toBeGreaterThan(SECONDS * 4);
		expect(sent.length).toBeLessThanOrEqual(SECONDS * 5 + 1);
		for (const message of sent) {
			const ids = [
				...Object.keys(message.value.cards ?? {}),
				...Object.keys(message.value.pieces ?? {})
			];
			expect(ids.sort()).toEqual([...TEN].sort());
		}
	});
});
