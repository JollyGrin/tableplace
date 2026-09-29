/**
 * What each wheel offers, and — the part that is a correctness property rather
 * than a taste question — that every wedge acts on the id the press carried.
 *
 * The hover stores are deliberately left pointing somewhere else in each case:
 * by the time you have flicked to a wedge the pointer has left the entity, so
 * an option that fell back to `isHovered`/`isDeckHovered` would act on whatever
 * the wheel happens to be drawn over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gameActions = {
	getMe: () => ({ id: 'me' }),
	flipCard: vi.fn(),
	tapCard: vi.fn(),
	groupStackIntoDeck: vi.fn(),
	drawFromTop: vi.fn(),
	canDrawToHand: () => true,
	flipDeck: vi.fn(),
	ungroupDeck: vi.fn(() => ({ ok: true, deckId: 'deck:me:0', cardIds: [] }))
};
const shuffleHoveredDeck = vi.fn();
const drawHoveredDeckToHand = vi.fn();
const resetView = vi.fn();
const toggleTopDown = vi.fn();
const focus = vi.fn();

vi.mock('$lib/store/game/actions', () => ({ gameActions }));
vi.mock('$lib/hotkeys/shuffle', () => ({ shuffleHoveredDeck, SHUFFLE_NOT_MINE: 'not yours' }));
vi.mock('$lib/hotkeys/draw', () => ({ drawHoveredDeckToHand, DRAW_NOT_MINE: 'not yours' }));
vi.mock('$lib/utils/transforms/camera', () => ({
	cameraTransforms: { resetView, toggleTopDown, focus }
}));

const { radialOptions, radialTitle } = await import('../actions');

function run(target: Parameters<typeof radialOptions>[0], id: string) {
	const option = radialOptions(target).find((entry) => entry.id === id);
	expect(option, `no ${id} wedge on the ${target.kind} wheel`).toBeTruthy();
	option!.run();
}

beforeEach(() => vi.clearAllMocks());

describe('card wheel', () => {
	const target = { kind: 'card', id: 'card:me:AS' } as const;

	it('offers flip, both taps and group', () => {
		expect(radialOptions(target).map((option) => option.id)).toEqual([
			'flip',
			'tap',
			'tap-reverse',
			'group'
		]);
		expect(radialTitle(target)).toBe('Card');
	});

	it('acts on the pressed card, never the hovered one', () => {
		run(target, 'flip');
		expect(gameActions.flipCard).toHaveBeenCalledWith('card:me:AS');
		run(target, 'tap');
		expect(gameActions.tapCard).toHaveBeenCalledWith(false, 'card:me:AS');
		run(target, 'tap-reverse');
		expect(gameActions.tapCard).toHaveBeenLastCalledWith(true, 'card:me:AS');
		run(target, 'group');
		expect(gameActions.groupStackIntoDeck).toHaveBeenCalledWith('card:me:AS');
	});
});

describe('deck wheel', () => {
	const target = { kind: 'deck', id: 'deck:me:0' } as const;

	it('offers draw to hand, draw to table, flip, shuffle, ungroup and the pile move', () => {
		expect(radialOptions(target).map((option) => option.id)).toEqual([
			'draw',
			'draw-table',
			'flip',
			'shuffle',
			'ungroup',
			// moving a pile is a wedge since tableplace-161 took the long press
			// for the wheel itself — there is no hold-then-drag left to do it
			'move'
		]);
	});

	it('acts on the pressed deck', () => {
		run(target, 'draw');
		// through the wrapper, so the not-yours toast is the key's own
		expect(drawHoveredDeckToHand).toHaveBeenCalledWith('deck:me:0', 1);
		run(target, 'draw-table');
		expect(gameActions.drawFromTop).toHaveBeenCalledWith('deck:me:0', 1);
		run(target, 'flip');
		expect(gameActions.flipDeck).toHaveBeenCalledWith('deck:me:0');
	});

	it('routes shuffle and ungroup through the hotkey wrappers, so the toasts survive', () => {
		run(target, 'shuffle');
		expect(shuffleHoveredDeck).toHaveBeenCalledWith('deck:me:0');
		run(target, 'ungroup');
		// the wrapper is what turns not-mine / empty / too-many into a toast
		expect(gameActions.ungroupDeck).toHaveBeenCalledWith('deck:me:0');
	});
});

describe('table wheel', () => {
	it('offers the camera presets: seat view, top-down, focus', () => {
		const options = radialOptions({ kind: 'table' });
		expect(options.map((option) => option.id)).toEqual(['reset-view', 'top-down', 'focus']);
		options[0]!.run();
		expect(resetView).toHaveBeenCalled();
		options[1]!.run();
		expect(toggleTopDown).toHaveBeenCalled();
		options[2]!.run();
		// the table's focus names nothing: it frames what you moved last
		expect(focus).toHaveBeenCalledWith();
	});

	it('falls back to the table wheel when an entity target lost its id', () => {
		expect(radialOptions({ kind: 'card' }).map((option) => option.id)).toEqual([
			'reset-view',
			'top-down',
			'focus'
		]);
	});
});
