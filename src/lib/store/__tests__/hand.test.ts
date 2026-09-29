/**
 * The hand (tableplace-195): its order is a synced sort key, the fan always
 * fits the viewport, a play lands on the table's default face (Shift the
 * other one) and leaves with the card's real back, and a scenario can make
 * face-up the default.
 */
import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { dragStore } from '$lib/store/dragStore.svelte';
import {
	HAND_CARD_H,
	HAND_CARD_W,
	HAND_HOVER_SCALE,
	fanLayout,
	handCardBack,
	handOrderOf,
	handOrderPatch,
	handPlayFace,
	hoverX,
	moveInOrder,
	nextHandOrder,
	playFace,
	restSize,
	slotAt
} from '$lib/utils/hand';
import { parseScenarioFile } from '$lib/scenario/file';
import { composeScenario } from '$lib/compose/scenario';
import type { GameDTO } from '$lib/store/game/types';

vi.mock('svelte-french-toast', () => ({
	default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}));

const { gameActions } = await import('$lib/store/game/actions');
const { playFromHand, settlePlayFace, handPlay } = await import('$lib/HUDTray/handPlay');
const { hintFor } = await import('$lib/hint/hint');
const { verbReference, verbsFor } = await import('$lib/verbs/registry');

const game = () => get(gameStore)!;
const face = (code: string) => ({ faceImageUrl: `gen:std52/${code}`, name: code });
const trayOf = () => game().players?.p1?.tray ?? {};

function seed(tray: Record<string, object>, over: Partial<GameDTO> = {}) {
	localStorage.setItem('myPlayerId', 'p1');
	gameStore.set({
		players: {
			p1: { id: 'p1', seat: 0, joinTimestamp: 0, tray, metadata: {} }
		},
		cards: {},
		decks: {},
		...over
	} as never);
	dragStore.update((s) => ({ ...s, isDragging: null }));
}

