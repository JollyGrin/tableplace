/**
 * Snap points have to survive the whole authoring pipeline — /setup edit →
 * save → export → import → load — and land in the store in the shape the drop
 * resolver reads (tableplace-96).
 *
 * The file keeps them as a top-level array with no ids; the store keys them
 * `snap:<n>`. Everything below is about that translation holding in both
 * directions, and about a scenario with no snap points behaving as it always
 * did.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { resolveDrop } from '$lib/utils/transforms/drop';
import { SNAP_RADIUS_DEFAULT } from '$lib/utils/constants-snap';
import { CARD_REST_Y } from '$lib/utils/constants-cards';
import { serializeScenarioFile } from '../file';
import {
	applyScenario,
	ensureSeatPlaceholder,
	importScenarioFromText,
	saveScenario,
	seatPlaceholderId
} from '../scenario';

const emptyTable = () =>
	gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {}, overlays: {}, snapPoints: {} });

const snapPointsInStore = () => get(gameStore).snapPoints ?? {};

describe('authoring snap points in /setup', () => {
	beforeEach(() => {
		localStorage.clear();
		emptyTable();
	});

	it('places, moves and deletes through ordinary state patches', () => {
		const first = gameActions.addSnapPoint({ position: [3, 1], rotation: 90 });
		const second = gameActions.addSnapPoint({ position: [-3, 1] });
		expect(gameActions.snapPointIds()).toEqual([first, second]);
		expect(snapPointsInStore()[first]).toMatchObject({
			id: first,
			position: [3, 1],
			rotation: 90,
			radius: SNAP_RADIUS_DEFAULT
		});

		gameActions.moveSnapPoint(first, [5, -2]);
		expect(snapPointsInStore()[first]?.position).toEqual([5, -2]);

		gameActions.updateSnapPoint(first, { radius: 2 });
		expect(snapPointsInStore()[first]?.radius).toBe(2);

		gameActions.removeSnapPoint(first);
		expect(snapPointsInStore()[first]).toBeUndefined();
		expect(gameActions.snapPointIds()).toEqual([second]);
	});

	it('clears an authored rotation back to "no rotation"', () => {
		const id = gameActions.addSnapPoint({ position: [0, 0], rotation: 45 });
		gameActions.updateSnapPoint(id, { rotation: undefined });
		expect(snapPointsInStore()[id]?.rotation).toBeUndefined();
	});

	it('keeps ids clear of the points still on the table', () => {
		gameActions.addSnapPoint({ position: [0, 0] });
		const middle = gameActions.addSnapPoint({ position: [1, 1] });
		gameActions.addSnapPoint({ position: [2, 2] });
		gameActions.removeSnapPoint(middle);
		// one past the highest in use — never a collision with a live point
		expect(gameActions.addSnapPoint({ position: [3, 3] })).toBe('snap:3');
	});

	it('clamps a placement inside the felt', () => {
		const id = gameActions.addSnapPoint({ position: [999, -999] });
		const [x, z] = snapPointsInStore()[id]?.position ?? [0, 0];
		expect(x).toBeLessThan(30);
		expect(z).toBeGreaterThan(-15);
	});
});

describe('snap points through save → export → import → load', () => {
	beforeEach(() => {
		localStorage.clear();
		emptyTable();
	});

	it('round-trips as a top-level array and comes back keyed in the store', async () => {
		ensureSeatPlaceholder(0);
		gameActions.addPiece('token', { ownerId: seatPlaceholderId(0), name: 'Objective' });
		gameActions.addSnapPoint({ position: [0, 2.5], rotation: 180, radius: 1.5 });
		gameActions.addSnapPoint({ position: [-4, 0] });

		const exported = serializeScenarioFile(saveScenario('snappy'));
		expect(JSON.parse(exported).snapPoints).toEqual([
			{ position: [0, 2.5], rotation: 180, radius: 1.5 },
			{ position: [-4, 0], radius: SNAP_RADIUS_DEFAULT }
		]);

		emptyTable();
		await applyScenario(importScenarioFromText(exported));
		expect(Object.values(snapPointsInStore())).toEqual([
			{ id: 'snap:0', position: [0, 2.5], rotation: 180, radius: 1.5 },
			{ id: 'snap:1', position: [-4, 0], radius: SNAP_RADIUS_DEFAULT }
		]);
	});

	it('replaces the points already on the table instead of merging into them', async () => {
		gameActions.addSnapPoint({ position: [7, 7] });
		gameActions.addSnapPoint({ position: [8, 8] });
		const stale = saveScenario('two-points');

		emptyTable();
		gameActions.addSnapPoint({ position: [1, 1] });
		gameActions.addSnapPoint({ position: [2, 2] });
		gameActions.addSnapPoint({ position: [3, 3] });
		await applyScenario(stale);

		expect(gameActions.snapPointIds()).toEqual(['snap:0', 'snap:1']);
		expect(snapPointsInStore()['snap:0']?.position).toEqual([7, 7]);
	});

	it('loads a scenario that has no snap points without inventing any', async () => {
		ensureSeatPlaceholder(0);
		gameActions.addPiece('token', { ownerId: seatPlaceholderId(0), name: 'Objective' });
		const scenario = saveScenario('plain');
		expect('snapPoints' in scenario).toBe(false);

		emptyTable();
		gameActions.addSnapPoint({ position: [1, 1] });
		await applyScenario(scenario);
		expect(gameActions.snapPointIds()).toEqual([]);
	});

	it('round-trips elevation and the grid variant (tableplace-134)', async () => {
		gameActions.addSnapPoint({ position: [0, 2.5], y: 2, rotation: 180 });
		gameActions.addSnapPoint({
			position: [6, -3],
			kind: 'grid',
			pitch: 2.5,
			cols: 4,
			rows: 2,
			yawStep: 45,
			y: 1
		});

		const exported = serializeScenarioFile(saveScenario('elevated-grid'));
		expect(JSON.parse(exported).snapPoints).toEqual([
			{ position: [0, 2.5], y: 2, rotation: 180, radius: SNAP_RADIUS_DEFAULT },
			{
				position: [6, -3],
				y: 1,
				radius: SNAP_RADIUS_DEFAULT,
				kind: 'grid',
				pitch: 2.5,
				cols: 4,
				rows: 2,
				yawStep: 45
			}
		]);

		emptyTable();
		await applyScenario(importScenarioFromText(exported));
		expect(snapPointsInStore()['snap:0']).toMatchObject({ position: [0, 2.5], y: 2 });
		expect(snapPointsInStore()['snap:1']).toMatchObject({
			kind: 'grid',
			pitch: 2.5,
			cols: 4,
			rows: 2,
			yawStep: 45,
			y: 1
		});
	});

	it('refuses a grid missing its lattice fields, naming the field', () => {
		const file = (snapPoint: Record<string, unknown>) =>
			JSON.stringify({ tbps: 1, name: 'bad', createdAt: 1, state: {}, snapPoints: [snapPoint] });
		expect(() => importScenarioFromText(file({ position: [0, 0], kind: 'grid' }))).toThrow(/pitch/);
		expect(() =>
			importScenarioFromText(file({ position: [0, 0], kind: 'grid', pitch: 2, rows: 2 }))
		).toThrow(/cols/);
		expect(() => importScenarioFromText(file({ position: [0, 0], y: 'high' }))).toThrow(/\.y/);
	});

	it('round-trips a piece snap opt-out through the state snapshot', async () => {
		ensureSeatPlaceholder(0);
		const id = gameActions.addPiece('token', {
			ownerId: seatPlaceholderId(0),
			name: 'Loose prop'
		});
		gameActions.setPieceSnap(id, false);
		expect(get(gameStore).pieces?.[id]?.snap).toBe(false);

		const exported = serializeScenarioFile(saveScenario('loose-prop'));
		emptyTable();
		await applyScenario(importScenarioFromText(exported));
		expect(get(gameStore).pieces?.[id]?.snap).toBe(false);

		// and turning it back on deletes the field instead of writing `true`
		gameActions.setPieceSnap(id, true);
		expect(get(gameStore).pieces?.[id]?.snap).toBeUndefined();
	});

	it('draws, removes and tags links between points (tableplace-190)', () => {
		const [a, b, c] = [
			[0, 0],
			[3, 0],
			[6, 0]
		].map((p) => gameActions.addSnapPoint({ position: p as [number, number] }));
		expect(gameActions.toggleSnapLink(a!, b!)).toBe(true);
		expect(gameActions.toggleSnapLink(b!, c!)).toBe(true);
		// written on both ends
		expect(snapPointsInStore()[a!]?.links).toEqual([b]);
		expect(snapPointsInStore()[b!]?.links).toEqual([a, c]);
		// toggling from the other end removes it from both; an empty list is deleted
		expect(gameActions.toggleSnapLink(b!, a!)).toBe(false);
		expect(snapPointsInStore()[a!]?.links).toBeUndefined();
		expect(snapPointsInStore()[b!]?.links).toEqual([c]);
		// a removed point takes its links with it
		gameActions.removeSnapPoint(c!);
		expect(snapPointsInStore()[b!]?.links).toBeUndefined();

		gameActions.setSnapTags(a!, [' north ', '', 'north', 'edge']);
		expect(snapPointsInStore()[a!]?.tags).toEqual(['north', 'edge']);
		gameActions.setSnapTags(a!, []);
		expect(snapPointsInStore()[a!]?.tags).toBeUndefined();
	});

	it('round-trips links, tags and reach, renumbering links to the exported order', async () => {
		ensureSeatPlaceholder(0);
		const runner = gameActions.addPiece('token', { ownerId: seatPlaceholderId(0), name: 'Runner' });
		gameActions.setPieceReach(runner, 2);
		const [a, gone, b, c] = [
			[0, 0],
			[1, 1],
			[3, 0],
			[6, 0]
		].map((p) => gameActions.addSnapPoint({ position: p as [number, number] }));
		gameActions.toggleSnapLink(a!, b!);
		gameActions.toggleSnapLink(b!, c!);
		gameActions.setSnapTags(c!, ['exit']);
		// snap:1 goes, so snap:2/snap:3 export as indices 1/2 — links must follow
		gameActions.removeSnapPoint(gone!);

		const exported = serializeScenarioFile(saveScenario('linked'));
		const file = JSON.parse(exported);
		expect(file.snapPoints.map((p: { links?: string[] }) => p.links)).toEqual([
			['snap:1'],
			['snap:0', 'snap:2'],
			['snap:1']
		]);
		expect(file.snapPoints[2].tags).toEqual(['exit']);

		emptyTable();
		await applyScenario(importScenarioFromText(exported));
		expect(snapPointsInStore()['snap:1']).toMatchObject({
			position: [3, 0],
			links: ['snap:0', 'snap:2']
		});
		expect(snapPointsInStore()['snap:2']?.tags).toEqual(['exit']);
		expect(get(gameStore).pieces?.[runner]?.reach).toBe(2);

		gameActions.setPieceReach(runner, 0);
		expect(get(gameStore).pieces?.[runner]?.reach).toBeUndefined();
	});

	it('refuses links or tags that are not string arrays', () => {
		const file = (snapPoint: Record<string, unknown>) =>
			JSON.stringify({ tbps: 1, name: 'bad', createdAt: 1, state: {}, snapPoints: [snapPoint] });
		expect(() => importScenarioFromText(file({ position: [0, 0], links: 'snap:1' }))).toThrow(
			/links/
		);
		expect(() => importScenarioFromText(file({ position: [0, 0], tags: [1] }))).toThrow(/tags/);
		// a link to an index that doesn't exist is fine — it's ignored at lift time
		expect(() =>
			importScenarioFromText(file({ position: [0, 0], links: ['snap:9'] }))
		).not.toThrow();
	});

	it('a landscape card landed on a grid keeps its orientation and still taps on the 90° lattice', () => {
		// tableplace-132 composition: `orientation` is a render-only quarter
		// turn and the synced rotation[2] stays orientation-relative. The grid
		// steps that synced yaw, the commit writes position + rotation only, so
		// the orientation field survives the landing — and tapCard (additive on
		// rotation[2]) keeps working in 90° steps afterwards.
		const id = 'card:seat0:site';
		gameStore.updateState({
			cards: {
				[id]: {
					position: [0, 2, 0],
					rotation: [0, 0, 130],
					faceImageUrl: 'f.png',
					orientation: 'landscape'
				}
			}
		});
		gameActions.addSnapPoint({ position: [10, 2], kind: 'grid', pitch: 2, cols: 3, rows: 3 });

		const drop = resolveDrop(get(gameStore), id, { x: 10, z: 2 });
		expect(drop?.kind).toBe('snap');
		// commit the exact patch a release writes: position + rotation, nothing else
		gameStore.updateState({
			cards: { [id]: { position: drop!.position, rotation: drop!.rotation } }
		});

		const landed = get(gameStore).cards?.[id];
		expect(landed?.orientation).toBe('landscape'); // untouched by the landing
		expect(landed?.rotation?.[2]).toBe(90); // 130 stepped in SYNCED space

		gameActions.tapCard(false, id);
		expect(get(gameStore).cards?.[id]?.rotation?.[2]).toBe(180); // still 90° steps
	});

	it('leaves a loaded table where a dropped card actually snaps', async () => {
		const scenario = importScenarioFromText(
			JSON.stringify({
				tbps: 1,
				name: 'board',
				createdAt: 1,
				state: {
					cards: { 'card:seat0:a': { position: [0, 2, 0], rotation: [0, 0, 0] } }
				},
				snapPoints: [{ position: [6, 3], rotation: 90, radius: 1 }]
			})
		);
		emptyTable();
		await applyScenario(scenario);

		const drop = resolveDrop(get(gameStore), 'card:seat0:a', { x: 6.5, z: 3 });
		expect(drop).toMatchObject({
			kind: 'snap',
			position: [6, CARD_REST_Y, 3],
			rotation: [0, 0, 90]
		});
	});
});
