/**
 * tableplace-271: a piece drag left its id in `dragStore.isHovered`, the verb
 * walk offered it as a card, and F on a bare token wrote a position-less card
 * keyed by the piece's id. Both layers are pinned: the stale hover, and the
 * action that must never create an entity out of a foreign id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { dragStore, dragActions } from '$lib/store/dragStore.svelte';
import { targetsUnder } from '$lib/verbs/keyboard';

vi.mock('svelte-french-toast', () => ({
	default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}));

const { gameActions } = await import('$lib/store/game/actions');

const PIECE = 'piece:p1:xeno-0';

beforeEach(() => {
	dragStore.set({ ...get(dragStore), isHovered: null, isDragging: null, group: [] });
});

describe('stale piece hover', () => {
	it('is cleared when the drag ends', () => {
		dragActions.start(PIECE, 0.2);
		dragActions.end();
		expect(get(dragStore).isHovered).toBeNull();
	});

	it('is never offered as a card target', () => {
		const targets = targetsUnder(
			{ isDeckHovered: null, isHovered: PIECE, isDragging: null },
			null,
			null
		);
		expect(targets.some((t) => t.kind === 'card')).toBe(false);
	});
});

describe('card actions refuse unknown ids', () => {
	it('flip, tap and raise create nothing', () => {
		const before = Object.keys(get(gameStore)?.cards ?? {});
		gameActions.flipCard(PIECE);
		gameActions.tapCard(false, PIECE);
		gameActions.incrementHeight(0.1, PIECE);
		expect(Object.keys(get(gameStore)?.cards ?? {})).toEqual(before);
		expect(get(gameStore)?.cards?.[PIECE]).toBeUndefined();
	});
});
