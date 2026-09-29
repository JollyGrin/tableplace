/**
 * The hint bar's line as data: which thing it names, which verbs (and keys)
 * it offers in the order a key would find them, what it says mid-drag, and
 * what it says over bare table. Every word must come from the registry or an
 * entity name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gameStore } from '$lib/store/game/gameStore.svelte';

vi.mock('svelte-french-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const { hintFor, entityName, HINT_MAX_VERBS } = await import('../hint');
const { BUILTIN_VERBS, DRAG_MODIFIERS, RELEASE_TEXT, TABLE_BASICS, verbReference } = await import(
	'$lib/verbs/registry'
);
const { toggleHelp, helpOpen } = await import('../hintUi');
const { get } = await import('svelte/store');

import type { GameDTO } from '$lib/store/game/types';
import type { VerbTarget } from '$lib/verbs/types';

const me = { playerId: 'me' };
const cards = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ id: `c${i}`, faceImageUrl: '', name: `Card ${i}` }));

const game = {
	cards: {
		'card:me:up': { name: 'Lantern', rotation: [0, 0, 0], position: [0, 0, 0] },
		'card:me:down': { name: 'Secret', rotation: [180, 0, 0], position: [0, 0, 0] }
	},
	players: { me: { tray: { 'card:me:h': { name: 'Held thing' } } } },
	decks: {
		'deck:me:0': { cards: cards(3) },
		'deck:me:up': { cards: cards(2), isFaceUp: true },
		'deck:them:0': { cards: cards(4) }
	},
	pieces: {
		'piece:me:s': {
			kind: 'pawn',
			name: 'Marker',
			position: [0, 0, 0],
			states: [{ name: 'calm' }, { name: 'bold' }],
			state: 1
		},
		'piece:me:c': { kind: 'counter', name: 'Tally', position: [0, 0, 0] },
		'piece:me:anon': { kind: 'token', name: '', position: [0, 0, 0] }
	}
} as unknown as Partial<GameDTO>;

beforeEach(() => gameStore.set(game as never));

const line = (targets: VerbTarget[], extra: Partial<Parameters<typeof hintFor>[0]> = {}) =>
	hintFor({ game, actor: me, targets, dragging: null, dropKind: null, ...extra });
const keys = (hint: ReturnType<typeof hintFor>) => hint.parts.map((p) => `${p.key}|${p.text}`);
const TABLE: VerbTarget = { kind: 'table' };

describe('hovering a deck', () => {
	it('names it by its count and offers draw and shuffle with their keys', () => {
		const hint = line([{ kind: 'deck', id: 'deck:me:0' }, TABLE]);
		expect(hint.name).toBe('Deck (3)');
		expect(keys(hint)).toContain('1 – 9|Draw 1');
		expect(keys(hint)).toContain('Shift + S|Shuffle');
		// the pile's own verbs come before the table's
		expect(hint.parts[0]!.text).toBe('Draw 1');
	});

	it('a face-up pile is named by the card on top', () => {
		expect(line([{ kind: 'deck', id: 'deck:me:up' }, TABLE]).name).toBe('Card 0 (2)');
	});

	it("someone else's pile still names shuffle, disabled with the reason", () => {
		const shuffle = line([{ kind: 'deck', id: 'deck:them:0' }, TABLE]).parts.find(
			(p) => p.text === 'Shuffle'
		)!;
		expect(shuffle.enabled).toBe(false);
		expect(shuffle.reason).toBeTruthy();
	});
});

describe('hovering a card', () => {
	it('names a face-up card and never more than the cap of verbs', () => {
		const hint = line([{ kind: 'card', id: 'card:me:up' }, TABLE]);
		expect(hint.name).toBe('Lantern');
		expect(hint.parts.length).toBeLessThanOrEqual(HINT_MAX_VERBS);
		expect(keys(hint)[0]).toBe('F|Flip');
	});

	it('a face-down card keeps its name hidden', () => {
		expect(entityName(game, me, { kind: 'card', id: 'card:me:down' })).toBe('Card');
	});

	it("a key the deck claims hides the card's verb for the same key; a free one falls through", () => {
		const hint = line([
			{ kind: 'deck', id: 'deck:me:0' },
			{ kind: 'card', id: 'card:me:up' },
			TABLE
		]);
		const flips = hint.parts.filter((p) => p.key === 'F');
		expect(flips).toHaveLength(1);
		expect(hint.name).toBe('Deck (3)');
	});
});

describe('hovering a piece or a hand card', () => {
	it('names the piece with its current state, and its gestures', () => {
		const hint = line([{ kind: 'piece', id: 'piece:me:s' }, TABLE]);
		expect(hint.name).toBe('Marker — bold');
		expect(keys(hint)).toContain('X|Next state');
	});

	it('a counter offers its click gestures', () => {
		const texts = keys(line([{ kind: 'piece', id: 'piece:me:c' }, TABLE]));
		expect(texts).toContain('click|−1');
		expect(texts).toContain('right-click or Shift+click|+1');
	});

	it('an unnamed piece falls back to the noun', () => {
		expect(entityName(game, me, { kind: 'piece', id: 'piece:me:anon' })).toBe('Piece');
	});

	it('a hand card is named and offers the preview it falls through to', () => {
		const hint = line([{ kind: 'hand-card', id: 'card:me:h' }, TABLE]);
		expect(hint.name).toBe('Held thing');
		expect(keys(hint)).toContain('hold Space or Alt|Preview');
	});
});

describe('dragging', () => {
	it('says what release will do, then Alt and Esc', () => {
		const hint = line([TABLE], { dragging: 'card:me:up', dropKind: 'deck' });
		expect(hint.name).toBe('Lantern');
		expect(hint.parts.map((p) => p.text)).toEqual([
			RELEASE_TEXT.deck,
			...DRAG_MODIFIERS.map((row) => row.action)
		]);
		expect(hint.parts.map((p) => p.key)).toEqual(['', 'hold Alt', 'Esc']);
	});

	it('a carried pile is named like a hovered one', () => {
		expect(line([TABLE], { dragging: 'deck:me:0', dropKind: 'table' }).name).toBe('Deck (3)');
	});
});

describe('nothing under the pointer', () => {
	it('leads with ?, then the camera basics', () => {
		const hint = line([TABLE]);
		expect(hint.name).toBeNull();
		expect(hint.parts[0]!.key).toBe('?');
		expect(hint.parts.slice(1, 1 + TABLE_BASICS.length).map((p) => p.text)).toEqual(
			TABLE_BASICS.map((row) => row.action)
		);
		// the preview needs something under the pointer to preview
		expect(hint.parts.some((p) => p.text === 'Preview')).toBe(false);
	});
});

describe('the ? reference', () => {
	it('lists every verb that has a key or a gesture', () => {
		const rows = verbReference().flatMap((section) => section.rows);
		for (const def of BUILTIN_VERBS.filter((d) => d.hotkey || d.gesture)) {
			expect(
				rows.some((row) => row.action === (def.reference ?? def.label)),
				def.id
			).toBe(true);
		}
	});

	it('the ? verb toggles it', () => {
		toggleHelp(false);
		BUILTIN_VERBS.find((d) => d.id === 'help')!.run({ target: TABLE, actor: me });
		expect(get(helpOpen)).toBe(true);
		toggleHelp();
		expect(get(helpOpen)).toBe(false);
	});
});
