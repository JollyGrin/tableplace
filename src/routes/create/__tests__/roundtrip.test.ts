/**
 * The /create acceptance path: import a real TTS fixture, edit it with every
 * implemented primitive (all piece kinds, overlays, all three face-ref
 * schemes), export it as tbpp, and load the export back through the same
 * validator + spawnPack that /setup uses. The exported file is checked
 * against the published pack.schema.json, not just the runtime parser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'svelte/store';
import Ajv from 'ajv';
import { parseSavedObject } from '$lib/tts/parse';
import { ttsToPack } from '$lib/tts/to-pack';
import { parsePackFile, serializePackFile } from '$lib/packs/file';
import { spawnPack, spawnPackDeck } from '$lib/packs/spawn';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { makeSheetRef } from '$lib/packs/resolve.svelte';
import type { GamePackDef } from '$lib/packs/types';
import {
	withEditorDefaults,
	withBagItemDefaults,
	cleanForExport,
	type EditorPack,
	type EditorPiece
} from '../normalize';

const cloneFixture = JSON.parse(
	readFileSync(join(__dirname, '../../../../tts-clonetroopers.json'), 'utf-8')
);

// strict:false — the schema carries `x-tableplace-*` provenance annotations,
// which ajv's strict mode would reject as unknown keywords
const validatePack = new Ajv({ strict: false }).compile(
	JSON.parse(readFileSync(join(__dirname, '../../../../static/pack.schema.json'), 'utf-8'))
);

/** Mirrors the /create workflow: TTS import → edits in the pane → export text */
function importEditExport(): { draft: EditorPack; exported: string } {
	// import: the same pipeline the pane runs on a picked TTS file
	const draft = withEditorDefaults(ttsToPack(parseSavedObject(cloneFixture)));

	// edit: touch metadata and cards, then author every primitive the pane offers
	draft.name = 'Clone Troopers (edited)';
	draft.decks[0].cards[0].name = 'Renamed Card';
	draft.decks[0].cards.push(
		{ code: 'AS', name: 'Ace of Spades', face: 'gen:std52/AS', orientation: 'portrait' },
		// a sideways card (tableplace-132): only 'landscape' ships in the file
		{ code: 'site', name: 'Site', face: 'gen:std52/KH', orientation: 'landscape' }
	);
	const editorPiece = (over: Partial<EditorPiece>): EditorPiece => ({
		kind: 'token',
		name: '',
		color: '#c8c4b8',
		imageUrl: '',
		model: '',
		radius: 0.75,
		maxValue: 20,
		minValue: 0,
		states: [],
		state: 0,
		contents: [],
		drawMode: 'random',
		infinite: false,
		snap: true,
		reach: 0,
		locked: false,
		position: [0, 0],
		rotation: 0,
		...over
	});

	draft.pieces.push(
		editorPiece({
			kind: 'token',
			name: 'Objective',
			imageUrl: 'https://example.com/token.png',
			position: [1, 1]
		}),
		editorPiece({
			kind: 'pawn',
			name: 'Runner',
			color: '#3366ff',
			radius: 0.3,
			reach: 3,
			position: [2, -1]
		}),
		editorPiece({
			kind: 'counter',
			name: 'HP',
			color: '#b3202e',
			radius: 0.6,
			maxValue: 12,
			minValue: 2,
			position: [3, 0]
		}),
		// a multi-state token: three faces, one per face-ref scheme, spawning
		// on the last one
		editorPiece({
			kind: 'token',
			name: 'Brazier',
			radius: 0.8,
			states: [
				{ face: 'https://example.com/brazier-lit.png', name: 'Lit' },
				{ face: 'gen:std52/AS', name: 'Embers' },
				{
					face: makeSheetRef({ url: 'https://example.com/sheet.png', cols: 3, rows: 2, index: 4 }),
					name: 'Out'
				},
				// an empty row the author never filled in: dropped on export
				{ face: '', name: '' }
			],
			state: 2,
			position: [4, 2]
		}),
		// a bag with one item of every kind it can hold, the pane's own defaults
		// filled in by withBagItemDefaults exactly as "Add … to bag" does
		editorPiece({
			kind: 'bag',
			name: 'Tile Bag',
			color: '#7c2d12',
			radius: 0.9,
			drawMode: 'lifo',
			infinite: true,
			position: [6, -2],
			contents: [
				withBagItemDefaults({ kind: 'token', name: 'Ember', color: '#f97316' }),
				withBagItemDefaults({ kind: 'pawn', name: 'Scout' }),
				withBagItemDefaults({ kind: 'counter', name: 'Dial', maxValue: 5 }),
				withBagItemDefaults({
					kind: 'card',
					code: 'omen',
					name: 'Omen',
					face: 'https://example.com/omen.png'
				})
			]
		})
	);
	draft.overlays.push({
		imageUrl: 'https://example.com/map.png',
		ratio: 1.5,
		scale: 12,
		locked: false
	});

	return { draft, exported: serializePackFile(cleanForExport(draft)) };
}

