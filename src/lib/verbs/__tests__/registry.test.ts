/**
 * The registry as data: which verbs a target gets, keyed by kind and
 * capability; ownership gates surfacing as `enabled: false` with a reason; and
 * the Keybinds folder being exactly the registry's hotkeys.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gameStore } from '$lib/store/game/gameStore.svelte';

vi.mock('svelte-french-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const { verbsFor, keybindReference, BUILTIN_VERBS } = await import('../registry');
const { UNGROUP_MAX_CARDS } = await import('$lib/store/game/actions/deck');

const me = { playerId: 'me' };
const cards = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ id: `c${i}`, faceImageUrl: '' }));
const ids = (verbs: { id: string }[]) => verbs.map((verb) => verb.id);
const verb = (target: Parameters<typeof verbsFor>[0], id: string) =>
	verbsFor(target, me).find((v) => v.id === id)!;

beforeEach(() => {
	gameStore.set({
		cards: {},
		players: {},
		decks: {
			'deck:me:0': { cards: cards(3) },
			'deck:me:1': { cards: [] },
			'deck:me:2': { cards: cards(UNGROUP_MAX_CARDS + 1) },
			'deck:them:0': { cards: cards(3) }
		},
		pieces: {
			'piece:me:m': { kind: 'model', position: [0, 0, 0] },
			'piece:me:s': { kind: 'pawn', position: [0, 0, 0], states: [{}, {}] },
			'piece:me:c': { kind: 'counter', position: [0, 0, 0] },
			'piece:me:c5': { kind: 'counter', position: [0, 0, 0], maxValue: 5 },
			'piece:me:m-free': { kind: 'model', position: [0, 0, 0], snap: false },
			'piece:me:b': { kind: 'bag', position: [0, 0, 0] },
			'piece:me:d': { kind: 'die', position: [0, 0, 0] },
			'piece:me:t': { kind: 'token', position: [0, 0, 0] }
		}
	} as never);
});

describe('verbs by kind', () => {
	it('a card, a deck and the table get their verbs, in wheel order', () => {
		expect(ids(verbsFor({ kind: 'card', id: 'card:me:AS' }, me))).toEqual([
			'flip',
			'tap',
			'tap-reverse',
			'group',
			'raise',
			'lower',
			'lock',
			'focus'
		]);
		expect(ids(verbsFor({ kind: 'deck', id: 'deck:me:0' }, me))).toEqual([
			'draw',
			'draw-table',
			'flip',
			'shuffle',
			'search',
			'ungroup',
			'move',
			'lock',
			'focus'
		]);
		expect(ids(verbsFor({ kind: 'table' }, me))).toEqual([
			'preview',
			'reset-view',
			'top-down',
			'focus',
			'help'
		]);
	});

	it("another player's deck refuses a draw to your hand; an unowned one deals (tableplace-194)", () => {
		gameStore.update(
			(state) => ({ ...state, players: { them: { id: 'them', seat: 1 } } }) as never
		);
		const theirs = verb({ kind: 'deck', id: 'deck:them:0' }, 'draw');
		expect(theirs.enabled).toBe(false);
		expect(theirs.reasonDisabled).toBe("That deck isn't yours to draw from");
		expect(verb({ kind: 'deck', id: 'deck:seat3:0' }, 'draw').enabled).toBe(true);
		expect(verb({ kind: 'deck', id: 'deck:me:0' }, 'draw').enabled).toBe(true);
		// the felt has no ownership gate, same as before
		expect(verb({ kind: 'deck', id: 'deck:them:0' }, 'draw-table').enabled).toBe(true);
	});

	it('hand cards and selections are reserved kinds with nothing on them yet', () => {
		expect(verbsFor({ kind: 'hand-card', id: 'card:me:AS' }, me)).toEqual([]);
		expect(verbsFor({ kind: 'selection', ids: ['card:me:AS'] }, me)).toEqual([]);
	});
});

describe('verbs by capability, never by game', () => {
	// every piece can be focused and locked; what differs by capability is everything else
	const piece = (id: string) =>
		ids(verbsFor({ kind: 'piece', id }, me)).filter((verb) => verb !== 'focus' && verb !== 'lock');

	it('grid-rotatable → rotate; has states → next/previous state', () => {
		expect(piece('piece:me:m')).toEqual(['rotate-cw', 'rotate-ccw', 'snap-toggle', 'remove']);
		expect(piece('piece:me:s')).toEqual(['state-next', 'state-prev']);
	});

	it('counter → ±1 and reset, randomiser → roll, container → take one out', () => {
		expect(piece('piece:me:c')).toEqual(['count-up', 'count-down', 'count-reset']);
		expect(piece('piece:me:d')).toEqual(['roll']);
		expect(piece('piece:me:b')).toEqual(['take-out']);
	});

	it('reset to max needs a max; the snap toggle names what it will do', () => {
		const one = (id: string, verbId: string) =>
			verbsFor({ kind: 'piece', id }, me).find((v) => v.id === verbId);
		expect(one('piece:me:c', 'count-reset')).toMatchObject({ enabled: false });
		expect(one('piece:me:c5', 'count-reset')).toMatchObject({ enabled: true });
		expect(one('piece:me:m', 'snap-toggle')?.label).toBe('Stop snapping');
		expect(one('piece:me:m-free', 'snap-toggle')?.label).toBe('Snap to grid');
	});

	// focus is the one exception: a camera move, offered by key and double-click
	// focus is the one exception: a camera move, offered by key and double-click
	it('every piece verb is offered on the wheel', () => {
		for (const id of ['piece:me:m', 'piece:me:s', 'piece:me:c', 'piece:me:b', 'piece:me:d'])
			for (const verb of verbsFor({ kind: 'piece', id }, me))
				if (verb.id !== 'focus') expect(verb.radial, verb.id).toBe(true);
	});

	it('a plain token, or a piece that is gone, has nothing', () => {
		expect(piece('piece:me:t')).toEqual([]);
		expect(piece('piece:me:missing')).toEqual([]);
	});
});

describe('ownership gates surface before you press', () => {
	it('your own deck: shuffle and ungroup are enabled', () => {
		expect(verb({ kind: 'deck', id: 'deck:me:0' }, 'shuffle')).toMatchObject({ enabled: true });
		expect(verb({ kind: 'deck', id: 'deck:me:0' }, 'ungroup')).toMatchObject({ enabled: true });
	});

	it("someone else's deck: shuffle and ungroup are disabled, with the toast's reason", () => {
		expect(verb({ kind: 'deck', id: 'deck:them:0' }, 'shuffle')).toMatchObject({
			enabled: false,
			reasonDisabled: "That deck isn't yours to shuffle"
		});
		expect(verb({ kind: 'deck', id: 'deck:them:0' }, 'ungroup')).toMatchObject({
			enabled: false,
			reasonDisabled: "That deck isn't yours to spread"
		});
	});

	it('the same deck is enabled for its owner and disabled for everyone else', () => {
		const target = { kind: 'deck', id: 'deck:them:0' } as const;
		expect(verbsFor(target, { playerId: 'them' }).find((v) => v.id === 'shuffle')!.enabled).toBe(
			true
		);
	});

	it('ungroup explains an empty deck and the card cap', () => {
		expect(verb({ kind: 'deck', id: 'deck:me:1' }, 'ungroup').reasonDisabled).toBe(
			'That deck is empty'
		);
		expect(verb({ kind: 'deck', id: 'deck:me:2' }, 'ungroup').reasonDisabled).toMatch(
			`capped at ${UNGROUP_MAX_CARDS}`
		);
	});

	it('group refuses the card you are holding', () => {
		expect(verb({ kind: 'card', id: 'card:me:AS', dragging: true }, 'group')).toMatchObject({
			enabled: false,
			reasonDisabled: 'Put the card down first'
		});
	});

	it('verbs without a gate are enabled for anyone', () => {
		const flip = verbsFor({ kind: 'deck', id: 'deck:them:0' }, { playerId: null }).find(
			(v) => v.id === 'flip'
		)!;
		expect(flip.enabled).toBe(true);
		expect(flip.reasonDisabled).toBeUndefined();
	});
});

describe('the Keybinds folder is generated from the registry', () => {
	const rows = keybindReference();
	const keyFor = (action: string) => rows.find((row) => row.action === action)?.key;

	it('lists every hotkey the registry binds, once', () => {
		for (const def of BUILTIN_VERBS.filter((d) => d.hotkey)) {
			expect(keyFor(def.reference ?? def.label)).toBe(def.hotkey!.label);
		}
		expect(new Set(rows.map((row) => row.action)).size).toBe(rows.length);
	});

	it('still lists every binding it listed before the registry', () => {
		const before: [string, string][] = [
			['Actions on anything (card, deck, piece, table)', 'right-click'],
			['Same wheel, no right button', 'press & hold'],
			['Pan camera', 'W A S D'],
			['Seat view (reset camera)', 'C'],
			['Preview hovered (card, hand, deck, piece)', 'hold Space or Alt'],
			['Tap card', 'T'],
			['Reverse tap card', 'R'],
			['Rotate hovered model +90°', 'T'],
			['Rotate hovered model −90°', 'R'],
			['Flip card', 'F'],
			['Group stack into deck', 'G'],
			[`Ungroup deck (max ${UNGROUP_MAX_CARDS} cards)`, 'Shift + G'],
			['Shuffle hovered deck', 'Shift + S'],
			['Drop without snapping', 'hold Alt'],
			['Cancel drag', 'Esc'],
			['Nudge card higher', 'Arrow Up'],
			['Nudge card lower', 'Arrow Down']
		];
		for (const [action, key] of before) expect(keyFor(action), action).toBe(key);
	});

	it('now also lists the bindings the hand-written card left out', () => {
		expect(keyFor('Flip hovered deck')).toBe('F');
		expect(keyFor('Draw that many into your hand')).toBe('1 – 9');
		expect(keyFor("Hovered piece's next state")).toBe('X');
		expect(keyFor("Hovered piece's previous state")).toBe('Shift + X');
	});

	it('says a deck click draws to the hand and Shift+click to the table (tableplace-194)', () => {
		expect(keyFor('Draw into your hand')).toBe('click deck');
		expect(keyFor('Draw onto the table')).toBe('Shift + click deck');
	});

	it('lists the camera presets (tableplace-185)', () => {
		expect(keyFor('Toggle top-down / seat view')).toBe('P');
		expect(keyFor('Focus hovered card, deck or piece')).toBe('Z');
		expect(keyFor('Focus what you moved last')).toBe('Z');
		expect(keyFor('Focus a card, deck or piece')).toBe('double-click');
	});
});

describe('no two verbs on one target answer the same chord', () => {
	const chords = (codes: readonly string[], shift?: boolean) =>
		codes.flatMap((code) =>
			shift === undefined ? [`${code}+shift`, `${code}`] : [shift ? `${code}+shift` : code]
		);

	it.each([
		['card', { kind: 'card', id: 'card:me:AS' }],
		['deck', { kind: 'deck', id: 'deck:me:0' }],
		['model', { kind: 'piece', id: 'piece:me:m' }],
		['multi-state piece', { kind: 'piece', id: 'piece:me:s' }],
		['table', { kind: 'table' }]
	] as const)('%s', (_, target) => {
		const all = verbsFor(target, me).flatMap((v) =>
			v.hotkey ? chords(v.hotkey.codes, v.hotkey.shift) : []
		);
		expect(new Set(all).size).toBe(all.length);
	});
});
