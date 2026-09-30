import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	parseSavedObject,
	normalizeAssetUrl,
	decodeCardId,
	extractCounterMax,
	extractCounterMin
} from '../parse';
import { ttsToPack } from '../to-pack';

// Real the-unmatched.club exports committed as fixtures
const fixture = JSON.parse(
	readFileSync(join(__dirname, '../../../../tts-unmatched-greviousdeck.json'), 'utf-8')
);
const cloneFixture = JSON.parse(
	readFileSync(join(__dirname, '../../../../tts-clonetroopers.json'), 'utf-8')
);

describe('normalizeAssetUrl', () => {
	it('rewrites the dead Steam host', () => {
		expect(normalizeAssetUrl('http://cloud-3.steamusercontent.com/ugc/123/ABC/')).toBe(
			'https://steamusercontent-a.akamaihd.net/ugc/123/ABC/'
		);
	});

	it('forces https and leaves modern URLs alone', () => {
		expect(normalizeAssetUrl('http://example.com/x.png')).toBe('https://example.com/x.png');
		expect(normalizeAssetUrl('https://a.r2.dev/x.png?v=1')).toBe('https://a.r2.dev/x.png?v=1');
	});
});

describe('decodeCardId', () => {
	it('splits sheet key and cell index', () => {
		expect(decodeCardId(200)).toEqual({ sheetKey: '2', index: 0 });
		expect(decodeCardId(214)).toEqual({ sheetKey: '2', index: 14 });
		expect(decodeCardId(40007)).toEqual({ sheetKey: '400', index: 7 });
	});
});