describe('/create round-trip (tts-clonetroopers.json)', () => {
	it('imports, edits, exports valid tbpp, and parses back identically', () => {
		const { draft, exported } = importEditExport();
		const reparsed = parsePackFile(exported);

		expect(reparsed).toEqual(cleanForExport(draft));
		expect(reparsed.source).toBe('tts');
		expect(reparsed.decks[0].cards.length).toBeGreaterThan(1); // fixture content survived
	});

	it('exports a file the published pack.schema.json accepts', () => {
		const file = JSON.parse(importEditExport().exported);
		const ok = validatePack(file);
		expect(validatePack.errors ?? []).toEqual([]);
		expect(ok).toBe(true);

		// the schema has teeth: a malformed piece is caught
		expect(validatePack({ ...file, pieces: [{ kind: 'dice', name: 'd6' }] })).toBe(false);
		// …including a bag inside a bag, which the format does not allow
		expect(
			validatePack({
				...file,
				pieces: [
					{
						kind: 'bag',
						name: 'Nested',
						position: [0, 0],
						contents: [{ kind: 'bag', name: 'Inner' }]
					}
				]
			})
		).toBe(false);
	});

	it('covers every implemented piece kind, overlays, and all three face-ref schemes', () => {
		const pack = parsePackFile(importEditExport().exported);

		expect(new Set(pack.pieces?.map((p) => p.kind))).toEqual(
			new Set(['token', 'pawn', 'counter', 'bag'])
		);
		expect(pack.overlays?.length).toBe(1);

		const faces = pack.decks.flatMap((d) => [d.back, ...d.cards.map((c) => c.face)]);
		expect(faces.some((f) => f.startsWith('sheet:'))).toBe(true);
		expect(faces.some((f) => f.startsWith('gen:'))).toBe(true);
		expect(pack.pieces?.some((p) => p.imageUrl?.startsWith('https:'))).toBe(true);
	});

	it('authors a multi-state token: faces survive, empty rows do not', () => {
		const pack = parsePackFile(importEditExport().exported);
		const brazier = pack.pieces?.find((p) => p.name === 'Brazier');

		expect(brazier?.states).toEqual([
			{ face: 'https://example.com/brazier-lit.png', name: 'Lit' },
			{ face: 'gen:std52/AS', name: 'Embers' },
			{
				face: makeSheetRef({ url: 'https://example.com/sheet.png', cols: 3, rows: 2, index: 4 }),
				name: 'Out'
			}
		]);
		// all three face-ref schemes, mixed within one piece
		expect(brazier?.states?.[0].face.startsWith('https:')).toBe(true);
		expect(brazier?.states?.[1].face.startsWith('gen:')).toBe(true);
		expect(brazier?.states?.[2].face.startsWith('sheet:')).toBe(true);
		// states[0] is the base face, so imageUrl mirrors it even though the
		// editor's own Image URL field was left empty
		expect(brazier?.imageUrl).toBe('https://example.com/brazier-lit.png');
		expect(brazier?.state).toBe(2);
	});

	it('ships a landscape orientation and strips the portrait default', () => {
		const pack = parsePackFile(importEditExport().exported);
		const cards = pack.decks[0].cards;
		expect(cards.find((c) => c.code === 'site')?.orientation).toBe('landscape');
		expect(cards.find((c) => c.code === 'AS')?.orientation).toBeUndefined();
	});

	it('strips editing defaults instead of shipping them', () => {
		const pack = parsePackFile(importEditExport().exported);
		const pawn = pack.pieces?.find((p) => p.name === 'Runner');
		expect(pawn?.kind).toBe('pawn');
		expect(pawn?.imageUrl).toBeUndefined(); // empty image URL never ships
		expect(pawn?.maxValue).toBeUndefined(); // maxValue is counters-only
		expect(pack.pieces?.find((p) => p.name === 'HP')?.maxValue).toBe(12);
		// a counter's floor ships; the editor's 0 (the default) never does
		expect(pack.pieces?.find((p) => p.name === 'HP')?.minValue).toBe(2);
		expect(pawn?.minValue).toBeUndefined();
		// bag fields are bags-only, and the flat editor item narrows back down
		expect(pawn?.contents).toBeUndefined();
		expect(pawn?.drawMode).toBeUndefined();
		expect(pawn?.infinite).toBeUndefined();
		// a reach ships; the editor's 0 ("none") never does (tableplace-190)
		expect(pawn?.reach).toBe(3);
		expect(pack.pieces?.find((p) => p.name === 'HP')?.reach).toBeUndefined();
	});

	it('exports a bag with its contents, draw mode, and infinite flag', () => {
		const bag = parsePackFile(importEditExport().exported).pieces?.find((p) => p.kind === 'bag');

		expect(bag).toMatchObject({ name: 'Tile Bag', drawMode: 'lifo', infinite: true });
		expect(bag?.contents).toEqual([
			{ kind: 'token', name: 'Ember', color: '#f97316', radius: 0.75 },
			{ kind: 'pawn', name: 'Scout', color: '#c8c4b8', radius: 0.3 },
			{ kind: 'counter', name: 'Dial', color: '#c8c4b8', radius: 0.6, maxValue: 5 },
			// a card item carries the face-ref fields and none of the piece ones
			{ kind: 'card', code: 'omen', name: 'Omen', face: 'https://example.com/omen.png' }
		]);
	});

	it('does not corrupt an untouched import', () => {
		const imported = ttsToPack(parseSavedObject(cloneFixture));
		const roundTripped = parsePackFile(
			serializePackFile(cleanForExport(withEditorDefaults(imported)))
		);
		// decks, cards, and face refs come back byte-identical; pieces may gain
		// explicit editor defaults (color/radius) but never lose authored data
		expect(roundTripped.decks).toEqual(imported.decks);
		expect(roundTripped.pieces?.length).toBe(imported.pieces?.length);
		for (const [i, piece] of (imported.pieces ?? []).entries()) {
			expect(roundTripped.pieces?.[i]).toMatchObject(piece);
		}
	});
});

