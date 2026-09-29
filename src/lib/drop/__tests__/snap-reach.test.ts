import { describe, expect, it } from 'vitest';
import type { GameDTO } from '$lib/store/game/types';
import {
	liftReachSet,
	occupiedSnapPoints,
	pieceReach,
	snapLinkGraph,
	snapPointsWithinReach
} from '../snap-reach';

type Points = NonNullable<GameDTO['snapPoints']>;

/** a row of points 3 apart on z = 0, `snap:0` at x = 0, linked as given */
function row(links: Record<number, number[] | string[]>, count = 6): Points {
	const points: Points = {};
	for (let i = 0; i < count; i++) {
		const id = `snap:${i}`;
		const own = links[i];
		points[id] = {
			id,
			position: [i * 3, 0],
			...(own ? { links: own.map((l) => (typeof l === 'number' ? `snap:${l}` : l)) } : {})
		};
	}
	return points;
}

const within = (points: Points, from: string, reach: number) =>
	Object.fromEntries(snapPointsWithinReach(snapLinkGraph(points), from, reach));

describe('snapLinkGraph', () => {
	it('is undirected: a link written on one end joins both', () => {
		const graph = snapLinkGraph(row({ 0: [1] }, 2));
		expect([...graph.get('snap:0')!]).toEqual(['snap:1']);
		expect([...graph.get('snap:1')!]).toEqual(['snap:0']);
	});

	it('ignores missing targets, removed points, self links and junk entries', () => {
		const points = row({ 0: ['snap:1', 'snap:99', 'snap:0', 'snap:2'] }, 3);
		points['snap:2'] = null;
		(points['snap:1'] as { links: unknown }).links = [42, null];
		const graph = snapLinkGraph(points);
		expect([...graph.get('snap:0')!]).toEqual(['snap:1']);
		expect(graph.has('snap:99')).toBe(false);
		expect(graph.has('snap:2')).toBe(false);
	});

	it('is empty for a scenario without links', () => {
		expect(snapLinkGraph(row({})).size).toBe(0);
		expect(snapLinkGraph(undefined).size).toBe(0);
	});
});

describe('snapPointsWithinReach (breadth-first)', () => {
	it('walks a chain out to exactly `reach` links, with each point at its distance', () => {
		const chain = row({ 0: [1], 1: [2], 2: [3], 3: [4], 4: [5] });
		expect(within(chain, 'snap:0', 2)).toEqual({ 'snap:0': 0, 'snap:1': 1, 'snap:2': 2 });
		expect(within(chain, 'snap:2', 1)).toEqual({ 'snap:1': 1, 'snap:2': 0, 'snap:3': 1 });
	});

	it('terminates on a cycle and keeps the shortest distance round it', () => {
		// a ring of six: 0-1-2-3-4-5-0
		const ring = row({ 0: [1], 1: [2], 2: [3], 3: [4], 4: [5], 5: [0] });
		expect(within(ring, 'snap:0', 2)).toEqual({
			'snap:0': 0,
			'snap:1': 1,
			'snap:5': 1,
			'snap:2': 2,
			'snap:4': 2
		});
		// a reach bigger than the ring visits every point once
		expect(Object.keys(within(ring, 'snap:0', 50)).sort()).toEqual(
			['snap:0', 'snap:1', 'snap:2', 'snap:3', 'snap:4', 'snap:5'].sort()
		);
		expect(within(ring, 'snap:0', 50)['snap:3']).toBe(3);
	});

	it('handles a two-point cycle (links written on both ends) and self links', () => {
		const pair = row({ 0: ['snap:1', 'snap:0'], 1: ['snap:0'] }, 2);
		expect(within(pair, 'snap:0', 3)).toEqual({ 'snap:0': 0, 'snap:1': 1 });
	});

	it('walks past a missing link target as if it were not there', () => {
		const points = row({ 0: ['snap:77', 'snap:1'], 1: ['snap:missing', 'snap:2'] }, 3);
		expect(within(points, 'snap:0', 2)).toEqual({ 'snap:0': 0, 'snap:1': 1, 'snap:2': 2 });
	});

	it('reach 0 is just the origin; a nonsense reach is nothing', () => {
		const chain = row({ 0: [1] }, 2);
		expect(within(chain, 'snap:0', 0)).toEqual({ 'snap:0': 0 });
		expect(within(chain, 'snap:0', -1)).toEqual({});
		expect(within(chain, 'snap:0', Number.NaN)).toEqual({});
	});
});

