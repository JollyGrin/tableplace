/**
 * Every binding the Keybinds folder lists still does what the hand-written
 * handlers on /play and /setup did — same keys, same effects, same routing
 * when a deck, a piece and a card are all under the pointer.
 *
 * The expectations here are the old `handleKeyDown`, line for line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dragStore } from '$lib/store/dragStore.svelte';
import { hoveredPiece } from '$lib/store/pieceUi';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { get } from 'svelte/store';

const gameActions = {
	getMe: vi.fn(() => ({ id: 'me' })),
	getMyDecks: vi.fn(() => [['deck:me:0', {}]] as [string, unknown][]),
	flipCard: vi.fn(),
	flipDeck: vi.fn(),
	tapCard: vi.fn(),
	groupStackIntoDeck: vi.fn(),
	incrementHeight: vi.fn(),
	drawFromTop: vi.fn(),
	drawToHand: vi.fn(() => ({ ok: true, deckId: 'deck:me:0', cardIds: [] })),
	canDrawToHand: vi.fn(() => true),
	shuffleDeck: vi.fn(),
	ungroupDeck: vi.fn(() => ({ ok: true, deckId: 'deck:me:0', cardIds: [] })),
	rotatePiece: vi.fn(),
	cyclePieceState: vi.fn()
};
const camera = { togglePreviewHud: vi.fn(), resetView: vi.fn() };
const toastError = vi.hoisted(() => vi.fn());

vi.mock('$lib/store/game/actions', () => ({ gameActions }));
vi.mock('$lib/utils/transforms/camera', () => ({ cameraTransforms: camera }));
vi.mock('svelte-french-toast', () => ({ default: { error: toastError, success: vi.fn() } }));

const { handleVerbKeyDown, handleVerbKeyUp } = await import('../keyboard');

type Press = { code: string; shift?: boolean; target?: unknown };
const down = ({ code, shift = false, target = null }: Press) =>
	handleVerbKeyDown({ code, shiftKey: shift, target } as unknown as KeyboardEvent);
const up = ({ code, shift = false, target = null }: Press) =>
	handleVerbKeyUp({ code, shiftKey: shift, target } as unknown as KeyboardEvent);

function pointer(over: { deck?: string; piece?: string; card?: string; dragging?: string } = {}) {
	dragStore.update((state) => ({
		...state,
		isDeckHovered: over.deck ?? null,
		isHovered: over.card ?? null,
		isDragging: over.dragging ?? null
	}));
	hoveredPiece.set(over.piece ?? null);
}

beforeEach(() => {
	vi.clearAllMocks();
	pointer();
	gameStore.set({
		cards: {},
		decks: { 'deck:me:0': { cards: [] }, 'deck:them:0': { cards: [] } },
		players: {},
		pieces: {
			'piece:me:model-0': { kind: 'model', position: [0, 0, 0] },
			'piece:me:tile-0': {
				kind: 'token',
				position: [0, 0, 0],
				states: [{ name: 'a' }, { name: 'b' }]
			},
			'piece:me:token-0': { kind: 'token', position: [0, 0, 0] }
		}
	} as never);
});

describe('the table: works with nothing under the pointer', () => {
	it('C resets the camera', () => {
		down({ code: 'KeyC' });
		expect(camera.resetView).toHaveBeenCalledOnce();
	});

	it('Space holds the preview, and letting go drops it', () => {
		down({ code: 'Space' });
		expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(true);
		up({ code: 'Space' });
		expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(false);
	});

	it('a card key over bare felt does nothing', () => {
		for (const code of ['KeyF', 'KeyT', 'KeyR', 'KeyG', 'KeyX', 'ArrowUp', 'Digit3'])
			down({ code });
		for (const code of ['KeyS', 'KeyG']) down({ code, shift: true });
		expect(
			// getMe and canDrawToHand are read-only: every verbsFor() asks them
			Object.values(gameActions).some(
				(fn) => fn !== gameActions.getMe && fn !== gameActions.canDrawToHand && fn.mock.calls.length
			)
		).toBe(false);
	});
});

describe('a hovered card', () => {
	beforeEach(() => pointer({ card: 'card:me:AS' }));

	it('F flips, T taps, R taps back', () => {
		down({ code: 'KeyF' });
		expect(gameActions.flipCard).toHaveBeenCalledWith('card:me:AS');
		down({ code: 'KeyT' });
		expect(gameActions.tapCard).toHaveBeenLastCalledWith(false, 'card:me:AS');
		down({ code: 'KeyR' });
		expect(gameActions.tapCard).toHaveBeenLastCalledWith(true, 'card:me:AS');
	});

	it('F and T ignore Shift, as they always have', () => {
		down({ code: 'KeyF', shift: true });
		down({ code: 'KeyT', shift: true });
		expect(gameActions.flipCard).toHaveBeenCalledOnce();
		expect(gameActions.tapCard).toHaveBeenCalledOnce();
	});

	it('G groups; Shift+G does not', () => {
		down({ code: 'KeyG' });
		expect(gameActions.groupStackIntoDeck).toHaveBeenCalledWith('card:me:AS');
		down({ code: 'KeyG', shift: true });
		expect(gameActions.groupStackIntoDeck).toHaveBeenCalledOnce();
		expect(gameActions.ungroupDeck).not.toHaveBeenCalled();
	});

	it('Arrow Up / Arrow Down nudge the height', () => {
		down({ code: 'ArrowUp' });
		expect(gameActions.incrementHeight).toHaveBeenLastCalledWith(0.01, 'card:me:AS');
		down({ code: 'ArrowDown' });
		expect(gameActions.incrementHeight).toHaveBeenLastCalledWith(-0.01, 'card:me:AS');
	});

	it('a bare S is a pan key, never a shuffle', () => {
		pointer({ deck: 'deck:me:0' });
		down({ code: 'KeyS' });
		expect(gameActions.shuffleDeck).not.toHaveBeenCalled();
	});
});

describe('a card in the hand of the pointer', () => {
	beforeEach(() => pointer({ dragging: 'card:me:AS' }));

	it('still flips and taps', () => {
		down({ code: 'KeyF' });
		expect(gameActions.flipCard).toHaveBeenCalledWith('card:me:AS');
		down({ code: 'KeyT' });
		expect(gameActions.tapCard).toHaveBeenCalledWith(false, 'card:me:AS');
	});

	it('is never swallowed into a deck by G', () => {
		down({ code: 'KeyG' });
		expect(gameActions.groupStackIntoDeck).not.toHaveBeenCalled();
	});
});

describe('a hovered deck', () => {
	beforeEach(() => pointer({ deck: 'deck:me:0', card: 'card:me:AS' }));

	it('F flips the whole deck, not the card', () => {
		down({ code: 'KeyF' });
		expect(gameActions.flipDeck).toHaveBeenCalledWith('deck:me:0');
		expect(gameActions.flipCard).not.toHaveBeenCalled();
	});

	it('Shift+S shuffles and Shift+G ungroups', () => {
		down({ code: 'KeyS', shift: true });
		expect(gameActions.shuffleDeck).toHaveBeenCalledWith('deck:me:0');
		down({ code: 'KeyG', shift: true });
		expect(gameActions.ungroupDeck).toHaveBeenCalledWith('deck:me:0');
		expect(gameActions.groupStackIntoDeck).not.toHaveBeenCalled();
	});

	it('/ opens the search drawer, ? still opens the reference, and the drawer swallows keys (tableplace-196)', async () => {
		const { searchingDeck } = await import('$lib/deckSearch/deckSearch');
		const { helpOpen, toggleHelp } = await import('$lib/hint/hintUi');
		gameStore.set({ players: {}, decks: { 'deck:me:0': { cards: [] } } } as never);
		down({ code: 'Slash', shift: true });
		expect(get(searchingDeck)).toBeNull();
		expect(get(helpOpen)).toBe(true);
		toggleHelp(false);
		down({ code: 'Slash' });
		expect(get(searchingDeck)).toBe('deck:me:0');
		down({ code: 'KeyF' });
		expect(gameActions.flipDeck).not.toHaveBeenCalled();
		searchingDeck.set(null);
	});

	it('1-9 draw that many into the hand (tableplace-194)', () => {
		down({ code: 'Digit1' });
		expect(gameActions.drawToHand).toHaveBeenLastCalledWith('deck:me:0', 1);
		down({ code: 'Digit7', shift: true });
		expect(gameActions.drawToHand).toHaveBeenLastCalledWith('deck:me:0', 7);
		down({ code: 'Digit0' });
		expect(gameActions.drawToHand).toHaveBeenCalledTimes(2);
		expect(gameActions.drawFromTop).not.toHaveBeenCalled();
	});

	it('a key the deck has no verb for falls through to the card (G, T)', () => {
		down({ code: 'KeyG' });
		expect(gameActions.groupStackIntoDeck).toHaveBeenCalledWith('card:me:AS');
		down({ code: 'KeyT' });
		expect(gameActions.tapCard).toHaveBeenCalledWith(false, 'card:me:AS');
	});

	it("someone else's deck refuses Shift+S out loud and shuffles nothing", () => {
		pointer({ deck: 'deck:them:0' });
		gameActions.getMyDecks.mockReturnValueOnce([]);
		down({ code: 'KeyS', shift: true });
		expect(gameActions.shuffleDeck).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalledWith("That deck isn't yours to shuffle");
	});
});

describe('a hovered piece', () => {
	it('T / R turn a model by the grid step instead of tapping the card', () => {
		pointer({ piece: 'piece:me:model-0', card: 'card:me:AS' });
		down({ code: 'KeyT' });
		expect(gameActions.rotatePiece).toHaveBeenLastCalledWith('piece:me:model-0', 90);
		down({ code: 'KeyR' });
		expect(gameActions.rotatePiece).toHaveBeenLastCalledWith('piece:me:model-0', -90);
		expect(gameActions.tapCard).not.toHaveBeenCalled();
	});

	it('T on a piece that is not a model still taps the card', () => {
		pointer({ piece: 'piece:me:token-0', card: 'card:me:AS' });
		down({ code: 'KeyT' });
		expect(gameActions.rotatePiece).not.toHaveBeenCalled();
		expect(gameActions.tapCard).toHaveBeenCalledWith(false, 'card:me:AS');
	});

	it('X steps a multi-state piece forward, Shift+X back', () => {
		pointer({ piece: 'piece:me:tile-0' });
		down({ code: 'KeyX' });
		expect(gameActions.cyclePieceState).toHaveBeenLastCalledWith('piece:me:tile-0', 1);
		down({ code: 'KeyX', shift: true });
		expect(gameActions.cyclePieceState).toHaveBeenLastCalledWith('piece:me:tile-0', -1);
	});

	it('X on a single-face piece is silent', () => {
		pointer({ piece: 'piece:me:token-0' });
		down({ code: 'KeyX' });
		expect(gameActions.cyclePieceState).not.toHaveBeenCalled();
	});
});

describe('typing in a field', () => {
	it('is text, not a table command — on the way down and up', () => {
		pointer({ card: 'card:me:AS' });
		const input = { tagName: 'INPUT' };
		down({ code: 'KeyF', target: input });
		down({ code: 'KeyC', target: input });
		up({ code: 'Space', target: input });
		expect(gameActions.flipCard).not.toHaveBeenCalled();
		expect(camera.resetView).not.toHaveBeenCalled();
		expect(camera.togglePreviewHud).not.toHaveBeenCalled();
	});
});

/**
 * The zoomed preview (tableplace-192) opens on a held Space — a registry verb —
 * or a held Alt, which TableScene tracks as the no-snap modifier. The registry
 * has to compose with both: Space must reach the preview whatever is hovered,
 * and neither key may be swallowed or stop the other verbs working.
 */