describe('spawnPack — the /setup load path for an exported pack', () => {
	beforeEach(() => {
		gameStore.set({ players: { seat0: { id: 'seat0', seat: 0, tray: {} } } } as never);
		localStorage.setItem('myPlayerId', 'seat0');
	});

	it('spawns decks, pieces, and overlays', () => {
		const pack = parsePackFile(importEditExport().exported);
		spawnPack(pack, { ownerId: 'seat0' });

		const s = get(gameStore);
		const deckIds = Object.keys(s.decks ?? {});
		expect(deckIds.length).toBe(pack.decks.length);
		const spawnedCards = deckIds.flatMap((id) => s.decks?.[id]?.cards ?? []);
		expect(spawnedCards.length).toBe(pack.decks.reduce((n, d) => n + d.cards.length, 0));
		// every deck carries the provenance stamp that lets a scenario re-resolve it
		expect(s.decks?.[deckIds[0]]?.packOrigin).toMatchObject({ pack: pack.id });

		const pieces = Object.values(s.pieces ?? {});
		expect(pieces.length).toBe(pack.pieces?.length);
		expect(pieces.find((p) => p?.name === 'HP')?.value).toBe(12); // counters spawn full

		// a multi-state piece lands with every face and on its authored state
		const brazier = pieces.find((p) => p?.name === 'Brazier');
		expect(brazier?.states).toHaveLength(3);
		expect(brazier?.state).toBe(2);

		// a spawned bag arrives loaded, so /play can draw from it immediately
		const bag = pieces.find((p) => p?.kind === 'bag');
		expect(bag).toMatchObject({ drawMode: 'lifo', infinite: true });
		expect(bag?.contents).toHaveLength(4);

		expect(Object.values(s.overlays ?? {}).length).toBe(pack.overlays?.length);
	});

	it('passes every face-ref scheme through to spawned cards untouched', () => {
		const pack: GamePackDef = {
			id: 'schemes',
			name: 'Schemes',
			scope: 'player',
			decks: [
				{
					slot: 'main',
					name: 'Main',
					back: 'gen:std52/back',
					cards: [
						{ code: 'a', face: 'https://example.com/a.png' },
						{ code: 'b', face: 'gen:std52/2H' },
						{
							code: 'c',
							face: makeSheetRef({
								url: 'https://example.com/s.png',
								cols: 2,
								rows: 2,
								index: 3
							})
						}
					]
				}
			]
		};
		// the editor previews through spawnPackDeck with shuffle off, which is the
		// only way to get authored order — spawnPack shuffles facedown decks
		spawnPackDeck(pack, pack.decks[0], { ownerId: 'seat0', shuffle: false });
		const cards = get(gameStore).decks?.['deck:seat0:main']?.cards ?? [];
		expect(cards.map((c) => c.faceImageUrl)).toEqual(pack.decks[0].cards.map((c) => c.face));
	});

	it('shuffles a facedown deck but keeps every card', () => {
		const pack: GamePackDef = {
			id: 'shuffled',
			name: 'Shuffled',
			scope: 'player',
			decks: [
				{
					slot: 'main',
					name: 'Main',
					back: 'gen:std52/back',
					cards: Array.from({ length: 20 }, (_, i) => ({
						code: `c${i}`,
						face: `gen:std52/${i}S`
					}))
				}
			]
		};
		spawnPack(pack, { ownerId: 'seat0' });
		const cards = get(gameStore).decks?.['deck:seat0:main']?.cards ?? [];
		expect(new Set(cards.map((c) => c.faceImageUrl))).toEqual(
			new Set(pack.decks[0].cards.map((c) => c.face))
		);
	});

	it('places decks relative to the owner seat, without a local player', () => {
		// no myPlayerId and no player entry: the scenario/pack editors spawn for
		// placeholder seats that no real player occupies
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} } as never);
		localStorage.removeItem('myPlayerId');

		const deck = (slot: string) => ({
			slot,
			name: slot,
			back: 'gen:std52/back',
			cards: [{ code: 'a', face: 'gen:std52/AS' }]
		});
		const pack: GamePackDef = {
			id: 'seats',
			name: 'Seats',
			scope: 'player',
			decks: [deck('main'), deck('discard')]
		};

		spawnPack(pack, { ownerId: 'seat1' });
		const decks = get(gameStore).decks ?? {};
		expect(decks['deck:seat1:main']?.position).toEqual([8.5, 0.4, -4.7]); // far seat
		expect(decks['deck:seat1:discard']?.position).toEqual([11, 0.4, -4.7]); // fanned sideways
		expect(decks['deck:seat1:main']?.rotation?.[1]).toBeCloseTo(Math.PI);

		spawnPack(pack, { ownerId: 'seat0' });
		expect(get(gameStore).decks?.['deck:seat0:main']?.position).toEqual([8.5, 0.4, 4.5]);
	});
});
