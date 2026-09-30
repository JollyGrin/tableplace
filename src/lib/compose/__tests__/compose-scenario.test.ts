/**
 * The composer is the whole point of headless composition: a scenario plus its
 * packs must become a table without a browser, and it must be the SAME table a
 * browser would have built. What has to hold:
 *
 * - the module is pure — no svelte, no store, no DOM, so a bun script can
 *   import it (`scripts/seed-lobby.ts`);
 * - entity ids, seat placeholders, `packOrigin` stamps and card order come out
 *   exactly as `applyScenario` produces them in the client;
 * - shuffling stays opt-in and per placement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { CARD_REST_Y, CARD_THICKNESS } from '$lib/utils/constants-cards';
import { UNGROUP_MAX_CARDS } from '$lib/utils/transforms/ungroup';
import { STANDARD_52 } from '$lib/packs/standard52';
import { applyScenario } from '$lib/scenario/scenario';
import { composeScenario, placedCount, type ShuffleFn } from '../scenario';
import type { GamePackDef } from '$lib/packs/types';
import type { Scenario } from '$lib/scenario/file';
import type { GameDTO } from '$lib/store/game/types';

const STACKED = ['7H', 'AS', '2C', 'KD', '10S'];

const TOKENS: GamePackDef = {
	id: 'tokens',
	name: 'Tokens',
	scope: 'player',
	decks: [],
	pieces: [
		{ kind: 'counter', name: 'HP', maxValue: 30, position: [0, 3] },
		{ kind: 'token', name: 'Objective', imageUrl: 'https://example.com/o.png', position: [2, 1] }
	],
	overlays: [{ imageUrl: 'https://example.com/board.png', ratio: 1.5, scale: 12 }]
};

/** A two-seat duel: a stacked deck each, counters each, one shared board. */
const DUEL: Scenario = {
	name: 'duel',
	createdAt: 0,
	state: {},
	packs: [
		{ id: 'standard-52', source: 'builtin' },
		{ id: 'tokens', source: 'https://example.com/tokens.tbpp.json' }
	],
	placements: [
		{ kind: 'deck', pack: 'standard-52', content: 'main', seat: 0, order: STACKED },
		{ kind: 'deck', pack: 'standard-52', content: 'main', seat: 1, order: STACKED },
		{ kind: 'piece', pack: 'tokens', content: '0', seat: 0, value: 12 },
		{ kind: 'piece', pack: 'tokens', content: '0', seat: 1 },
		{ kind: 'piece', pack: 'tokens', content: '1', seat: 0 },
		{ kind: 'overlay', pack: 'tokens', content: '0' }
	],
	snapPoints: [{ position: [0, 2], rotation: 90 }]
};

const PACKS = new Map<string, GamePackDef>([
	['standard-52', STANDARD_52],
	['tokens', TOKENS]
]);

const emptyTable = () =>
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {}, overlays: {} });

