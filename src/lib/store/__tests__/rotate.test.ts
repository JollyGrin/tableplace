/**
 * Rotation steps (tableplace-200): Q and E turn a card, deck or piece by the
 * table's rotation step.
 *
 * The kinds keep their yaw in different slots and units — a card in
 * `rotation[2]` degrees, a piece in `rotation[1]` degrees, a deck in
 * `rotation[1]` RADIANS with the opposite sign — and mixing them up has
 * already shipped once. So every kind gets its own test, and one more pins the
 * thing that matters to a player: the same key turns every kind the same way
 * on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { dragStore } from '$lib/store/dragStore.svelte';
import { hoveredPiece } from '$lib/store/pieceUi';
import { setSelection } from '$lib/store/selection';
import { nearestTurn, turnYaw, validRotationStep, yawDegrees } from '$lib/utils/yaw';
import { resolveDrop } from '$lib/utils/transforms/drop';
import { ROTATION_STEP_DEFAULT } from '$lib/utils/constants-rotation';
import { parseScenarioFile } from '$lib/scenario/file';
import { composeScenario } from '$lib/compose/scenario';
import type { GameDTO } from '$lib/store/game/types';

vi.mock('svelte-french-toast', () => ({
	default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}));

const { gameActions } = await import('$lib/store/game/actions');
const { rotationStep } = await import('$lib/store/game/actions/rotate');
const { handleVerbKeyDown } = await import('$lib/verbs/keyboard');
const { verbReference } = await import('$lib/verbs/registry');

const game = () => get(gameStore)!;
const CARD = 'card:p1:a';
const DECK = 'deck:p1:0';
const PAWN = 'piece:p1:pawn-0';

function table(over: Partial<GameDTO> = {}) {
	gameStore.set({
		players: { p1: { id: 'p1', seat: 0, joinTimestamp: 0, tray: {}, metadata: {} } },
		cards: {
			[CARD]: { position: [0, 0.26, 0], rotation: [180, 0, 0], faceImageUrl: 'f.png' }
		},
		decks: {
			[DECK]: { id: DECK, position: [4, 0.4, 0], rotation: [0, 0, 0], cards: [] }
		},
		pieces: {
			[PAWN]: { position: [-4, 0.16, 0], rotation: [0, 0, 0], kind: 'pawn', name: 'Pawn' }
		},
		...over
	});
}

/** the three.js yaw each renderer draws, clockwise-from-above degrees */
const drawn = {
	// Card.svelte: rotation.y = -z (in degrees → radians)
	card: (r: readonly number[]) => wrap(r[2]),
	// Piece.svelte: rotation.y = -y (degrees)
	piece: (r: readonly number[]) => wrap(r[1]),
	// Deck.svelte: rotation.y = y (radians), so clockwise is negative
	deck: (r: readonly number[]) => wrap(-r[1] / DEG2RAD)
};
function wrap(deg: number) {
	return Math.round((((deg % 360) + 360) % 360) * 1e6) / 1e6;
}

function press(code: string, repeat = false) {
	handleVerbKeyDown({ code, shiftKey: false, repeat, target: null } as unknown as KeyboardEvent);
}

function pointer(over: { deck?: string; piece?: string; card?: string; dragging?: string } = {}) {
	dragStore.update((state) => ({
		...state,
		isDeckHovered: over.deck ?? null,
		isHovered: over.card ?? null,
		isDragging: over.dragging ?? null
	}));
	hoveredPiece.set(over.piece ?? null);
}

beforeEach(() => {
	table();
	pointer();
	vi.spyOn(gameActions, 'getMe').mockReturnValue({ id: 'p1' } as never);
});

