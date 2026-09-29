import { describe, it, expect } from 'vitest';
import { parsePackFile, serializePackFile, packFileName, PACK_SCHEMA_URL } from '../file';
import { STANDARD_52 } from '../standard52';
import type { GamePackDef } from '../types';

describe('tbpp round-trip', () => {
	it('export → parse returns the same pack', () => {
		const text = serializePackFile(STANDARD_52);
		expect(parsePackFile(text)).toEqual(STANDARD_52);
	});

	it('writes the discriminator and $schema line', () => {
		const file = JSON.parse(serializePackFile(STANDARD_52));
		expect(file.tbpp).toBe(1);
		expect(file.$schema).toBe(PACK_SCHEMA_URL);
	});

	it('round-trips pieces, overlays, and provenance', () => {
		const pack: GamePackDef = {
			id: 'test',
			name: 'Test',
			scope: 'table',
			decks: [],
			pieces: [
				{ kind: 'counter', name: 'HP', color: '#ff0000', maxValue: 20, position: [1, -2] },
				{ kind: 'token', name: 'Tile', imageUrl: 'https://x/y.png', radius: 1.5, position: [0, 0] },
				// the per-piece snap opt-out (tableplace-134) survives the round-trip
				{ kind: 'token', name: 'Loose prop', snap: false, position: [3, 3] },
				// advisory reach over snap-point links (tableplace-190)
				{ kind: 'pawn', name: 'Walker', reach: 2, position: [4, 4] }
			],
			overlays: [{ imageUrl: 'https://x/map.webp', ratio: 1.6, scale: 10 }],
			source: 'tts'
		};
		expect(parsePackFile(serializePackFile(pack))).toEqual(pack);
	});

	it('refuses a reach that is not a whole number ≥ 0', () => {
		const pack = (reach: unknown) =>
			JSON.stringify({
				tbpp: 1,
				id: 'test',
				name: 'Test',
				scope: 'table',
				decks: [],
				pieces: [{ kind: 'pawn', name: 'Walker', reach, position: [0, 0] }]
			});
		expect(() => parsePackFile(pack(1.5))).toThrow(/reach/);
		expect(() => parsePackFile(pack(-1))).toThrow(/reach/);
		expect(() => parsePackFile(pack('2'))).toThrow(/reach/);
		expect(parsePackFile(pack(0)).pieces?.[0]?.reach).toBe(0);
	});

	it('round-trips a multi-state piece, mixed face-ref schemes and all', () => {
		const pack: GamePackDef = {
			id: 'test',
			name: 'Test',
			scope: 'table',
			decks: [],
			pieces: [
				{
					kind: 'token',
					name: 'Brazier',
					imageUrl: 'https://x/lit.png',
					states: [
						{ face: 'https://x/lit.png', name: 'Lit' },
						{ face: 'gen:std52/AS' },
						{ face: 'sheet:{"url":"https://x/s.png","cols":2,"rows":1,"index":1}', name: 'Out' }
					],
					state: 2,
					position: [0, 0]
				}
			]
		};
		expect(parsePackFile(serializePackFile(pack))).toEqual(pack);
	});

	it('round-trips a bag with mixed contents', () => {
		const pack: GamePackDef = {
			id: 'bags',
			name: 'Bags',
			scope: 'table',
			decks: [],
			pieces: [
				{
					kind: 'bag',
					name: 'Tile Bag',
					color: '#7c2d12',
					radius: 0.9,
					drawMode: 'lifo',
					infinite: true,
					contents: [
						{ kind: 'token', name: 'Ember', color: '#f97316', imageUrl: 'https://x/e.png' },
						{ kind: 'pawn', name: 'Runner', radius: 0.3 },
						{ kind: 'counter', name: 'Dial', maxValue: 5 },
						{
							kind: 'card',
							code: 'omen',
							name: 'Omen',
							face: 'https://x/o.png',
							back: 'gen:std52/back'
						}
					],
					position: [-9, 4]
				}
			]
		};
		expect(parsePackFile(serializePackFile(pack))).toEqual(pack);
	});

	it('round-trips a bag with no contents and no draw mode', () => {
		const pack: GamePackDef = {
			id: 'empty-bag',
			name: 'Empty Bag',
			scope: 'table',
			decks: [],
			pieces: [{ kind: 'bag', name: 'Bag', contents: [], position: [0, 0] }]
		};
		const parsed = parsePackFile(serializePackFile(pack));
		expect(parsed).toEqual(pack);
		// absent drawMode is the reader's default, not something we invent on read
		expect(parsed.pieces?.[0].drawMode).toBeUndefined();
	});

	it('round-trips a per-card orientation', () => {
		const pack: GamePackDef = {
			id: 'sites',
			name: 'Sites',
			scope: 'player',
			decks: [
				{
					slot: 'atlas',
					name: 'Atlas',
					back: 'https://x/back.png',
					cards: [
						{ code: 'site', face: 'https://x/site.png', orientation: 'landscape' },
						{ code: 'spell', face: 'https://x/spell.png' }
					]
				}
			],
			pieces: [
				{
					kind: 'bag',
					name: 'Pouch',
					position: [0, 0],
					contents: [
						{ kind: 'card', code: 'site-2', face: 'https://x/site2.png', orientation: 'landscape' }
					]
				}
			]
		};
		expect(parsePackFile(serializePackFile(pack))).toEqual(pack);
	});

	it('names files <name>.tbpp.json', () => {
		expect(packFileName(STANDARD_52)).toBe('Standard Playing Cards.tbpp.json');
	});
});

