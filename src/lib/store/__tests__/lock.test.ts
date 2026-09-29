/**
 * Lock (tableplace-189): a pinned card, deck or piece refuses every verb that
 * would move, turn or swallow it — at the action, so no route goes around the
 * keyboard — and names the key that frees it. L itself is never refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('svelte-french-toast', () => ({ default: toast }));

const { gameActions } = await import('$lib/store/game/actions');
const { isLocked } = await import('$lib/store/game/actions/lock');
const { ungroupRefusal } = await import('$lib/store/game/actions/deck');
const { verbsFor } = await import('$lib/verbs/registry');
const { verbForKey } = await import('$lib/verbs/keyboard');
const { grabDeck } = await import('$lib/drop/grab');
const { LOCKED_REFUSAL } = await import('$lib/hotkeys/lock');
const { hintFor } = await import('$lib/hint/hint');

const me = { playerId: 'me' };
const loose = (x: number, locked?: boolean) => ({
	position: [x, 0.26, 0] as [number, number, number],
	rotation: [0, 0, 0] as [number, number, number],
	faceImageUrl: '',
	...(locked ? { locked: true } : {})
});

beforeEach(() => {
	vi.clearAllMocks();
	gameStore.set({
		players: {},
		cards: {
			'card:me:a': loose(0, true),
			'card:me:b': loose(10),
			// one pinned card under a loose one: G on the loose one must not eat it
			'card:me:under': loose(20, true),
			'card:me:over': { ...loose(20), position: [20, 0.3, 0] }
		},
		decks: {
			'deck:me:0': {
				id: 'deck:me:0',
				position: [5, 0.4, 5],
				rotation: [0, 0, 0],
				cards: [{ id: 'c0', faceImageUrl: '' }],
				locked: true
			}
		},
		pieces: {
			'piece:me:m': { kind: 'model', name: 'Wall', position: [0, 0, 0], rotation: [0, 0, 0] },
			'piece:me:c': {
				kind: 'counter',
				name: 'HP',
				position: [0, 0, 0],
				rotation: [0, 0, 0],
				value: 3,
				maxValue: 5,
				locked: true
			}
		}
	} as never);
});

describe('the flag', () => {
	it('toggles with one synced boolean, and unpinning deletes the key', () => {
		expect(gameActions.toggleLock('piece', 'piece:me:m')).toBe(true);
		expect(get(gameStore).pieces?.['piece:me:m']?.locked).toBe(true);
		expect(gameActions.toggleLock('piece', 'piece:me:m')).toBe(false);
		expect(get(gameStore).pieces?.['piece:me:m']).not.toHaveProperty('locked');
	});

	it('does nothing to a thing that is not there', () => {
		expect(gameActions.toggleLock('card', 'card:me:gone')).toBeUndefined();
		expect(get(gameStore).cards).not.toHaveProperty('card:me:gone');
		expect(isLocked('card', 'card:me:gone')).toBe(false);
	});
});

describe('actions refuse a pinned target', () => {
	it('a pinned card neither flips, taps, nudges nor groups', () => {
		const before = structuredClone(get(gameStore).cards['card:me:a']);
		gameActions.flipCard('card:me:a');
		gameActions.tapCard(false, 'card:me:a');
		gameActions.incrementHeight(0.01, 'card:me:a');
		expect(gameActions.groupStackIntoDeck('card:me:a')).toBeUndefined();
		expect(get(gameStore).cards['card:me:a']).toEqual(before);
	});

	it('a loose card still flips', () => {
		gameActions.flipCard('card:me:b');
		expect(get(gameStore).cards['card:me:b']?.rotation?.[0]).toBe(180);
	});

	it('grouping a stack with a pinned card in it swallows nothing', () => {
		expect(gameActions.groupStackIntoDeck('card:me:over')).toBeUndefined();
		expect(get(gameStore).cards).toHaveProperty('card:me:under');
		expect(get(gameStore).cards).toHaveProperty('card:me:over');
	});

	it('a pinned deck neither flips, ungroups nor lifts', () => {
		gameActions.flipDeck('deck:me:0');
		expect(get(gameStore).decks['deck:me:0']?.isFaceUp).toBeFalsy();
		expect(ungroupRefusal('deck:me:0', 'me')).toMatchObject({ ok: false, reason: 'locked' });
		expect(grabDeck('deck:me:0')).toBeNull();
		expect(toast).toHaveBeenCalledWith(LOCKED_REFUSAL, expect.anything());
	});

	it('a pinned piece does not turn, but a pinned counter still counts', () => {
		gameActions.setLocked('piece', 'piece:me:m', true);
		gameActions.rotatePiece('piece:me:m', 90);
		expect(get(gameStore).pieces?.['piece:me:m']?.rotation).toEqual([0, 0, 0]);
		gameActions.incrementCounter('piece:me:c', -1);
		expect(get(gameStore).pieces?.['piece:me:c']?.value).toBe(2);
	});
});

describe('the verbs', () => {
	const verb = (target: Parameters<typeof verbsFor>[0], id: string) =>
		verbsFor(target, me).find((v) => v.id === id)!;

	it('moving verbs grey out with the key that frees them; the rest stay', () => {
		const card = { kind: 'card', id: 'card:me:a' } as const;
		for (const id of ['flip', 'tap', 'tap-reverse', 'group', 'raise', 'lower']) {
			expect(verb(card, id)).toMatchObject({ enabled: false, reasonDisabled: LOCKED_REFUSAL });
		}
		expect(verb(card, 'focus').enabled).toBe(true);
		const deck = { kind: 'deck', id: 'deck:me:0' } as const;
		expect(verb(deck, 'move').enabled).toBe(false);
		expect(verb(deck, 'draw').enabled).toBe(true);
		expect(verb(deck, 'shuffle').enabled).toBe(true);
	});

	it('pressing a refused verb toasts instead of acting', () => {
		const flip = verb({ kind: 'card', id: 'card:me:a' }, 'flip');
		flip.run();
		expect(toast).toHaveBeenCalledWith(LOCKED_REFUSAL, expect.anything());
		expect(get(gameStore).cards['card:me:a']?.rotation?.[0]).toBe(0);
	});

	it('L is bound on every entity, reads Lock / Unlock, and is never refused', () => {
		const targets = [{ kind: 'card', id: 'card:me:a' } as const];
		const l = verbForKey({ code: 'KeyL', shiftKey: false }, targets, me)!;
		expect(l).toMatchObject({ id: 'lock', label: 'Unlock', enabled: true, radial: true });
		l.run();
		expect(isLocked('card', 'card:me:a')).toBe(false);
		expect(verb({ kind: 'card', id: 'card:me:a' }, 'lock').label).toBe('Lock');
		expect(verb({ kind: 'piece', id: 'piece:me:m' }, 'lock').enabled).toBe(true);
		expect(verb({ kind: 'deck', id: 'deck:me:0' }, 'lock').label).toBe('Unlock');
	});

	it('the hint bar names the pin and leads with what still works', () => {
		const hint = hintFor({
			game: get(gameStore),
			actor: me,
			targets: [{ kind: 'card', id: 'card:me:a' }, { kind: 'table' }],
			dragging: null,
			dropKind: null
		});
		expect(hint.name).toMatch(/locked$/);
		expect(hint.parts.map((p) => p.text)).toContain('Unlock');
		expect(hint.parts[0].enabled).toBe(true);
	});
});