describe('turnYaw, per kind', () => {
	it('card: degrees on rotation[2], the face-down flip untouched', () => {
		expect(turnYaw('card', [180, 0, 0], 45)).toEqual([180, 0, 45]);
		expect(turnYaw('card', [180, 0, 0], -45)).toEqual([180, 0, 315]);
		expect(turnYaw('card', [0, 0, 330], 45)).toEqual([0, 0, 15]);
	});

	it('piece: degrees on rotation[1]', () => {
		expect(turnYaw('piece', [0, 0, 0], 45)).toEqual([0, 45, 0]);
		expect(turnYaw('piece', [0, 90, 0], -135)).toEqual([0, 315, 0]);
	});

	it('deck: RADIANS on rotation[1], clockwise is negative', () => {
		const [x, y, z] = turnYaw('deck', [0, 0, 0], 90);
		expect([x, z]).toEqual([0, 0]);
		// -90° clockwise, wrapped into [0, 2π): 270° in radians — never 90 * 57
		expect(y).toBeCloseTo((3 * Math.PI) / 2, 9);
		expect(yawDegrees('deck', [x, y, z])).toBe(90);
		// the seat-1 default [0, π, 0] turns from where it is
		expect(turnYaw('deck', [0, Math.PI, 0], 45)[1]).toBeCloseTo(Math.PI - Math.PI / 4, 9);
	});

	it('every kind turns the same way on screen for the same key', () => {
		for (const kind of ['card', 'deck', 'piece'] as const) {
			expect(drawn[kind](turnYaw(kind, [0, 0, 0], 45)), kind).toBe(45);
			expect(drawn[kind](turnYaw(kind, [0, 0, 0], -45)), kind).toBe(315);
		}
	});

	it('never grows without bound: 16 turns of 45° come back to the start', () => {
		for (const kind of ['card', 'deck', 'piece'] as const) {
			let r: [number, number, number] = [0, 0, 0];
			for (let i = 0; i < 16; i++) r = turnYaw(kind, r, 45);
			expect(yawDegrees(kind, r), kind).toBe(0);
		}
	});
});

describe('nearestTurn — the shortest arc a yaw spring takes', () => {
	it('315° → 0° goes on to 360°, not back through 180°', () => {
		expect(nearestTurn(315, 0)).toBe(360);
		expect(nearestTurn(0, 315)).toBe(-45);
		expect(nearestTurn(720, 45)).toBe(765);
	});

	it('works in radians for a deck', () => {
		expect(nearestTurn(0.1, Math.PI * 2 - 0.1, Math.PI * 2)).toBeCloseTo(-0.1, 9);
	});
});

describe('rotateEntity, per kind, through the store', () => {
	it('card', () => {
		gameActions.rotateEntity('card', CARD, 45);
		expect(game().cards![CARD]!.rotation).toEqual([180, 0, 45]);
	});

	it('deck', () => {
		gameActions.rotateEntity('deck', DECK, 45);
		expect(yawDegrees('deck', game().decks![DECK]!.rotation)).toBe(45);
		expect(game().decks![DECK]!.rotation![1]).toBeCloseTo(2 * Math.PI - Math.PI / 4, 9);
	});

	it('piece', () => {
		gameActions.rotateEntity('piece', PAWN, -45);
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 315, 0]);
	});

	it('a pinned entity does not turn', () => {
		gameActions.setLocked('piece', PAWN, true);
		gameActions.rotateEntity('piece', PAWN, 45);
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 0, 0]);
	});

	it('a selection turns each member in place by the step, in one patch, skipping the pinned', () => {
		gameActions.setLocked('card', CARD, true);
		setSelection([CARD, DECK, PAWN]);
		const spy = vi.spyOn(gameStore, 'updateState');
		pointer();
		press('KeyE');
		expect(spy).toHaveBeenCalledTimes(1);
		expect(game().cards![CARD]!.rotation).toEqual([180, 0, 0]);
		expect(yawDegrees('deck', game().decks![DECK]!.rotation)).toBe(45);
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 45, 0]);
		expect(game().decks![DECK]!.position).toEqual([4, 0.4, 0]);
		spy.mockRestore();
		setSelection([]);
	});
});

describe('the rotation step', () => {
	it('defaults to 45°', () => {
		expect(ROTATION_STEP_DEFAULT).toBe(45);
		expect(rotationStep()).toBe(45);
	});

	it('reads the table setting, and ignores one out of range', () => {
		gameActions.setRotationStep(60);
		expect(rotationStep()).toBe(60);
		gameActions.setRotationStep(720);
		expect(rotationStep()).toBe(60);
		gameActions.setRotationStep(null);
		expect(game().table?.rotationStep).toBeUndefined();
		expect(rotationStep()).toBe(45);
	});

	it('accepts (0, 360] only', () => {
		expect(validRotationStep(15)).toBe(15);
		expect(validRotationStep(360)).toBe(360);
		for (const bad of [0, -45, 361, NaN, Infinity, '45', null]) {
			expect(validRotationStep(bad), String(bad)).toBeUndefined();
		}
	});
});