describe('parseSavedObject on a real unmatched.club export', () => {
	const parsed = parseSavedObject(fixture);

	it('finds the 30-card General Grievous deck', () => {
		expect(parsed.decks).toHaveLength(1);
		expect(parsed.decks[0].name).toBe('General Grievous');
		expect(parsed.decks[0].cards).toHaveLength(30);
	});

	it('preserves card names from ContainedObjects', () => {
		expect(parsed.decks[0].cards[0].name).toBe('Fear, Surprise, & Intimidation');
	});

	it('maps CardIDs onto the 10x2 action-card sheet', () => {
		const card = parsed.decks[0].cards[0];
		expect(card.face.cols).toBe(10);
		expect(card.face.rows).toBe(2);
		expect(card.face.index).toBe(0);
		expect(card.face.url).toMatch(/^https:\/\//);
	});

	it('collects loose cards (hero + special)', () => {
		expect(parsed.looseCards.length).toBeGreaterThan(0);
	});

	it('extracts tiles as tokens, pawns, and health dials as counters', () => {
		const kinds = parsed.pieces.map((p) => p.kind);
		expect(kinds).toContain('token');
		expect(kinds).toContain('pawn');
		expect(kinds).toContain('counter');
		const tokens = parsed.pieces.filter((p) => p.kind === 'token');
		expect(tokens.every((t) => t.imageUrl?.startsWith('https://'))).toBe(true);
	});

	it('handles empty/garbage input without throwing', () => {
		expect(parseSavedObject({})).toEqual({ decks: [], looseCards: [], pieces: [], skipped: [] });
		expect(parseSavedObject(null)).toEqual({ decks: [], looseCards: [], pieces: [], skipped: [] });
	});
});

describe('pieces on the Clone Troopers export', () => {
	const parsed = parseSavedObject(cloneFixture);

	it('finds the hero pawn with its faction color', () => {
		const pawn = parsed.pieces.find((p) => p.kind === 'pawn');
		expect(pawn?.name).toBe('Clone Troopers');
		expect(pawn?.color).toMatch(/^#/);
	});

	it('turns the health-dial Custom_Model into a counter with HP from Lua', () => {
		const counter = parsed.pieces.find((p) => p.kind === 'counter');
		expect(counter?.maxValue).toBe(2);
	});
});

describe('bags (Bag / Infinite_Bag)', () => {
	const sheet = {
		FaceURL: 'https://example.com/sheet.png',
		BackURL: 'https://example.com/back.png',
		NumWidth: 2,
		NumHeight: 1
	};

	/** a container holding one card, one deck of two, a tile, and two rejects */
	const bagSave = (over: Record<string, unknown> = {}) => ({
		ObjectStates: [
			{
				Name: 'Bag',
				Nickname: 'Tile Bag',
				Transform: { posX: 3, posZ: 5, scaleX: 1.4 },
				ColorDiffuse: { r: 0.4, g: 0.2, b: 0.1 },
				Bag: { Order: 1 },
				ContainedObjects: [
					{ Name: 'Card', Nickname: 'Omen', CardID: 100, CustomDeck: { '1': sheet } },
					{
						Name: 'DeckCustom',
						Nickname: 'Inner Deck',
						DeckIDs: [100, 101],
						CustomDeck: { '1': sheet },
						ContainedObjects: [{ Nickname: 'Inner A' }, { Nickname: 'Inner B' }]
					},
					{
						Name: 'Custom_Tile',
						Nickname: 'Ember',
						CustomImage: { ImageURL: 'https://example.com/ember.png' },
						Transform: { scaleX: 0.8 }
					},
					{ Name: 'Bag', Nickname: 'Nested Bag', ContainedObjects: [] },
					{ Name: 'Custom_Assetbundle', Nickname: 'Fancy Thing' }
				],
				...over
			}
		]
	});

	const parsed = parseSavedObject(bagSave());
	const bag = parsed.pieces[0];

	it('imports the container as a bag piece, positioned and coloured', () => {
		expect(parsed.pieces).toHaveLength(1);
		expect(bag).toMatchObject({ kind: 'bag', name: 'Tile Bag', position: [3, -5] });
		expect(bag.color).toMatch(/^#/);
		expect(bag.radius).toBeCloseTo(1.4);
	});

	it('flattens one level: the loose card, the inner deck’s cards, and the tile', () => {
		expect(bag.contents?.map((item) => `${item.kind}:${item.name}`)).toEqual([
			'card:Omen',
			'card:Inner A',
			'card:Inner B',
			'token:Ember'
		]);
	});

	it('keeps sheet cells on bag cards, for to-pack to turn into refs', () => {
		const card = bag.contents?.[0];
		expect(card?.kind).toBe('card');
		if (card?.kind !== 'card') throw new Error('expected a card item');
		expect(card.face).toMatchObject({ cols: 2, rows: 1, index: 0 });
		expect(card.face.url).toBe('https://example.com/sheet.png');
	});

	it('drops position from bag items — the draw decides where they land', () => {
		const token = bag.contents?.find((item) => item.kind === 'token');
		expect(token && 'position' in token).toBe(false);
	});

	it('skips what it cannot map — a nested bag included — without failing', () => {
		expect(parsed.skipped).toEqual([
			'Nested Bag (Bag in bag)',
			'Fancy Thing (Custom_Assetbundle in bag)'
		]);
	});

	it('maps Bag.Order onto a draw mode, defaulting to random', () => {
		expect(bag.drawMode).toBe('lifo'); // Order 1
		expect(parseSavedObject(bagSave({ Bag: { Order: 2 } })).pieces[0].drawMode).toBe('fifo');
		expect(parseSavedObject(bagSave({ Bag: { Order: 0 } })).pieces[0].drawMode).toBe('random');
		// an encoding this build doesn't know must not fail the import
		expect(parseSavedObject(bagSave({ Bag: { Order: 99 } })).pieces[0].drawMode).toBe('random');
		expect(parseSavedObject(bagSave({ Bag: undefined })).pieces[0].drawMode).toBe('random');
	});

	it('marks an Infinite_Bag infinite, and a plain bag not', () => {
		const infinite = parseSavedObject({
			ObjectStates: [{ Name: 'Infinite_Bag', Nickname: 'Supply', ContainedObjects: [] }]
		}).pieces[0];
		expect(infinite).toMatchObject({ kind: 'bag', name: 'Supply', infinite: true });
		expect(bag.infinite).toBeUndefined();
	});

	it('imports an empty bag rather than dropping the object the author placed', () => {
		const empty = parseSavedObject({ ObjectStates: [{ Name: 'Bag', Nickname: 'Empty' }] });
		expect(empty.pieces[0]).toMatchObject({ kind: 'bag', name: 'Empty', contents: [] });
		expect(empty.skipped).toEqual([]);
	});
});

describe('extractCounterMax', () => {
	it('parses MAX_VALUE from TTS counter Lua', () => {
		expect(extractCounterMax('CONFIG = {\r\n MIN_VALUE = 0,\r\n MAX_VALUE = 18,')).toBe(18);
		expect(extractCounterMax('no counter here')).toBeNull();
		expect(extractCounterMax(undefined)).toBeNull();
	});
});

describe('extractCounterMin', () => {
	it('parses a signed MIN_VALUE, and drops one above the max', () => {
		expect(extractCounterMin('CONFIG = {\r\n MIN_VALUE = 3,\r\n MAX_VALUE = 18,', 18)).toBe(3);
		expect(extractCounterMin('MIN_VALUE = -10\nMAX_VALUE = 10', 10)).toBe(-10);
		expect(extractCounterMin('MIN_VALUE = 0', 18)).toBe(0);
		expect(extractCounterMin('MIN_VALUE = 30', 18)).toBeNull();
		expect(extractCounterMin('no counter here', 18)).toBeNull();
		expect(extractCounterMin(undefined, 18)).toBeNull();
	});

	it('imports the floor of a scripted counter, and into the pack', () => {
		const dial = (script: string) =>
			parseSavedObject({
				ObjectStates: [{ Name: 'Custom_Model', Nickname: 'Dial', LuaScript: script }]
			});
		const parsed = dial('MIN_VALUE = 3\nMAX_VALUE = 17');
		expect(parsed.pieces[0]).toMatchObject({ kind: 'counter', minValue: 3, maxValue: 17 });
		expect(ttsToPack(parsed).pieces?.[0]).toMatchObject({ minValue: 3, maxValue: 17 });
		// a floor of 0 is the default: no field invented
		expect(dial('MIN_VALUE = 0\nMAX_VALUE = 17').pieces[0]).not.toHaveProperty('minValue');
	});
});