describe('composeScenario — a multi-seat scenario, composed headlessly', () => {
	const composed = composeScenario(DUEL, PACKS);

	it('imports nothing from svelte, the store or the DOM', () => {
		// asserted on the source, not on behaviour: the moment one of these
		// sneaks in, `bun run seed-lobby` stops booting and the failure shows up
		// a long way from the import that caused it
		// the composer's own modules, and the shared ungroup it lays `loose`
		// placements down with (and the card numbers that one reads)
		for (const file of [
			'compose/scenario.ts',
			'compose/pack.ts',
			'compose/piece.ts',
			'utils/transforms/ungroup.ts',
			'utils/constants-card-rest.ts'
		]) {
			const source = readFileSync(join(process.cwd(), 'src/lib', file), 'utf8');
			const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
			const runtime = imports.filter(([, isType]) => !isType).map(([, , from]) => from);
			expect(runtime).not.toContain('svelte');
			expect(runtime).not.toContain('svelte/store');
			expect(runtime.filter((from) => from.includes('store/'))).toEqual([]);
			expect(runtime.filter((from) => from.startsWith('$lib'))).toEqual([]);
			// the renderer: `constants-cards.ts` builds geometry on import
			expect(runtime).not.toContain('three');
			expect(runtime.filter((from) => from.endsWith('constants-cards'))).toEqual([]);
			// comments stripped: the prose above these functions is allowed to say
			// the word `localStorage`, the code is not allowed to reach for it
			const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
			expect(code).not.toMatch(/\b(document|window|localStorage)\b/);
		}
	});

	it('seats a placeholder player for every seat a placement owns', () => {
		expect(Object.keys(composed.players ?? {}).sort()).toEqual(['seat0', 'seat1']);
		expect(composed.players?.seat1).toEqual({
			id: 'seat1',
			seat: 1,
			joinTimestamp: 0,
			tray: {},
			metadata: {}
		});
	});

	it('builds `kind:owner:slug` ids, one per placement', () => {
		expect(Object.keys(composed.decks ?? {}).sort()).toEqual([
			'deck:seat0:main',
			'deck:seat1:main'
		]);
		expect(Object.keys(composed.pieces ?? {}).sort()).toEqual([
			'piece:seat0:hp-0',
			'piece:seat0:objective-0',
			'piece:seat1:hp-0'
		]);
		// overlays are table-scoped: keyed by pack, never by seat
		expect(Object.keys(composed.overlays ?? {})).toEqual(['overlay:tokens:0']);
	});

	it('honours the authored card order and the deck slot ids', () => {
		expect(composed.decks?.['deck:seat0:main']?.cards?.map((c) => c.id)).toEqual(
			STACKED.map((code) => `card:seat0:main-${code}`)
		);
		expect(composed.decks?.['deck:seat1:main']?.cards?.map((c) => c.id)).toEqual(
			STACKED.map((code) => `card:seat1:main-${code}`)
		);
	});

	it('mirrors the far seat: deck rotation and authored piece positions', () => {
		expect(composed.decks?.['deck:seat0:main']?.rotation).toEqual([0, 0, 0]);
		expect(composed.decks?.['deck:seat1:main']?.rotation).toEqual([0, Math.PI, 0]);
		const [x0, , z0] = composed.pieces?.['piece:seat0:hp-0']?.position ?? [];
		const [x1, , z1] = composed.pieces?.['piece:seat1:hp-0']?.position ?? [];
		expect([x0, z0]).toEqual([0, 3]);
		expect([x1, z1]).toEqual([-0, -3]);
	});

	it('stamps provenance from the scenario’s own pack refs', () => {
		expect(composed.decks?.['deck:seat0:main']?.packOrigin).toEqual({
			pack: 'standard-52',
			content: 'main',
			source: 'builtin'
		});
		expect(composed.pieces?.['piece:seat0:hp-0']?.packOrigin).toEqual({
			pack: 'tokens',
			content: '0',
			source: 'https://example.com/tokens.tbpp.json'
		});
		expect(composed.overlays?.['overlay:tokens:0']?.packOrigin).toEqual({
			pack: 'tokens',
			content: '0',
			source: 'https://example.com/tokens.tbpp.json'
		});
	});

	it('carries per-placement piece state through', () => {
		expect(composed.pieces?.['piece:seat0:hp-0']).toMatchObject({ value: 12, maxValue: 30 });
		// no `value` on the placement: the counter spawns full
		expect(composed.pieces?.['piece:seat1:hp-0']).toMatchObject({ value: 30 });
	});

	it('reassigns snap points to `snap:<n>` keys', () => {
		expect(composed.snapPoints).toEqual({
			'snap:0': { id: 'snap:0', position: [0, 2], rotation: 90 }
		});
	});

	it('skips placements whose pack never resolved, and says how many landed', () => {
		const partial = composeScenario(DUEL, new Map([['standard-52', STANDARD_52]]));
		expect(Object.keys(partial.decks ?? {})).toHaveLength(2);
		expect(partial.pieces).toEqual({});
		expect(placedCount(DUEL, new Map([['standard-52', STANDARD_52]]))).toBe(2);
		expect(placedCount(DUEL, PACKS)).toBe(6);
	});
});

