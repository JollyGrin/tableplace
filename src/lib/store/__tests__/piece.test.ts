import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '../game/gameStore.svelte';
import { gameActions } from '../game/actions';
import {
	COUNTER_MAX_DEFAULT,
	DIE_SIDES,
	PIECE_RADIUS,
	PIECE_REST_Y
} from '$lib/utils/constants-pieces';

const OWNER = 'seat0';

describe('addPiece', () => {
	beforeEach(() => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	});

	it('uses the kind:owner:slug id convention so claimSeat can rename the owner', () => {
		const id = gameActions.addPiece('token', { ownerId: OWNER, name: 'Blast Marker' });
		expect(id).toBe('piece:seat0:blast-marker-0');
		expect(id.split(':')[1]).toBe(OWNER);
	});

	it('disambiguates repeats of the same name', () => {
		const first = gameActions.addPiece('pawn', { ownerId: OWNER, name: 'Hero' });
		const second = gameActions.addPiece('pawn', { ownerId: OWNER, name: 'Hero' });
		expect([first, second]).toEqual(['piece:seat0:hero-0', 'piece:seat0:hero-1']);
		expect(Object.keys(get(gameStore).pieces ?? {})).toHaveLength(2);
	});

	it('falls back to the kind when the name has no slug characters', () => {
		expect(gameActions.addPiece('counter', { ownerId: OWNER, name: '!!!' })).toBe(
			'piece:seat0:counter-0'
		);
	});

	it('applies per-kind defaults', () => {
		const token = gameActions.addPiece('token', { ownerId: OWNER });
		const pawn = gameActions.addPiece('pawn', { ownerId: OWNER });
		const counter = gameActions.addPiece('counter', { ownerId: OWNER });
		const pieces = get(gameStore).pieces ?? {};

		expect(pieces[token]).toMatchObject({
			kind: 'token',
			name: 'Token',
			radius: PIECE_RADIUS.token
		});
		expect(pieces[pawn]).toMatchObject({ kind: 'pawn', name: 'Pawn', radius: PIECE_RADIUS.pawn });
		expect(pieces[counter]).toMatchObject({ kind: 'counter', radius: PIECE_RADIUS.counter });
	});

	it('spawns counters full: value = maxValue', () => {
		const dial = gameActions.addPiece('counter', { ownerId: OWNER, maxValue: 30 });
		const fallback = gameActions.addPiece('counter', { ownerId: OWNER, name: 'Dial 2' });
		const pieces = get(gameStore).pieces ?? {};

		expect(pieces[dial]).toMatchObject({ value: 30, maxValue: 30 });
		expect(pieces[fallback]).toMatchObject({
			value: COUNTER_MAX_DEFAULT,
			maxValue: COUNTER_MAX_DEFAULT
		});
	});

	it('leaves counter state off non-counters', () => {
		const id = gameActions.addPiece('token', { ownerId: OWNER, maxValue: 30 });
		const piece = (get(gameStore).pieces ?? {})[id];
		expect(piece?.value).toBeUndefined();
		expect(piece?.maxValue).toBeUndefined();
	});

	it('carries optional color and image through', () => {
		const id = gameActions.addPiece('token', {
			ownerId: OWNER,
			color: '#ff0000',
			imageUrl: 'https://example.com/token.png'
		});
		expect((get(gameStore).pieces ?? {})[id]).toMatchObject({
			color: '#ff0000',
			imageUrl: 'https://example.com/token.png'
		});
	});

	it('spawns at piece rest height, seat-relative, fanning sideways', () => {
		const first = gameActions.addPiece('token', { ownerId: 'seat0', name: 'a' });
		const second = gameActions.addPiece('token', { ownerId: 'seat0', name: 'b' });
		const pieces = get(gameStore).pieces ?? {};

		expect(pieces[first]?.position).toEqual([0, PIECE_REST_Y, 4.5]);
		// second lands beside the first, never on top of it
		expect(pieces[second]?.position?.[0]).not.toBe(pieces[first]?.position?.[0]);
		expect(pieces[second]?.position?.[2]).toBe(4.5);
	});

	it('mirrors the spawn onto the far side for seat 1', () => {
		const id = gameActions.addPiece('token', { ownerId: 'seat1' });
		expect((get(gameStore).pieces ?? {})[id]?.position).toEqual([0, PIECE_REST_Y, -4.5]);
	});

	it('reads the seat off a real player when the owner is not a placeholder', () => {
		gameStore.set({ players: { alice: { id: 'alice', seat: 1 } }, pieces: {} });
		const id = gameActions.addPiece('token', { ownerId: 'alice' });
		expect(id).toBe('piece:alice:token-0');
		expect((get(gameStore).pieces ?? {})[id]?.position?.[2]).toBe(-4.5);
	});

	it('honours an explicit position', () => {
		const id = gameActions.addPiece('pawn', { ownerId: OWNER, position: [1, 2, 3] });
		expect((get(gameStore).pieces ?? {})[id]?.position).toEqual([1, 2, 3]);
	});

	it('defaults the owner to the local player', () => {
		localStorage.setItem('myPlayerId', 'abc123');
		expect(gameActions.addPiece('token')).toBe('piece:abc123:token-0');
		localStorage.removeItem('myPlayerId');
	});

	it('refuses to spawn with no owner at all', () => {
		localStorage.removeItem('myPlayerId');
		expect(gameActions.addPiece('token')).toBe('');
		expect(get(gameStore).pieces).toEqual({});
	});
});

