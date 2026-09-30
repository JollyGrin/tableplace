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
import { STANDARD_52 } from '$lib/packs/standard52';
import { applyScenario } from '$lib/scenario/scenario';
import { composeScenario, placedCount } from '../scenario';
import type { GamePackDef } from '$lib/packs/types';
import type { Scenario } from '$lib/scenario/file';

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
		for (const file of ['scenario.ts', 'pack.ts', 'piece.ts']) {
			const source = readFileSync(join(process.cwd(), 'src/lib/compose', file), 'utf8');
			const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
			const runtime = imports.filter(([, isType]) => !isType).map(([, , from]) => from);
			expect(runtime).not.toContain('svelte');
			expect(runtime).not.toContain('svelte/store');
			expect(runtime.filter((from) => from.includes('store/'))).toEqual([]);
			expect(runtime.filter((from) => from.startsWith('$lib'))).toEqual([]);
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