describe('composeScenario — order and shuffling', () => {
	it('does not shuffle unless the placement asks', () => {
		const shuffle = vi.fn((cards) => cards);
		composeScenario(DUEL, PACKS, { shuffleWith: shuffle });
		expect(shuffle).not.toHaveBeenCalled();
	});

	it('shuffles exactly the placements that opted in', () => {
		const scenario: Scenario = {
			...DUEL,
			placements: [
				{ kind: 'deck', pack: 'standard-52', content: 'main', seat: 0, order: STACKED },
				{
					kind: 'deck',
					pack: 'standard-52',
					content: 'main',
					seat: 1,
					order: STACKED,
					shuffleOnLoad: true
				}
			]
		};
		const shuffle = vi.fn((cards) => [...cards].reverse());
		const composed = composeScenario(scenario, PACKS, { shuffleWith: shuffle });

		expect(shuffle).toHaveBeenCalledTimes(1);
		expect(composed.decks?.['deck:seat0:main']?.cards?.map((c) => c.id)).toEqual(
			STACKED.map((code) => `card:seat0:main-${code}`)
		);
		expect(composed.decks?.['deck:seat1:main']?.cards?.map((c) => c.id)).toEqual(
			[...STACKED].reverse().map((code) => `card:seat1:main-${code}`)
		);
		// authoring intent round-trips onto the deck either way
		expect(composed.decks?.['deck:seat1:main']?.shuffleOnLoad).toBe(true);
	});

	it('composes a v1/v0 scenario as its own snapshot', () => {
		const legacy: Scenario = {
			name: 'legacy',
			createdAt: 0,
			state: {
				cards: { 'card:seat0:x': { faceImageUrl: 'https://example.com/a.png' } },
				players: { seat0: { id: 'seat0', seat: 0, joinTimestamp: 0, tray: {}, metadata: {} } }
			}
		};
		expect(composeScenario(legacy, new Map())).toMatchObject({
			cards: { 'card:seat0:x': { faceImageUrl: 'https://example.com/a.png' } },
			players: { seat0: { seat: 0 } },
			decks: {}
		});
	});

	it('lays the raw `state` override on top of composed pack content', () => {
		const scenario: Scenario = {
			...DUEL,
			state: { pieces: { 'piece:seat0:hp-0': { value: 3 } } }
		};
		const composed = composeScenario(scenario, PACKS);
		// merged, not replaced — the override patches the composed piece exactly
		// as the same patch would have patched it in the store
		expect(composed.pieces?.['piece:seat0:hp-0']).toMatchObject({
			value: 3,
			maxValue: 30,
			name: 'HP'
		});
	});
});

describe('a counter with a minimum (tableplace-253)', () => {
	const DIALS: GamePackDef = {
		id: 'dials',
		name: 'Dials',
		scope: 'player',
		decks: [],
		pieces: [
			{ kind: 'counter', name: 'Dial', minValue: 3, maxValue: 17, position: [0, 3] },
			{ kind: 'counter', name: 'Plain', maxValue: 17, position: [2, 3] }
		]
	};
	const compose = (content: string, value?: number) =>
		composeScenario(
			{
				name: 'dials',
				createdAt: 0,
				state: {},
				packs: [{ id: 'dials' }],
				placements: [
					{
						kind: 'piece',
						pack: 'dials',
						content,
						seat: 0,
						...(value !== undefined ? { value } : {})
					}
				]
			},
			new Map([['dials', DIALS]])
		).pieces ?? {};

	it('carries the pack piece minValue onto the table, and nothing onto a counter without one', () => {
		expect(compose('0')['piece:seat0:dial-0']).toMatchObject({
			value: 17,
			minValue: 3,
			maxValue: 17
		});
		expect(compose('0', 3)['piece:seat0:dial-0']).toMatchObject({ value: 3, minValue: 3 });
		expect(compose('1')['piece:seat0:plain-0']).not.toHaveProperty('minValue');
	});

	it('refuses a placement value outside the range, with a message naming both bounds', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(compose('0', 2)).toEqual({});
			expect(error).toHaveBeenLastCalledWith(
				"[compose] dials piece[0] 'Dial': value must be between 3 and 17, got 2"
			);
			expect(compose('0', 18)).toEqual({});
			expect(error).toHaveBeenLastCalledWith(expect.stringContaining('between 3 and 17, got 18'));
			// a counter without minValue keeps 0 as its floor
			expect(compose('1', -1)).toEqual({});
			expect(error).toHaveBeenLastCalledWith(expect.stringContaining('between 0 and 17, got -1'));
			expect(error).toHaveBeenCalledTimes(3);
			expect(compose('1', 0)['piece:seat0:plain-0']).toMatchObject({ value: 0 });
			expect(error).toHaveBeenCalledTimes(3);
		} finally {
			error.mockRestore();
		}
	});
});