describe('parsePackFile errors', () => {
	const valid = () => JSON.parse(serializePackFile(STANDARD_52));

	it('rejects non-JSON', () => {
		expect(() => parsePackFile('not json')).toThrow(/valid JSON/);
	});

	it('rejects files without the tbpp marker', () => {
		const file = valid();
		delete file.tbpp;
		expect(() => parsePackFile(JSON.stringify(file))).toThrow(/"tbpp": 1/);
	});

	it('rejects unknown versions', () => {
		const file = { ...valid(), tbpp: 2 };
		expect(() => parsePackFile(JSON.stringify(file))).toThrow(/version 2/);
	});

	it('points at the offending field', () => {
		const file = valid();
		delete file.decks[0].cards[3].face;
		expect(() => parsePackFile(JSON.stringify(file))).toThrow('decks[0].cards[3].face');
	});

	it('rejects an unknown orientation', () => {
		const pack = JSON.parse(serializePackFile(STANDARD_52));
		pack.decks[0].cards[0].orientation = 'diagonal';
		expect(() => parsePackFile(JSON.stringify(pack))).toThrow(
			/decks\[0\]\.cards\[0\]\.orientation must be one of portrait, landscape/
		);
	});

	it('rejects bad scope', () => {
		const file = { ...valid(), scope: 'global' };
		expect(() => parsePackFile(JSON.stringify(file))).toThrow(/scope/);
	});

	it('rejects malformed pieces', () => {
		const file = { ...valid(), pieces: [{ kind: 'meeple', name: 'x', position: [0, 0] }] };
		expect(() => parsePackFile(JSON.stringify(file))).toThrow('pieces[0].kind');
	});

	const withStates = (states: unknown, extra: Record<string, unknown> = {}) => ({
		...valid(),
		pieces: [{ kind: 'token', name: 'x', position: [0, 0], states, ...extra }]
	});

	it('points at the offending state face', () => {
		const file = withStates([{ face: 'https://x/a.png' }, { name: 'no face' }]);
		expect(() => parsePackFile(JSON.stringify(file))).toThrow('pieces[0].states[1].face');
	});

	it('rejects a states list that is not an array', () => {
		expect(() => parsePackFile(JSON.stringify(withStates({ '0': {} })))).toThrow(
			'pieces[0].states'
		);
	});

	it('rejects a spawn state that is not a state index', () => {
		const file = withStates([{ face: 'https://x/a.png' }], { state: -1 });
		expect(() => parsePackFile(JSON.stringify(file))).toThrow('pieces[0].state');
	});

	it('rejects a die with a shape we have no geometry for', () => {
		const file = { ...valid(), pieces: [{ kind: 'die', name: 'd7', sides: 7, position: [0, 0] }] };
		expect(() => parsePackFile(JSON.stringify(file))).toThrow('pieces[0].sides');
	});

	it('round-trips a die piece', () => {
		const file = {
			...valid(),
			pieces: [{ kind: 'die', name: 'd20', sides: 20, position: [1, 2] }]
		};
		expect(parsePackFile(JSON.stringify(file)).pieces?.[0]).toMatchObject({
			kind: 'die',
			sides: 20
		});
	});

	const bag = (contents: unknown[], over: Record<string, unknown> = {}) => ({
		...valid(),
		pieces: [{ kind: 'bag', name: 'Bag', position: [0, 0], contents, ...over }]
	});

	it('points at the offending bag item', () => {
		expect(() => parsePackFile(JSON.stringify(bag([{ kind: 'token' }])))).toThrow(
			'pieces[0].contents[0].name'
		);
		expect(() => parsePackFile(JSON.stringify(bag([{ kind: 'card', code: 'a' }])))).toThrow(
			'pieces[0].contents[0].face'
		);
	});

	it('rejects a bag inside a bag — containers do not nest', () => {
		expect(() =>
			parsePackFile(JSON.stringify(bag([{ kind: 'bag', name: 'Inner', contents: [] }])))
		).toThrow('pieces[0].contents[0].kind');
	});

	it('rejects a die in a bag — an item has nowhere to keep `sides`', () => {
		expect(() =>
			parsePackFile(JSON.stringify(bag([{ kind: 'die', name: 'd6', sides: 6 }])))
		).toThrow('pieces[0].contents[0].kind');
	});

	it('rejects an unknown draw mode', () => {
		expect(() => parsePackFile(JSON.stringify(bag([], { drawMode: 'shuffle' })))).toThrow(
			'pieces[0].drawMode'
		);
	});

	it('rejects contents that are not an array', () => {
		expect(() => parsePackFile(JSON.stringify(bag('lots' as unknown as [])))).toThrow(
			'pieces[0].contents'
		);
	});
});
