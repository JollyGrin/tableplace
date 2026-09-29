/**
 * `locked` through every format (tableplace-189): a TTS `Locked` object imports
 * pinned, the pack file keeps it, spawning carries it onto the table, a
 * scenario placement can lay content down pinned (how a layout pins a board),
 * and /create exports it only when set.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { parseSavedObject } from '../parse';
import { ttsToPack } from '../to-pack';
import { parsePackFile, serializePackFile } from '$lib/packs/file';
import { spawnPackDeck, spawnPackOverlay, spawnPackPiece } from '$lib/packs/spawn';
import { composeScenario } from '$lib/compose/scenario';
import { parseScenarioFile } from '$lib/scenario/file';
import { ensureSeatPlaceholder, saveScenario, seatPlaceholderId } from '$lib/scenario/scenario';
import { cleanForExport, withEditorDefaults } from '../../../routes/create/normalize';
import type { GamePackDef } from '$lib/packs/types';

const sheet = { FaceURL: 'https://x/f.png', BackURL: 'https://x/b.png', NumWidth: 1, NumHeight: 1 };

const save = {
	ObjectStates: [
		{
			Name: 'Custom_Tile',
			Nickname: 'Board',
			Locked: true,
			CustomImage: { ImageURL: 'https://x/board.png' },
			Transform: { posX: 1, posZ: 2, scaleX: 5 }
		},
		{ Name: 'Custom_Tile', Nickname: 'Token', CustomImage: { ImageURL: 'https://x/t.png' } },
		{
			Name: 'DeckCustom',
			Nickname: 'Pinned pile',
			Locked: true,
			DeckIDs: [100, 101],
			CustomDeck: { '1': sheet }
		},
		{ Name: 'Bag', Nickname: 'Supply', Locked: true, ContainedObjects: [] }
	]
};

const PACK: GamePackDef = {
	id: 'lock-pack',
	name: 'Lock pack',
	scope: 'table',
	decks: [{ slot: 'main', name: 'Main', back: 'https://x/b.png', cards: [] }],
	pieces: [
		{ kind: 'token', name: 'Board', position: [0, 0], locked: true },
		{ kind: 'token', name: 'Loose', position: [2, 0] }
	],
	overlays: [{ imageUrl: 'https://x/map.png', ratio: 1, scale: 10 }]
};

beforeEach(() => {
	localStorage.clear();
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {}, overlays: {} } as never);
});

describe('TTS Locked', () => {
	it('maps one to one onto pieces, bags and decks — and only when set', () => {
		const pack = ttsToPack(parseSavedObject(save));
		const [board, token, bag] = pack.pieces ?? [];
		expect(board).toMatchObject({ name: 'Board', locked: true });
		expect(token).not.toHaveProperty('locked');
		expect(bag).toMatchObject({ kind: 'bag', locked: true });
		expect(pack.decks[0]).toMatchObject({ name: 'Pinned pile', locked: true });
	});

	it('survives the pack file and arrives on the table pinned', () => {
		const pack = parsePackFile(serializePackFile(ttsToPack(parseSavedObject(save))));
		expect(pack.pieces?.[0].locked).toBe(true);
		spawnPackPiece(pack, 0, { ownerId: 'me' });
		spawnPackPiece(pack, 1, { ownerId: 'me' });
		spawnPackDeck(pack, pack.decks[0], { ownerId: 'me' });
		const { pieces, decks } = get(gameStore);
		const byName = (name: string) => Object.values(pieces ?? {}).find((p) => p?.name === name);
		expect(byName('Board')?.locked).toBe(true);
		expect(byName('Token')).not.toHaveProperty('locked');
		expect(Object.values(decks ?? {})[0]?.locked).toBe(true);
	});
});

describe('pack files', () => {
	it('keep locked on decks, pieces and overlays', () => {
		const text = serializePackFile({
			...PACK,
			decks: [{ ...PACK.decks[0], locked: true }],
			overlays: [{ ...PACK.overlays![0], locked: true }]
		});
		const pack = parsePackFile(text);
		expect(pack.decks[0].locked).toBe(true);
		expect(pack.pieces?.[0].locked).toBe(true);
		expect(pack.overlays?.[0].locked).toBe(true);
		spawnPackOverlay(pack, 0);
		expect(Object.values(get(gameStore).overlays ?? {})[0]?.locked).toBe(true);
	});

	it('/create exports it only when ticked', () => {
		const editor = withEditorDefaults(PACK);
		expect(editor.pieces.map((p) => p.locked)).toEqual([true, false]);
		expect(editor.decks[0].locked).toBe(false);
		editor.overlays[0].locked = true;
		const out = cleanForExport(editor as unknown as GamePackDef);
		expect(out.pieces?.[0].locked).toBe(true);
		expect(out.pieces?.[1]).not.toHaveProperty('locked');
		expect(out.decks[0]).not.toHaveProperty('locked');
		expect(out.overlays?.[0].locked).toBe(true);
	});
});

describe('scenario placements', () => {
	const packs = new Map([[PACK.id, PACK]]);

	it('can lay any content down pinned, or unpin what the pack pins', () => {
		const scenario = parseScenarioFile(
			JSON.stringify({
				format: 'tbps',
				version: 2,
				name: 'layout',
				packs: [{ id: PACK.id, source: 'builtin' }],
				placements: [
					{ kind: 'overlay', pack: PACK.id, content: '0', locked: true },
					{ kind: 'piece', pack: PACK.id, content: '1', seat: 0, locked: true },
					{ kind: 'piece', pack: PACK.id, content: '0', seat: 0, locked: false },
					{ kind: 'deck', pack: PACK.id, content: 'main', seat: 0, locked: true }
				],
				state: { cards: {}, decks: {}, players: {} }
			})
		);
		const state = composeScenario(scenario, packs);
		const pieces = Object.values(state.pieces ?? {});
		expect(Object.values(state.overlays ?? {})[0]?.locked).toBe(true);
		expect(pieces.find((p) => p?.name === 'Loose')?.locked).toBe(true);
		expect(pieces.find((p) => p?.name === 'Board')).not.toHaveProperty('locked');
		expect(Object.values(state.decks ?? {})[0]?.locked).toBe(true);
	});

	it('/setup saves a pinned entity back into its placement', () => {
		ensureSeatPlaceholder(0);
		spawnPackPiece(PACK, 0, { ownerId: seatPlaceholderId(0) });
		spawnPackPiece(PACK, 1, { ownerId: seatPlaceholderId(0) });
		const placements = saveScenario('pinned').placements ?? [];
		expect(placements.find((p) => p.content === '0')?.locked).toBe(true);
		expect(placements.find((p) => p.content === '1')).not.toHaveProperty('locked');
	});
});