describe('removePiece', () => {
	beforeEach(() => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	});

	it('drops the piece off the table', () => {
		const id = gameActions.addPiece('token', { ownerId: OWNER });
		gameActions.removePiece(id);
		expect(get(gameStore).pieces?.[id]).toBeUndefined();
	});

	it('removes pieces that arrived with any id (e.g. a TTS import)', () => {
		gameStore.set({
			pieces: {
				'piece:someone:imported-3': { kind: 'token', name: 'Imported' }
			}
		});
		gameActions.removePiece('piece:someone:imported-3');
		expect(get(gameStore).pieces).toEqual({});
	});
});

describe('incrementCounter', () => {
	beforeEach(() => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	});

	it('clamps to [0, maxValue]', () => {
		const id = gameActions.addPiece('counter', { ownerId: OWNER, maxValue: 3 });
		gameActions.incrementCounter(id, 5);
		expect(get(gameStore).pieces?.[id]?.value).toBe(3);
		gameActions.incrementCounter(id, -10);
		expect(get(gameStore).pieces?.[id]?.value).toBe(0);
		gameActions.incrementCounter(id, 2);
		expect(get(gameStore).pieces?.[id]?.value).toBe(2);
	});

	const valueOf = (id: string) => get(gameStore).pieces?.[id]?.value;

	it('holds a counter with a minimum inside [minValue, maxValue]', () => {
		const id = gameActions.addPiece('counter', { ownerId: OWNER, minValue: 3, maxValue: 17 });
		// spawns full, and carries the floor
		expect(get(gameStore).pieces?.[id]).toMatchObject({ value: 17, minValue: 3, maxValue: 17 });

		gameActions.incrementCounter(id, 1);
		expect(valueOf(id)).toBe(17);
		gameActions.incrementCounter(id, -13);
		expect(valueOf(id)).toBe(4);
		// one step at a time, the way the wheel, a click and the hotkeys arrive
		for (let i = 0; i < 5; i++) gameActions.incrementCounter(id, -1);
		expect(valueOf(id)).toBe(3);
		gameActions.incrementCounter(id, -100);
		expect(valueOf(id)).toBe(3);
		gameActions.incrementCounter(id, 100);
		expect(valueOf(id)).toBe(17);
	});

	it('lets a counter with a negative minimum run below zero', () => {
		const id = gameActions.addPiece('counter', { ownerId: OWNER, minValue: -5, maxValue: 5 });
		gameActions.incrementCounter(id, -8);
		expect(valueOf(id)).toBe(-3);
		gameActions.incrementCounter(id, -8);
		expect(valueOf(id)).toBe(-5);
	});

	it('leaves a counter without minValue exactly as it was: floor 0, no field invented', () => {
		const id = gameActions.addPiece('counter', { ownerId: OWNER, maxValue: 17 });
		expect(get(gameStore).pieces?.[id]).not.toHaveProperty('minValue');
		gameActions.incrementCounter(id, -100);
		expect(valueOf(id)).toBe(0);
		gameActions.incrementCounter(id, 100);
		expect(valueOf(id)).toBe(17);
	});

	it('resets to maxValue, whatever the minimum', () => {
		const id = gameActions.addPiece('counter', { ownerId: OWNER, minValue: 3, maxValue: 17 });
		gameActions.incrementCounter(id, -100);
		gameActions.resetCounter(id);
		expect(valueOf(id)).toBe(17);
	});

	it('a synced counter with no maxValue still runs to the open-ended ceiling', () => {
		gameStore.set({ pieces: { 'piece:a:dial-0': { kind: 'counter', value: 98, minValue: 90 } } });
		gameActions.incrementCounter('piece:a:dial-0', 5);
		expect(valueOf('piece:a:dial-0')).toBe(99);
		gameActions.incrementCounter('piece:a:dial-0', -50);
		expect(valueOf('piece:a:dial-0')).toBe(90);
	});
});