describe('hand order', () => {
	it('sorts by handOrder, unnumbered cards last in record order, deleted ones skipped', () => {
		expect(
			handOrderOf({
				a: { handOrder: 2 },
				b: {},
				c: { handOrder: 0 },
				d: null,
				e: { handOrder: 1 },
				f: {}
			})
		).toEqual(['c', 'e', 'a', 'b', 'f']);
	});

	it('the next card joins the right-hand end', () => {
		expect(nextHandOrder(undefined)).toBe(0);
		expect(nextHandOrder({ a: { handOrder: 4 }, b: {} })).toBe(5);
		// never behind the count, so an unnumbered hand still appends after itself
		expect(nextHandOrder({ a: {}, b: {} })).toBe(2);
	});

	it('moves one id, clamped, and patches only the keys that changed', () => {
		expect(moveInOrder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
		expect(moveInOrder(['a', 'b', 'c'], 'c', -4)).toEqual(['c', 'a', 'b']);
		expect(moveInOrder(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']);
		const tray = { a: { handOrder: 0 }, b: { handOrder: 1 }, c: { handOrder: 2 } };
		expect(handOrderPatch(tray, ['a', 'c', 'b'])).toEqual({
			c: { handOrder: 1 },
			b: { handOrder: 2 }
		});
		expect(handOrderPatch(tray, ['a', 'b', 'c'])).toEqual({});
	});

	it('reorderHand is one patch into players[id].tray, and nothing when the order stands', () => {
		seed({ a: face('2D'), b: face('3D'), c: face('4D') });
		const spy = vi.spyOn(gameStore, 'updateState');
		gameActions.reorderHand('p1', 'a', 2);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(handOrderOf(trayOf())).toEqual(['b', 'c', 'a']);
		gameActions.reorderHand('p1', 'a', 2);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it('a table card taken into the hand goes to the end, or into the gap it was dropped on', () => {
		seed(
			{ a: { ...face('2D'), handOrder: 0 }, b: { ...face('3D'), handOrder: 1 } },
			{
				cards: {
					x: { ...face('KS'), position: [0, 0, 0], rotation: [0, 0, 0] },
					y: { ...face('QS'), position: [0, 0, 0], rotation: [0, 0, 0] }
				}
			}
		);
		gameActions.moveCardToTray('x', 'p1');
		expect(handOrderOf(trayOf())).toEqual(['a', 'b', 'x']);
		gameActions.moveCardToTray('y', 'p1', 1);
		expect(handOrderOf(trayOf())).toEqual(['a', 'y', 'b', 'x']);
		expect(game().cards?.y).toBeUndefined();
	});

	it('a draw appends in draw order; a card leaving the hand drops its key', () => {
		seed(
			{ a: { ...face('2D'), handOrder: 0 } },
			{
				decks: {
					'deck:p1:0': {
						id: 'deck:p1:0',
						position: [0, 0, 0],
						rotation: [0, 0, 0],
						cards: [
							{ id: 'd1', ...face('5C') },
							{ id: 'd2', ...face('6C') }
						]
					}
				}
			}
		);
		const drawn = gameActions.drawToHand('deck:p1:0', 2);
		expect(drawn.ok).toBe(true);
		const ids = drawn.ok ? drawn.cardIds : [];
		expect(handOrderOf(trayOf())).toEqual(['a', ...ids]);
		const loose = gameActions.moveCardOutOfTray('a', 'p1');
		expect(loose).not.toHaveProperty('handOrder');
	});
});

describe('the fan', () => {
	// 1280×800 and 400×800 CSS px through the tray's zoom-80 camera
	const viewports = [
		[1280 / 80, 800 / 80],
		[400 / 80, 800 / 80],
		[400 / 80, 700 / 80]
	] as const;

	for (const [width, height] of viewports) {
		for (const n of [1, 7, 15, 30]) {
			it(`${n} cards stay inside a ${width * 80}×${height * 80} viewport`, () => {
				const trayHeight = height / 6;
				const landscape = Array.from({ length: n }, (_, i) => i % 5 === 3);
				const slots = fanLayout(landscape, width, trayHeight);
				expect(slots).toHaveLength(n);
				slots.forEach((slot, i) => {
					const { w, h } = restSize(landscape[i]!);
					const c = Math.abs(Math.cos(slot.angle));
					const s = Math.abs(Math.sin(slot.angle));
					const hw = (w / 2) * c + (h / 2) * s;
					const hh = (w / 2) * s + (h / 2) * c;
					// tray-local: the tray spans the viewport's width, its bottom is the viewport's
					expect(slot.x - hw).toBeGreaterThanOrEqual(-width / 2 - 1e-9);
					expect(slot.x + hw).toBeLessThanOrEqual(width / 2 + 1e-9);
					expect(slot.y - hh).toBeGreaterThanOrEqual(-trayHeight / 2 - 1e-9);
				});
				// left to right, and the arc opens upward (ends tilt outward)
				for (let i = 1; i < n; i++) expect(slots[i]!.x).toBeGreaterThanOrEqual(slots[i - 1]!.x);
				if (n > 1) {
					expect(slots[0]!.angle).toBeGreaterThan(0);
					expect(slots[n - 1]!.angle).toBeLessThan(0);
				}
			});
		}
	}

	it('the hovered card grows in place but never past a side of the viewport', () => {
		const width = 400 / 80;
		const half = (HAND_CARD_W * HAND_HOVER_SCALE) / 2;
		expect(hoverX(-width / 2, false, width) - half).toBeGreaterThanOrEqual(-width / 2);
		expect(hoverX(width / 2, false, width) + half).toBeLessThanOrEqual(width / 2);
		expect(hoverX(0.3, false, 16)).toBe(0.3);
		expect(HAND_CARD_H).toBeGreaterThan(HAND_CARD_W);
	});

	it('a held card takes the nearest slot', () => {
		const slots = [{ x: -1 }, { x: 0 }, { x: 1 }];
		expect(slotAt(slots, -5)).toBe(0);
		expect(slotAt(slots, -0.4)).toBe(1);
		expect(slotAt(slots, 0.6)).toBe(2);
		expect(slotAt(slots, 5)).toBe(2);
		expect(slotAt([], 1)).toBe(0);
	});
});

describe('which face a play lands on', () => {
	it('face-down by default, Shift the other; a table can make face-up the default', () => {
		expect(handPlayFace({})).toBe('down');
		expect(handPlayFace({ table: { handPlayFace: 'up' } })).toBe('up');
		expect(handPlayFace({ table: { handPlayFace: 'sideways' as never } })).toBe('down');
		expect(playFace('down', false)).toBe('down');
		expect(playFace('down', true)).toBe('up');
		expect(playFace('up', false)).toBe('up');
		expect(playFace('up', true)).toBe('down');
	});

	it('a face-down play is one patch, marks the placer, and leaves with the deck back', () => {
		seed(
			{ a: { ...face('2D'), handOrder: 0 } },
			{
				decks: {
					'deck:p1:0': {
						id: 'deck:p1:0',
						deckBackImageUrl: 'https://x/back.png',
						position: [0, 0, 0],
						rotation: [0, 0, 0],
						cards: []
					}
				}
			}
		);
		const spy = vi.spyOn(gameStore, 'updateState');
		playFromHand('a', false, { clientX: 0, clientY: 0, canvas: document.body });
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		const card = game().cards?.a;
		expect(card?.rotation?.[0]).toBe(180);
		expect(card?.placedBy).toBe('p1');
		expect(card?.backImageUrl).toBe('https://x/back.png');
		expect(card).not.toHaveProperty('handOrder');
		expect(trayOf()).not.toHaveProperty('a');
		expect(get(dragStore).isDragging).toBe('a');
		expect(get(handPlay)).toEqual({ id: 'a', face: 'down' });
	});

	it('Shift turns the carried card over — and back — with no peek mark while face up', () => {
		seed({ a: face('2D') });
		playFromHand('a', true, { clientX: 0, clientY: 0, canvas: document.body });
		expect(game().cards?.a?.rotation?.[0]).toBe(0);
		expect(game().cards?.a).not.toHaveProperty('placedBy');
		const spy = vi.spyOn(gameStore, 'updateState');
		settlePlayFace(true); // held: nothing to send
		expect(spy).not.toHaveBeenCalled();
		settlePlayFace(false);
		expect(game().cards?.a?.rotation?.[0]).toBe(180);
		expect(game().cards?.a?.placedBy).toBe('p1');
		spy.mockRestore();
		// the play is over once the drag is
		dragStore.update((s) => ({ ...s, isDragging: null }));
		expect(get(handPlay)).toBeNull();
	});

	it('a face-up table plays face-up, and Shift face-down', () => {
		seed({ a: face('2D'), b: face('3D') }, { table: { handPlayFace: 'up' } });
		playFromHand('a', false, { clientX: 0, clientY: 0, canvas: document.body });
		expect(game().cards?.a?.rotation?.[0]).toBe(0);
		dragStore.update((s) => ({ ...s, isDragging: null }));
		playFromHand('b', true, { clientX: 0, clientY: 0, canvas: document.body });
		expect(game().cards?.b?.rotation?.[0]).toBe(180);
	});
});

describe("a hand card's back", () => {
	const deck = (back?: string) => ({
		position: [0, 0, 0],
		rotation: [0, 0, 0],
		cards: [],
		...(back ? { deckBackImageUrl: back } : {})
	});

	it('its own, else the one its holder’s decks share, else the table’s, else none', () => {
		const g = {
			decks: {
				'deck:p1:0': deck('mine'),
				'deck:p1:1': deck('mine'),
				'deck:p2:0': deck('theirs')
			}
		} as never;
		expect(handCardBack(g, 'p1', { backImageUrl: 'own' })).toBe('own');
		expect(handCardBack(g, 'p1', {})).toBe('mine');
		// no decks of your own: every deck on the table has to agree
		expect(handCardBack(g, 'p3', {})).toBeUndefined();
		expect(handCardBack({ decks: { 'deck:p2:0': deck('theirs') } } as never, 'p3', {})).toBe(
			'theirs'
		);
		expect(handCardBack({}, 'p1', {})).toBeUndefined();
	});
});

describe('the hint and the ? list', () => {
	it('a hand card names its gestures, with the table’s face', () => {
		seed({ a: face('2D') });
		const labels = () =>
			verbsFor({ kind: 'hand-card', id: 'a' }, { playerId: 'p1' }).map((v) => v.label);
		expect(labels()).toEqual(['Play face-down', 'Play face-up', 'Reorder']);
		gameStore.updateState({ table: { handPlayFace: 'up' } });
		expect(labels()).toEqual(['Play face-up', 'Play face-down', 'Reorder']);
		const section = verbReference().find((s) => s.title === 'Card in hand');
		expect(section?.rows.map((r) => r.key)).toEqual([
			'drag out',
			'Shift + drag out',
			'drag along the hand'
		]);
	});

	it('carrying a hand card says which face lands, and what Shift does', () => {
		const hint = hintFor({
			game: { cards: { a: { ...face('2D'), rotation: [180, 0, 0] } } } as never,
			actor: { playerId: 'p1' },
			targets: [],
			dragging: 'a',
			dropKind: 'table',
			handPlay: { face: 'down', defaultFace: 'down' }
		});
		expect(hint.parts.slice(0, 2).map((p) => [p.key, p.text])).toEqual([
			['', 'Release to play face-down'],
			['hold Shift', 'Play face-up']
		]);
		const reorder = hintFor({
			game: { players: { p1: { tray: { a: face('2D') } } } } as never,
			actor: { playerId: 'p1' },
			targets: [],
			dragging: null,
			dropKind: null,
			reordering: 'a'
		});
		expect(reorder.name).toBe('2D');
		expect(reorder.parts[0]?.text).toBe('Release to reorder');
	});
});

describe('scenario handPlayFace', () => {
	const file = (extra: Record<string, unknown>) =>
		JSON.stringify({ tbps: 1, name: 'Board', state: {}, ...extra });

	it('parses, and composes into the synced table settings', () => {
		const scenario = parseScenarioFile(file({ handPlayFace: 'up', rotationStep: 60 }));
		expect(scenario.handPlayFace).toBe('up');
		expect(composeScenario(scenario, new Map()).table).toEqual({
			rotationStep: 60,
			handPlayFace: 'up'
		});
	});

	it('is absent unless authored', () => {
		const scenario = parseScenarioFile(file({}));
		expect('handPlayFace' in scenario).toBe(false);
		expect(composeScenario(scenario, new Map()).table).toBeUndefined();
	});

	it('refuses anything but "down" or "up"', () => {
		expect(() => parseScenarioFile(file({ handPlayFace: 'sideways' }))).toThrow(/handPlayFace/);
		expect(() => parseScenarioFile(file({ handPlayFace: true }))).toThrow(/handPlayFace/);
	});
});