describe('Q and E', () => {
	it('turn a hovered pawn by the step: E clockwise, Q back', () => {
		pointer({ piece: PAWN });
		press('KeyE');
		press('KeyE');
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 90, 0]);
		press('KeyQ');
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 45, 0]);
	});

	it('turn a hovered card and a hovered deck the same way', () => {
		pointer({ card: CARD });
		press('KeyE');
		expect(drawn.card(game().cards![CARD]!.rotation!)).toBe(45);
		pointer({ deck: DECK });
		press('KeyE');
		expect(drawn.deck(game().decks![DECK]!.rotation!)).toBe(45);
	});

	it("use the scenario's step", () => {
		gameActions.setRotationStep(60);
		pointer({ piece: PAWN });
		press('KeyQ');
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 300, 0]);
	});

	it('leave T and R on a card as 90° taps', () => {
		gameActions.setRotationStep(15);
		pointer({ card: CARD });
		press('KeyT');
		expect(game().cards![CARD]!.rotation).toEqual([180, 0, 90]);
	});

	it('ignore auto-repeat: a held key is one turn, one patch', () => {
		pointer({ piece: PAWN });
		press('KeyE');
		press('KeyE', true);
		press('KeyE', true);
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 45, 0]);
	});

	it('turn what is carried, not what it is carried over', () => {
		// a pawn in hand over a deck: the pawn turns
		pointer({ dragging: PAWN, piece: PAWN, deck: DECK });
		press('KeyE');
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 45, 0]);
		expect(game().decks![DECK]!.rotation).toEqual([0, 0, 0]);
		// a card in hand over a deck: the card turns
		pointer({ dragging: CARD, card: CARD, deck: DECK });
		press('KeyQ');
		expect(game().cards![CARD]!.rotation).toEqual([180, 0, 315]);
		expect(game().decks![DECK]!.rotation).toEqual([0, 0, 0]);
		// a pile being moved turns too
		pointer({ dragging: DECK, deck: DECK });
		press('KeyE');
		expect(yawDegrees('deck', game().decks![DECK]!.rotation)).toBe(45);
	});

	it('refuse a pinned target', () => {
		gameActions.setLocked('piece', PAWN, true);
		pointer({ piece: PAWN });
		press('KeyE');
		expect(game().pieces![PAWN]!.rotation).toEqual([0, 0, 0]);
	});

	it('are listed for cards, decks and pieces in the ? reference', () => {
		const sections = verbReference();
		for (const title of ['Card', 'Deck', 'Piece']) {
			const keys = sections.find((s) => s.title === title)!.rows.map((r) => r.key);
			expect(keys, title).toEqual(expect.arrayContaining(['Q', 'E']));
		}
	});
});

describe('a snap point still wins the landing yaw', () => {
	it('after Q/E turned the carried thing, the point authors where it faces', () => {
		gameStore.updateState({
			snapPoints: { 'snap:0': { id: 'snap:0', position: [6, -3], radius: 1, rotation: 90 } }
		});
		gameActions.rotateEntity('piece', PAWN, 45);
		gameActions.rotateEntity('card', CARD, 45);
		gameActions.rotateEntity('deck', DECK, 45);
		const at = { x: 6, z: -3 };
		expect(resolveDrop(game(), PAWN, at)?.rotation).toEqual([0, 90, 0]);
		expect(resolveDrop(game(), CARD, at)?.rotation).toEqual([180, 0, 90]);
		expect(resolveDrop(game(), DECK, at)?.rotation[1]).toBeCloseTo(90 * DEG2RAD, 9);
	});
});

describe('scenario rotationStep', () => {
	const file = (extra: Record<string, unknown>) =>
		JSON.stringify({ tbps: 1, name: 'Board', state: {}, ...extra });

	it('parses, and composes into the synced table settings', () => {
		const scenario = parseScenarioFile(file({ rotationStep: 60 }));
		expect(scenario.rotationStep).toBe(60);
		expect(composeScenario(scenario, new Map()).table).toEqual({ rotationStep: 60 });
	});

	it('is absent unless authored', () => {
		const scenario = parseScenarioFile(file({}));
		expect('rotationStep' in scenario).toBe(false);
		expect(composeScenario(scenario, new Map()).table).toBeUndefined();
	});

	it('refuses a step out of range', () => {
		expect(() => parseScenarioFile(file({ rotationStep: 0 }))).toThrow(/rotationStep/);
		expect(() => parseScenarioFile(file({ rotationStep: 400 }))).toThrow(/rotationStep/);
		expect(() => parseScenarioFile(file({ rotationStep: '45' }))).toThrow(/rotationStep/);
	});
});