describe('a deck placed loose (tableplace-263)', () => {
	const RULES = 'card:seat0:main-AS';
	const loose = (
		placement: Partial<NonNullable<Scenario['placements']>[number]> = {}
	): Scenario => ({
		name: 'loose',
		createdAt: 0,
		state: {},
		packs: [{ id: 'standard-52', source: 'builtin' }],
		placements: [
			{
				kind: 'deck',
				pack: 'standard-52',
				content: 'main',
				seat: 0,
				order: ['AS'],
				position: [3, 0.4, -2],
				isFaceUp: true,
				loose: true,
				...placement
			}
		]
	});
	/** card ids of a composed table, bottom → top by resting height */
	const bottomToTop = (cards: GameDTO['cards'] | undefined) =>
		Object.entries(cards ?? {})
			.sort(([, a], [, b]) => (a.position?.[1] ?? 0) - (b.position?.[1] ?? 0))
			.map(([id]) => id);

	it('lays a one-card deck down as exactly one card, and no deck', () => {
		const composed = composeScenario(loose(), PACKS);
		expect(composed.decks).toEqual({});
		expect(composed.cards).toEqual({
			[RULES]: {
				faceImageUrl: 'gen:std52/AS',
				backImageUrl: 'gen:std52/back',
				name: 'Ace of Spades',
				position: [3, CARD_REST_Y, -2],
				rotation: [0, 0, 0]
			}
		});
		// the seat it belongs to still gets its placeholder, so it can be claimed
		expect(Object.keys(composed.players ?? {})).toEqual(['seat0']);
	});

	it('applies the pile’s facing, yaw and lock to the card', () => {
		const facedown = composeScenario(loose({ isFaceUp: false }), PACKS).cards?.[RULES];
		expect(facedown?.rotation).toEqual([180, 0, 0]);
		// deck yaw is radians on the pile; a card's is degrees, applied as -z
		const turned = composeScenario(loose({ rotation: [0, Math.PI / 2, 0] }), PACKS).cards?.[RULES];
		expect(turned?.rotation).toEqual([0, 0, -90]);
		expect(composeScenario(loose({ locked: true }), PACKS).cards?.[RULES]?.locked).toBe(true);
		expect(composeScenario(loose(), PACKS).cards?.[RULES]).not.toHaveProperty('locked');
	});

	it('stacks a three-card deck at one XZ, in pile order', () => {
		const order = ['7H', 'AS', '2C'];
		const ids = order.map((code) => `card:seat0:main-${code}`);
		// a facedown pile's top card is the LAST of its array
		const facedown = composeScenario(loose({ order, isFaceUp: false }), PACKS);
		expect(facedown.decks).toEqual({});
		expect(bottomToTop(facedown.cards)).toEqual(ids);
		expect(Object.values(facedown.cards ?? {}).map((card) => card.position)).toEqual([
			[3, CARD_REST_Y, -2],
			[3, CARD_REST_Y + CARD_THICKNESS, -2],
			[3, CARD_REST_Y + 2 * CARD_THICKNESS, -2]
		]);
		// a face-up pile's is the FIRST
		const faceUp = composeScenario(loose({ order, isFaceUp: true }), PACKS);
		expect(bottomToTop(faceUp.cards)).toEqual([...ids].reverse());
	});

	it('lets shuffleOnLoad decide the stacking order', () => {
		const order = ['7H', 'AS', '2C'];
		const shuffleWith = vi.fn(<T>(cards: T[]) => [...cards].reverse()) as ShuffleFn;
		const composed = composeScenario(
			loose({ order, isFaceUp: false, shuffleOnLoad: true }),
			PACKS,
			{ shuffleWith }
		);
		expect(shuffleWith).toHaveBeenCalledTimes(1);
		expect(bottomToTop(composed.cards)).toEqual(
			[...order].reverse().map((code) => `card:seat0:main-${code}`)
		);
	});

	it('keeps each card’s own orientation and the deck’s back', () => {
		const wide: GamePackDef = {
			id: 'wide',
			name: 'Wide',
			scope: 'player',
			decks: [
				{
					slot: 'ref',
					name: 'Reference',
					back: 'https://example.com/back.png',
					cards: [
						{ code: 'rules', face: 'https://example.com/rules.png', orientation: 'landscape' },
						{ code: 'turn', face: 'https://example.com/turn.png' }
					]
				}
			]
		};
		const composed = composeScenario(
			loose({ pack: 'wide', content: 'ref', order: undefined }),
			new Map([['wide', wide]])
		);
		expect(composed.cards?.['card:seat0:ref-rules']).toMatchObject({
			orientation: 'landscape',
			backImageUrl: 'https://example.com/back.png'
		});
		expect(composed.cards?.['card:seat0:ref-turn']).not.toHaveProperty('orientation');
		expect(composed.cards?.['card:seat0:ref-turn']?.backImageUrl).toBe(
			'https://example.com/back.png'
		);
	});

	it('composes nothing for a deck with no cards, without complaint', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const empty: GamePackDef = {
				id: 'empty',
				name: 'Empty',
				scope: 'player',
				decks: [{ slot: 'none', name: 'None', back: 'gen:std52/back', cards: [] }]
			};
			const composed = composeScenario(
				loose({ pack: 'empty', content: 'none', order: undefined }),
				new Map([['empty', empty]])
			);
			expect(composed.cards).toEqual({});
			expect(composed.decks).toEqual({});
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});

	it('refuses a deck past the ungroup limit, naming the limit', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			// all 52, where Shift+G stops at UNGROUP_MAX_CARDS
			const composed = composeScenario(loose({ order: undefined }), PACKS);
			expect(composed.cards).toEqual({});
			expect(composed.decks).toEqual({});
			expect(error).toHaveBeenCalledTimes(1);
			expect(error).toHaveBeenLastCalledWith(
				`[compose] standard-52/main: 52 cards is too many to place loose — a loose deck placement is capped at ${UNGROUP_MAX_CARDS}`
			);
			// exactly the limit still lands
			const atLimit = STANDARD_52.decks[0].cards.slice(0, UNGROUP_MAX_CARDS).map((c) => c.code);
			expect(
				Object.keys(composeScenario(loose({ order: atLimit }), PACKS).cards ?? {})
			).toHaveLength(UNGROUP_MAX_CARDS);
			expect(error).toHaveBeenCalledTimes(1);
		} finally {
			error.mockRestore();
		}
	});

	it('changes nothing when absent or false', () => {
		const pile = composeScenario(loose({ loose: undefined }), PACKS);
		expect(composeScenario(loose({ loose: false }), PACKS)).toEqual(pile);
		expect(pile.cards).toEqual({});
		expect(Object.keys(pile.decks ?? {})).toEqual(['deck:seat0:main']);
	});

	it('is what Shift+G leaves of the same placement laid down as a pile', async () => {
		const order = ['7H', 'AS', '2C'];
		for (const isFaceUp of [false, true]) {
			const placement = { order, isFaceUp, rotation: [0, Math.PI, 0] as [number, number, number] };
			emptyTable();
			// the pile belongs to whoever ungroups it
			localStorage.setItem('myPlayerId', 'seat0');
			await applyScenario(loose({ ...placement, loose: false }));
			expect(gameActions.ungroupDeck('deck:seat0:main').ok).toBe(true);
			const ungrouped = get(gameStore);

			const composed = composeScenario(loose(placement), PACKS);
			expect(composed.cards).toEqual(ungrouped.cards);
			expect(composed.decks).toEqual(ungrouped.decks);
		}
		localStorage.removeItem('myPlayerId');
	});

	it('reaches the store through applyScenario as cards, never as a deck', async () => {
		emptyTable();
		await applyScenario(loose());
		const inStore = get(gameStore);
		const headless = composeScenario(loose(), PACKS);
		expect(inStore.cards).toEqual(headless.cards);
		expect(inStore.decks).toEqual({});
	});
});

describe('headless and in-browser composition agree', () => {
	it('produces the identical table applyScenario puts in the store', async () => {
		emptyTable();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ tbpp: 1, ...TOKENS }))
		);
		await applyScenario(DUEL);
		const inStore = get(gameStore);
		const headless = composeScenario(DUEL, PACKS);

		for (const collection of ['decks', 'pieces', 'overlays', 'snapPoints', 'players'] as const) {
			expect({ [collection]: inStore[collection] }).toEqual({
				[collection]: headless[collection]
			});
		}
		vi.restoreAllMocks();
	});
});
