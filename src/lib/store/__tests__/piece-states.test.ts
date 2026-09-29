/**
 * Multi-state pieces end to end (tableplace-95): the /play verbs, and the
 * pack → table → scenario → table trip that has to preserve which face a
 * piece was left on.
 *
 * The verbs go through `gameStore.updateState` like every other mutation,
 * which is what makes them sync — asserted here as "the patch is on the store",
 * since the websocket wrapper is what turns that into a broadcast.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';
import { hoveredPiece, setPieceHover, clearPieceHover } from '../pieceUi';
import { handleVerbKeyDown } from '$lib/verbs/keyboard';

const pressX = (shiftKey = false) =>
	handleVerbKeyDown({ code: 'KeyX', shiftKey, target: null } as unknown as KeyboardEvent);
import { spawnPack, spawnPackPiece } from '$lib/packs/spawn';
import { parsePackFile, serializePackFile } from '$lib/packs/file';
import { saveLibraryPack, PACK_SOURCE_LOCAL } from '$lib/packs/library';
import { resolveDrop } from '$lib/utils/transforms/drop';
import { commitActiveDrag } from '$lib/drop/commit';
import { dragStart, dragStore } from '../dragStore.svelte';
import { PIECE_REST_Y } from '$lib/utils/constants-pieces';
import {
	applyScenario,
	ensureSeatPlaceholder,
	saveScenario,
	seatPlaceholderId
} from '$lib/scenario/scenario';
import { serializeScenarioFile, parseScenarioFile } from '$lib/scenario/file';
import type { GamePackDef } from '$lib/packs/types';

const PACK: GamePackDef = {
	id: 'braziers',
	name: 'Braziers',
	scope: 'table',
	decks: [],
	pieces: [
		{
			kind: 'token',
			name: 'Brazier',
			imageUrl: 'https://x/lit.png',
			states: [
				{ face: 'https://x/lit.png', name: 'Lit' },
				{ face: 'https://x/embers.png', name: 'Embers' },
				{ face: 'https://x/out.png', name: 'Out' }
			],
			position: [0, 0]
		}
	]
};

const emptyTable = () =>
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {}, overlays: {} });

/** the single piece on the table */
const only = () => Object.entries(get(gameStore).pieces ?? {})[0] as [string, { state?: number }];

describe('spawning a multi-state piece', () => {
	beforeEach(() => {
		emptyTable();
		ensureSeatPlaceholder(0);
	});

	it('carries every face onto the entity, so a client without the pack renders it', () => {
		spawnPackPiece(PACK, 0, { ownerId: 'seat0' });
		const [, piece] = only();
		expect(piece).toMatchObject({
			imageUrl: 'https://x/lit.png',
			state: 0,
			states: [
				{ face: 'https://x/lit.png', name: 'Lit' },
				{ face: 'https://x/embers.png', name: 'Embers' },
				{ face: 'https://x/out.png', name: 'Out' }
			]
		});
	});

	it('starts on the requested state', () => {
		spawnPackPiece(PACK, 0, { ownerId: 'seat0', state: 2 });
		expect(only()[1].state).toBe(2);
	});

	it("falls back to the pack's own default state", () => {
		spawnPackPiece({ ...PACK, pieces: [{ ...PACK.pieces![0], state: 1 }] }, 0, {
			ownerId: 'seat0'
		});
		expect(only()[1].state).toBe(1);
	});

	it('clamps a state index the pack does not have', () => {
		spawnPackPiece(PACK, 0, { ownerId: 'seat0', state: 9 });
		expect(only()[1].state).toBe(2);
	});
});

describe('the cycle / select verbs', () => {
	let id: string;

	beforeEach(() => {
		emptyTable();
		ensureSeatPlaceholder(0);
		spawnPackPiece(PACK, 0, { ownerId: 'seat0' });
		id = only()[0];
	});

	it('cycles forward and wraps past the last state', () => {
		gameActions.cyclePieceState(id);
		expect(only()[1].state).toBe(1);
		gameActions.cyclePieceState(id);
		gameActions.cyclePieceState(id);
		expect(only()[1].state).toBe(0);
	});

	it('cycles backwards (Shift+X) from the base face', () => {
		gameActions.cyclePieceState(id, -1);
		expect(only()[1].state).toBe(2);
	});

	it('selects a state directly — what the right-click menu does', () => {
		gameActions.setPieceState(id, 2);
		expect(only()[1].state).toBe(2);
	});

	it('writes the change as a store patch, which is what syncs it', () => {
		const spy = vi.spyOn(gameStore, 'updateState');
		gameActions.setPieceState(id, 1);
		expect(spy).toHaveBeenCalledWith({ pieces: { [id]: { state: 1 } } });
		spy.mockRestore();
	});

	it('does nothing for a piece with a single face', () => {
		const plain = gameActions.addPiece('token', { ownerId: 'seat0', name: 'Plain' });
		gameActions.cyclePieceState(plain);
		gameActions.setPieceState(plain, 1);
		expect(get(gameStore).pieces?.[plain]?.state).toBeUndefined();
	});
});