describe('pieceReach', () => {
	it('accepts a whole number ≥ 0 only', () => {
		expect(pieceReach({ reach: 2 })).toBe(2);
		expect(pieceReach({ reach: 0 })).toBe(0);
		expect(pieceReach({ reach: 1.5 })).toBeNull();
		expect(pieceReach({ reach: -1 })).toBeNull();
		expect(pieceReach({})).toBeNull();
		expect(pieceReach(null)).toBeNull();
	});
});

describe('occupiedSnapPoints', () => {
	it('marks a discrete point with a card, deck or piece in its catch radius, except the lifted one', () => {
		const state: Partial<GameDTO> = {
			snapPoints: row({}, 4),
			cards: { 'card:a:x': { position: [0.2, 0.1, 0] } as never },
			decks: { 'deck:a:0': { position: [3, 0.1, 0.3] } as never },
			pieces: {
				'piece:a:lifted': { position: [6, 0.2, 0] } as never,
				'piece:a:far': { position: [7.5, 0.2, 5] } as never
			}
		};
		expect([...occupiedSnapPoints(state, 'piece:a:lifted')].sort()).toEqual(['snap:0', 'snap:1']);
	});

	it('never counts a grid as occupied', () => {
		const state: Partial<GameDTO> = {
			snapPoints: {
				'snap:0': { id: 'snap:0', position: [0, 0], kind: 'grid', pitch: 2, cols: 3, rows: 3 }
			},
			pieces: { 'piece:a:x': { position: [0, 0.2, 0] } as never }
		};
		expect(occupiedSnapPoints(state, null).size).toBe(0);
	});
});

describe('liftReachSet', () => {
	const ring = row({ 0: [1], 1: [2], 2: [3], 3: [4], 4: [5], 5: [0] });
	const lifted = 'piece:seat0:runner-0';
	const base = (extra: Partial<GameDTO> = {}, reach: number | null = 2): Partial<GameDTO> => ({
		snapPoints: ring,
		...extra,
		pieces: {
			[lifted]: { position: [20, 0.2, 20], ...(reach !== null ? { reach } : {}) } as never,
			...extra.pieces
		}
	});
	// the origin is where the piece sat before the lift, on snap:0
	const origin = [0.1, 0.2, 0];

	it('lights the points within reach, origin included', () => {
		expect([...liftReachSet(base(), lifted, origin)!].sort()).toEqual(
			['snap:0', 'snap:1', 'snap:2', 'snap:4', 'snap:5'].sort()
		);
	});

	it('leaves occupied points out of the set but walks through them', () => {
		const state = base({ pieces: { 'piece:seat1:other-0': { position: [3, 0.2, 0] } as never } });
		// snap:1 holds another piece: not a landing, still passable to snap:2
		expect([...liftReachSet(state, lifted, origin)!].sort()).toEqual(
			['snap:0', 'snap:2', 'snap:4', 'snap:5'].sort()
		);
	});

	it('is null — ordinary guides — without links, reach, a piece, or a snap-point origin', () => {
		expect(liftReachSet({ ...base(), snapPoints: row({}) }, lifted, origin)).toBeNull();
		expect(liftReachSet(base({}, null), lifted, origin)).toBeNull();
		expect(liftReachSet(base(), 'card:seat0:x', origin)).toBeNull();
		expect(liftReachSet(base(), lifted, undefined)).toBeNull();
		expect(liftReachSet(base(), lifted, [1.5, 0.2, 9])).toBeNull();
		expect(liftReachSet(base(), null, origin)).toBeNull();
	});

	it('is null when the origin point itself has no links', () => {
		const points = row({ 1: [2] });
		expect(liftReachSet({ ...base(), snapPoints: points }, lifted, origin)).toBeNull();
	});
});