describe('dice', () => {
	beforeEach(() => {
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {} });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const roll = (id: string, random: number) => {
		vi.spyOn(Math, 'random').mockReturnValue(random);
		gameActions.rollDie(id);
		vi.restoreAllMocks();
		return get(gameStore).pieces?.[id];
	};

	it('spawns unrolled, on a face, named after its shape', () => {
		const id = gameActions.addPiece('die', { ownerId: OWNER, sides: 20 });
		expect(id).toBe('piece:seat0:d20-0');
		expect(get(gameStore).pieces?.[id]).toMatchObject({
			kind: 'die',
			sides: 20,
			value: 1,
			// nothing to replay yet, so a joining client animates nothing
			rollSeq: 0,
			radius: PIECE_RADIUS.die
		});
	});

	it('defaults to a d6', () => {
		const id = gameActions.addPiece('die', { ownerId: OWNER });
		expect(get(gameStore).pieces?.[id]).toMatchObject({ sides: 6, value: 1 });
	});

	it('leaves die state off other kinds', () => {
		const id = gameActions.addPiece('token', { ownerId: OWNER, sides: 20 });
		const piece = (get(gameStore).pieces ?? {})[id];
		expect(piece?.sides).toBeUndefined();
		expect(piece?.rollSeq).toBeUndefined();
	});

	it('rolls a face in 1…sides and bumps rollSeq, in one patch', () => {
		for (const sides of DIE_SIDES) {
			const id = gameActions.addPiece('die', { ownerId: OWNER, sides, name: `x${sides}` });
			// the extremes of Math.random are what an off-by-one shows up at
			expect(roll(id, 0)).toMatchObject({ value: 1, rollSeq: 1 });
			expect(roll(id, 0.999999)).toMatchObject({ value: sides, rollSeq: 2 });
			expect(roll(id, 0.5)).toMatchObject({ value: Math.floor(sides / 2) + 1, rollSeq: 3 });
		}
	});

	it('bumps rollSeq even when the result repeats — it is the animation trigger', () => {
		const id = gameActions.addPiece('die', { ownerId: OWNER, sides: 6 });
		expect(roll(id, 0.5)).toMatchObject({ value: 4, rollSeq: 1 });
		expect(roll(id, 0.5)).toMatchObject({ value: 4, rollSeq: 2 });
	});

	it('picks up mid-game from whatever rollSeq the lobby is already on', () => {
		gameStore.set({ pieces: { 'piece:a:d6-0': { kind: 'die', sides: 6, value: 3, rollSeq: 41 } } });
		expect(roll('piece:a:d6-0', 0)).toMatchObject({ rollSeq: 42 });
	});

	it('refuses to roll anything that is not a die', () => {
		const counter = gameActions.addPiece('counter', { ownerId: OWNER, maxValue: 10 });
		gameActions.rollDie(counter);
		gameActions.rollDie('piece:seat0:nonexistent-0');
		expect(get(gameStore).pieces?.[counter]).toMatchObject({ value: 10 });
		expect(get(gameStore).pieces?.[counter]?.rollSeq).toBeUndefined();
	});
});