describe('composed with the held preview keys', () => {
	const alt = (code: string) =>
		handleVerbKeyDown({
			code,
			shiftKey: false,
			altKey: true,
			target: null,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn()
		} as unknown as KeyboardEvent);

	it('Space opens the preview over a deck, a piece, a card and a hand card', async () => {
		const { hoveredTrayCard } = await import('$lib/HUDTray/trayHover');
		for (const over of [
			{ deck: 'deck:me:0' },
			{ piece: 'piece:me:tile-0' },
			{ card: 'card:me:AS' }
		]) {
			pointer(over);
			down({ code: 'Space' });
			expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(true);
			up({ code: 'Space' });
			expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(false);
		}
		pointer();
		hoveredTrayCard.set('card:me:in-hand');
		down({ code: 'Space' });
		expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(true);
		hoveredTrayCard.set(null);
	});

	it('while Space is held, every other verb still fires', () => {
		pointer({ card: 'card:me:AS' });
		down({ code: 'Space' });
		down({ code: 'KeyF' });
		down({ code: 'KeyT' });
		expect(gameActions.flipCard).toHaveBeenCalledWith('card:me:AS');
		expect(gameActions.tapCard).toHaveBeenCalledWith(false, 'card:me:AS');
		up({ code: 'Space' });
		expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(false);
	});

	it('Alt is never claimed: no verb runs, nothing is prevented or stopped', () => {
		pointer({ deck: 'deck:me:0', card: 'card:me:AS' });
		const event = {
			code: 'AltLeft',
			shiftKey: false,
			altKey: true,
			target: null,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn()
		};
		handleVerbKeyDown(event as unknown as KeyboardEvent);
		handleVerbKeyUp(event as unknown as KeyboardEvent);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(event.stopPropagation).not.toHaveBeenCalled();
		expect(camera.togglePreviewHud).not.toHaveBeenCalled();
		expect(
			// getMe and canDrawToHand are read-only: every verbsFor() asks them
			Object.values(gameActions).some(
				(fn) => fn !== gameActions.getMe && fn !== gameActions.canDrawToHand && fn.mock.calls.length
			)
		).toBe(false);
	});

	it('a held Alt does not change what a key means (F still flips the deck)', () => {
		pointer({ deck: 'deck:me:0' });
		alt('KeyF');
		expect(gameActions.flipDeck).toHaveBeenCalledWith('deck:me:0');
	});

	it('letting go of Space while hovering a hand card still closes the preview', async () => {
		const { hoveredTrayCard } = await import('$lib/HUDTray/trayHover');
		hoveredTrayCard.set('card:me:in-hand');
		down({ code: 'KeyF' });
		expect(gameActions.flipCard).not.toHaveBeenCalled(); // a hand card has no F
		up({ code: 'Space' });
		expect(camera.togglePreviewHud).toHaveBeenLastCalledWith(false);
		hoveredTrayCard.set(null);
	});
});
