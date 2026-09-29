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
import { gameStore } from '$lib/store/game/gameStore.svelte';

const gameActions = {
	getMe: () => ({ id: 'me' }),
	flipCard: vi.fn(),
	tapCard: vi.fn(),
	groupStackIntoDeck: vi.fn(),
	drawFromTop: vi.fn(),
	flipDeck: vi.fn(),
	ungroupDeck: vi.fn(() => ({ ok: true, deckId: 'deck:me:0', cardIds: [] })),
	cyclePieceState: vi.fn(),
	rotatePiece: vi.fn(),
	setPieceSnap: vi.fn(),
	removePiece: vi.fn(),
	incrementCounter: vi.fn(),
	resetCounter: vi.fn(),
	rollDie: vi.fn(),
	drawFromBag: vi.fn()
};
const shuffleHoveredDeck = vi.fn();
const resetView = vi.fn();

vi.mock('$lib/store/game/actions', () => ({ gameActions }));
vi.mock('$lib/hotkeys/shuffle', () => ({ shuffleHoveredDeck, SHUFFLE_NOT_MINE: 'not yours' }));
vi.mock('$lib/utils/transforms/camera', () => ({ cameraTransforms: { resetView } }));

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

	it('offers draw, flip, shuffle, ungroup and the pile move', () => {
		expect(radialOptions(target).map((option) => option.id)).toEqual([
			'draw',
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
	it('is deliberately sparse, and the layout still has to hold', () => {
		const options = radialOptions({ kind: 'table' });
		expect(options.map((option) => option.id)).toEqual(['reset-view']);
		options[0]!.run();
		expect(resetView).toHaveBeenCalled();
	});

	it('falls back to the table wheel when an entity target lost its id', () => {
		expect(radialOptions({ kind: 'card' }).map((option) => option.id)).toEqual(['reset-view']);
	});
});

describe('piece wheel', () => {
	const face = { face: 'https://example.test/face.png' };
	beforeEach(() =>
		gameStore.set({
			pieces: {
				'piece:me:tile': {
					kind: 'token',
					name: 'Tile',
					position: [0, 0, 0],
					states: [face, face, face]
				},
				'piece:me:model': { kind: 'model', position: [0, 0, 0] },
				'piece:me:tally': { kind: 'counter', position: [0, 0, 0], maxValue: 9 },
				'piece:me:pouch': { kind: 'bag', position: [0, 0, 0] },
				'piece:me:die': { kind: 'die', position: [0, 0, 0] }
			}
		} as never)
	);
	const wheel = (id: string) => radialOptions({ kind: 'piece', id });
	const printed = (id: string) =>
		Object.fromEntries(wheel(id).map((option) => [option.id, option.key ?? null]));

	it('a multi-state piece cycles its state, each wedge printed with its key', () => {
		expect(printed('piece:me:tile')).toEqual({ 'state-next': 'X', 'state-prev': 'Shift + X' });
		expect(radialTitle({ kind: 'piece', id: 'piece:me:tile' })).toBe('Tile');
		run({ kind: 'piece', id: 'piece:me:tile' }, 'state-next');
		expect(gameActions.cyclePieceState).toHaveBeenCalledWith('piece:me:tile', 1);
	});

	it('a model rotates, toggles its snap and can be removed', () => {
		expect(printed('piece:me:model')).toEqual({
			'rotate-cw': 'T',
			'rotate-ccw': 'R',
			'snap-toggle': null,
			remove: null
		});
		expect(radialTitle({ kind: 'piece', id: 'piece:me:model' })).toBe('Piece');
		run({ kind: 'piece', id: 'piece:me:model' }, 'snap-toggle');
		expect(gameActions.setPieceSnap).toHaveBeenCalledWith('piece:me:model', false);
		run({ kind: 'piece', id: 'piece:me:model' }, 'remove');
		expect(gameActions.removePiece).toHaveBeenCalledWith('piece:me:model');
	});

	it('a counter gets +1, −1 and reset; a bag draws; a die rolls', () => {
		expect(printed('piece:me:tally')).toEqual({
			'count-up': 'Shift+click',
			'count-down': 'click',
			'count-reset': null
		});
		run({ kind: 'piece', id: 'piece:me:tally' }, 'count-up');
		expect(gameActions.incrementCounter).toHaveBeenCalledWith('piece:me:tally', 1);
		run({ kind: 'piece', id: 'piece:me:tally' }, 'count-reset');
		expect(gameActions.resetCounter).toHaveBeenCalledWith('piece:me:tally');
		run({ kind: 'piece', id: 'piece:me:pouch' }, 'take-out');
		expect(gameActions.drawFromBag).toHaveBeenCalledWith('piece:me:pouch');
		run({ kind: 'piece', id: 'piece:me:die' }, 'roll');
		expect(gameActions.rollDie).toHaveBeenCalledWith('piece:me:die');
	});
});

describe('every wedge prints its key', () => {
	it('the card wheel', () => {
		expect(radialOptions({ kind: 'card', id: 'card:me:AS' }).map((o) => o.key)).toEqual([
			'F',
			'T',
			'R',
			'G'
		]);
	});
});