describe('the X hotkey acts on the hovered piece', () => {
	let id: string;

	beforeEach(() => {
		emptyTable();
		ensureSeatPlaceholder(0);
		spawnPackPiece(PACK, 0, { ownerId: 'seat0' });
		id = only()[0];
		hoveredPiece.set(null);
	});

	it('does nothing when no piece is hovered', () => {
		pressX();
		expect(only()[1].state).toBe(0);
	});

	it('cycles the hovered piece', () => {
		setPieceHover(id);
		pressX();
		expect(only()[1].state).toBe(1);
		// Shift+X steps back
		pressX(true);
		expect(only()[1].state).toBe(0);
	});

	it('only the piece that claimed the hover may release it', () => {
		setPieceHover(id);
		clearPieceHover('piece:seat0:someone-else-0');
		expect(get(hoveredPiece)).toBe(id);
		clearPieceHover(id);
		expect(get(hoveredPiece)).toBeNull();
	});
});

describe('scenario round-trip', () => {
	beforeEach(() => {
		localStorage.clear();
		emptyTable();
		ensureSeatPlaceholder(0);
	});

	it('saves the face a piece was left on, and restores it on load', async () => {
		spawnPackPiece(PACK, 0, {
			ownerId: seatPlaceholderId(0),
			source: 'https://x/braziers.tbpp.json'
		});
		gameActions.setPieceState(only()[0], 2);

		const scenario = saveScenario('braziers');
		const placement = scenario.placements?.find((p) => p.kind === 'piece');
		expect(placement?.state).toBe(2);

		// through the file, as an export/import would go
		const reparsed = parseScenarioFile(serializeScenarioFile(scenario));
		expect(reparsed.placements?.[0].state).toBe(2);

		// and back onto a table: the pack resolves from the same id
		emptyTable();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ tbpp: 1, ...PACK }))
		);
		const report = await applyScenario(reparsed);
		vi.restoreAllMocks();

		expect(report.failedPacks).toEqual([]);
		expect(only()[1].state).toBe(2);
	});

	it('leaves the field out for a piece still on its base face', () => {
		spawnPackPiece(PACK, 0, { ownerId: seatPlaceholderId(0) });
		const scenario = saveScenario('base');
		expect(scenario.placements?.[0].state).toBeUndefined();
	});
});

/**
 * Composition with the local pack library (tableplace-93): a pack that lives
 * only in this browser re-resolves through `source: 'local'`, with no fetch
 * and nothing hosted. That is the path an authored multi-state piece actually
 * takes, so the faces AND the face it was left on have to come back — the one
 * end-to-end trip that never touches the network.
 */
describe('a multi-state piece from the local pack library', () => {
	beforeEach(() => {
		localStorage.clear();
		emptyTable();
		ensureSeatPlaceholder(0);
	});

	it('survives open-from-disk → spawn → cycle → save → reload on the same state', async () => {
		// "opened from disk": the file's own bytes through the real validator
		const fromDisk = parsePackFile(serializePackFile(PACK));
		saveLibraryPack(fromDisk);

		// no explicit source: spawnPack stamps 'local' because the library has it
		spawnPack(fromDisk, { ownerId: seatPlaceholderId(0) });
		const [id, spawned] = only();
		expect((spawned as { packOrigin?: { source?: string } }).packOrigin?.source).toBe(
			PACK_SOURCE_LOCAL
		);

		// cycle it twice in play: Lit → Embers → Out
		gameActions.cyclePieceState(id);
		gameActions.cyclePieceState(id);
		expect(only()[1].state).toBe(2);

		const saved = parseScenarioFile(serializeScenarioFile(saveScenario('local-braziers')));
		expect(saved.packs).toEqual([{ id: 'braziers', source: PACK_SOURCE_LOCAL }]);

		// reload with the network hard-failed: a local pack must need no fetch
		emptyTable();
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('no network for a local pack'));
		const report = await applyScenario(saved);
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.restoreAllMocks();

		expect(report.failedPacks).toEqual([]);
		const [, reloaded] = only();
		expect(reloaded).toMatchObject({
			state: 2,
			states: PACK.pieces![0].states!,
			// states[0] stays the base face across the whole trip
			imageUrl: 'https://x/lit.png'
		});
	});
});

/**
 * Composition with authored snap points (tableplace-96): a multi-state piece
 * is dropped like any other piece, so it must land on the point — and the
 * landing patch must not disturb the face it is showing.
 */
describe('dropping a multi-state piece near a snap point', () => {
	const SNAP = { 'snap:0': { id: 'snap:0', position: [6, 3] as [number, number], radius: 1 } };

	beforeEach(() => {
		emptyTable();
		ensureSeatPlaceholder(0);
		spawnPackPiece(PACK, 0, { ownerId: 'seat0' });
		gameActions.setPieceState(only()[0], 1);
		gameStore.updateState({ snapPoints: SNAP });
		dragStore.set({
			isDragging: null,
			isHovered: null,
			isDeckHovered: null,
			isBagHovered: null,
			isTrayHovered: false
		});
	});

	it('snaps it onto the point, states and current face untouched', () => {
		const [id] = only();
		dragStart(id, 2);
		dragStore.update((s) => ({ ...s, intersectionPoint: { x: 6.4, z: 3.2 } as never }));
		commitActiveDrag();

		const [, piece] = only();
		expect(piece).toMatchObject({ position: [6, PIECE_REST_Y, 3], state: 1 });
		expect((piece as { states?: unknown[] }).states).toHaveLength(3);
	});

	it('resolves as a snap for a piece carrying states, same as a plain one', () => {
		const drop = resolveDrop(get(gameStore), only()[0], { x: 6.4, z: 3.2 } as never);
		expect(drop?.kind).toBe('snap');
		expect(drop?.snap?.id).toBe('snap:0');
	});
});
