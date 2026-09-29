/**
 * The wheel must not be a more permissive way to touch a deck than the keybind
 * is. Both go through the hotkey wrappers, which is where the refusal wording
 * lives — so an opponent's deck refuses the wedge, says why, and mutates
 * nothing.
 *
 * (Cards have no ownership gate today: `F` flips whatever is under the pointer,
 * so the Flip wedge does exactly the same thing. The deck verbs are where there
 * is a rule to keep.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shuffleDeck = vi.fn();
const gameActions = {
	getMe: () => ({ id: 'me' }),
	// nothing on this table belongs to us
	getMyDecks: () => [] as [string, unknown][],
	shuffleDeck,
	ungroupDeck: vi.fn((): { ok: false; reason: string; count?: number } => ({
		ok: false,
		reason: 'not-mine'
	})),
	drawFromTop: vi.fn(),
	flipDeck: vi.fn(),
	flipCard: vi.fn(),
	tapCard: vi.fn(),
	groupStackIntoDeck: vi.fn()
};
const error = vi.fn();

vi.mock('$lib/store/game/actions', () => ({ gameActions }));
vi.mock('svelte-french-toast', () => ({ default: { error, success: vi.fn() } }));

const { radialOptions } = await import('../actions');

const target = { kind: 'deck', id: 'deck:someone-else:0' } as const;
const fire = (id: string) =>
	radialOptions(target)
		.find((option) => option.id === id)!
		.run();

beforeEach(() => vi.clearAllMocks());

describe("an opponent's deck", () => {
	it('refuses the Shuffle wedge, out loud, without shuffling', () => {
		fire('shuffle');
		expect(shuffleDeck).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("That deck isn't yours to shuffle");
	});

	it('refuses the Ungroup wedge with the wrapper wording', () => {
		fire('ungroup');
		expect(error).toHaveBeenCalledWith("That deck isn't yours to spread");
	});

	it('keeps the wrapper cases the keybind has — the card cap included', () => {
		// importing UNGROUP_MAX_CARDS here would pull the real actions barrel in
		// under the mock and deadlock the hoisted factory; the wording is the
		// contract being checked anyway
		gameActions.ungroupDeck.mockReturnValueOnce({ ok: false, reason: 'too-many', count: 999 });
		fire('ungroup');
		expect(error).toHaveBeenCalledWith(expect.stringContaining('too many to spread'));
	});
});
