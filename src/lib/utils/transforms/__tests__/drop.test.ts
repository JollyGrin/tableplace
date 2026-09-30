import { describe, it, expect } from 'vitest';
import { DEG2RAD } from 'three/src/math/MathUtils.js';
import { clampToTable, resolveDrop } from '../drop';
import type { GameDTO } from '$lib/store/game/types';
import {
	CARD_WIDTH,
	CARD_HEIGHT,
	CARD_REST_Y,
	CARD_THICKNESS,
	CARD_DRAG_Y,
	deckHeightForCount
} from '$lib/utils/constants-cards';
import { PIECE_DEFAULT_RADIUS, PIECE_REST_Y } from '$lib/utils/constants-pieces';
import { EDGE_MARGIN, TABLE_HALF_X, TABLE_HALF_Z, TABLE_TOP_Y } from '$lib/utils/constants-table';

const state = (over: Partial<GameDTO> = {}): Partial<GameDTO> => ({
	cards: {},
	decks: {},
	players: {},
	pieces: {},
	...over
});

const card = (x: number, y: number, z: number, rotation: [number, number, number] = [0, 0, 0]) => ({
	position: [x, y, z] as [number, number, number],
	rotation,
	faceImageUrl: 'face.png'
});

describe('clampToTable', () => {
	it('leaves points on the felt alone', () => {
		expect(clampToTable(3, -4)).toEqual([3, -4]);
	});

	it('clamps a margin inside each edge', () => {
		expect(clampToTable(999, 999)).toEqual([
			TABLE_HALF_X - EDGE_MARGIN,
			TABLE_HALF_Z - EDGE_MARGIN
		]);
		expect(clampToTable(-999, -999)).toEqual([
			-TABLE_HALF_X + EDGE_MARGIN,
			-TABLE_HALF_Z + EDGE_MARGIN
		]);
	});
});

describe('resolveDrop', () => {
	it('returns null with nothing being dragged', () => {
		expect(resolveDrop(state(), null, { x: 0, z: 0 })).toBeNull();
	});

	it('returns null for an entity that is not in the state', () => {
		expect(resolveDrop(state(), 'ghost', { x: 0, z: 0 })).toBeNull();
	});

	it('lands a card on the felt at the raycast point', () => {
		const s = state({ cards: { a: card(0, 2, 0) } });
		const drop = resolveDrop(s, 'a', { x: 4, z: -2 });
		expect(drop).toMatchObject({
			kind: 'table',
			position: [4, CARD_REST_Y, -2],
			footprint: { shape: 'rect', w: CARD_WIDTH, h: CARD_HEIGHT }
		});
	});

	it('clamps the landing inside the table edge', () => {
		const s = state({ cards: { a: card(0, 2, 0) } });
		const drop = resolveDrop(s, 'a', { x: 100, z: -100 });
		expect(drop?.position[0]).toBe(TABLE_HALF_X - EDGE_MARGIN);
		expect(drop?.position[2]).toBe(-TABLE_HALF_Z + EDGE_MARGIN);
	});

	it('falls back to the entity position when there is no raycast hit', () => {
		const s = state({ cards: { a: card(6, 2, 3) } });
		expect(resolveDrop(s, 'a', null)?.position).toEqual([6, CARD_REST_Y, 3]);
	});

	it('resolves the stack height and reports kind "stack"', () => {
		const s = state({ cards: { a: card(0, 2, 0), b: card(0.3, CARD_REST_Y, 0.3) } });
		const drop = resolveDrop(s, 'a', { x: 0, z: 0 });
		expect(drop?.kind).toBe('stack');
		expect(drop?.position[1]).toBeCloseTo(CARD_REST_Y + CARD_THICKNESS);
		// the footprint draws at the resolved rest height, on top of the stack
		expect(drop?.footprintY).toBeCloseTo(CARD_REST_Y + CARD_THICKNESS);
	});

	it('squares a stack drop up to the base card XZ, not the pointer', () => {
		const s = state({ cards: { a: card(0, 2, 0), b: card(1, CARD_REST_Y, -2) } });
		const drop = resolveDrop(s, 'a', { x: 1.4, z: -1.6 });
		expect(drop?.kind).toBe('stack');
		expect(drop?.position[0]).toBe(1);
		expect(drop?.position[2]).toBe(-2);
	});

	it('leaves a bare-felt drop exactly where the pointer is', () => {
		const s = state({ cards: { a: card(0, 2, 0), b: card(8, CARD_REST_Y, 8) } });
		const drop = resolveDrop(s, 'a', { x: 1.4, z: -1.6 });
		expect(drop?.kind).toBe('table');
		expect(drop?.position).toEqual([1.4, CARD_REST_Y, -1.6]);
	});

	it('carries the card rotation through so the preview matches the landing', () => {
		const s = state({ cards: { a: card(0, 2, 0, [180, 0, -90]) } });
		expect(resolveDrop(s, 'a', { x: 1, z: 1 })?.rotation).toEqual([180, 0, -90]);
	});

	it('gives a piece a circular footprint at its own radius', () => {
		const s = state({ pieces: { 'piece:1': { position: [0, 1.2, 0], radius: 1.25 } } });
		const drop = resolveDrop(s, 'piece:1', { x: 2, z: 2 });
		expect(drop).toMatchObject({
			kind: 'table',
			position: [2, PIECE_REST_Y, 2],
			footprint: { shape: 'circle', r: 1.25 }
		});
		// a token's origin is half a disc up; its footprint belongs on the felt
		expect(drop?.footprintY).toBe(TABLE_TOP_Y);
	});

	it('gives a square token the rectangle it is, not a circle round it', () => {
		const tile = { position: [0, 1.2, 0], kind: 'token', shape: 'square', radius: 1.25 };
		const s = state({ pieces: { 'piece:1': tile } });
		expect(resolveDrop(s, 'piece:1', { x: 2, z: 2 })?.footprint).toEqual({
			shape: 'rect',
			w: 2.5,
			h: 2.5
		});
		// the preview hands in the loaded image's aspect: twice as wide as deep
		expect(resolveDrop(s, 'piece:1', { x: 2, z: 2 }, {}, { faceAspect: 2 })?.footprint).toEqual({
			shape: 'rect',
			w: 2.5,
			h: 1.25
		});
		// an aspect never reshapes a disc
		const disc = state({ pieces: { 'piece:1': { ...tile, shape: undefined } } });
		expect(resolveDrop(disc, 'piece:1', { x: 2, z: 2 }, {}, { faceAspect: 2 })?.footprint).toEqual({
			shape: 'circle',
			r: 1.25
		});
	});

	it('defaults a piece without a radius', () => {
		const s = state({ pieces: { 'piece:1': { position: [0, 1.2, 0] } } });
		expect(resolveDrop(s, 'piece:1', { x: 0, z: 0 })?.footprint).toEqual({
			shape: 'circle',
			r: PIECE_DEFAULT_RADIUS
		});
	});

	it('ignores deck and tray hover for pieces — they only ever settle', () => {
		const s = state({ pieces: { 'piece:1': { position: [0, 1.2, 0] } } });
		const drop = resolveDrop(s, 'piece:1', { x: 0, z: 0 }, { tray: true, deckId: 'deck:1' });
		expect(drop?.kind).toBe('table');
	});

	it('reports a deck drop with the hovered deck as the target', () => {
		const s = state({
			cards: { a: card(0, 2, 0) },
			decks: { 'deck:1': { position: [8, 0.4, 4], rotation: [0, 0, 0], cards: [] } }
		});
		const drop = resolveDrop(s, 'a', { x: 0, z: 0 }, { deckId: 'deck:1' });
		expect(drop?.kind).toBe('deck');
		expect(drop?.targetId).toBe('deck:1');
		expect(drop?.position[0]).toBe(8);
		expect(drop?.position[2]).toBe(4);
	});

	it('reports a tray drop, and the tray wins over a deck', () => {
		const s = state({ cards: { a: card(0, 2, 0) }, decks: { 'deck:1': { cards: [] } } });
		expect(resolveDrop(s, 'a', { x: 0, z: 0 }, { tray: true, deckId: 'deck:1' })?.kind).toBe(
			'tray'
		);
	});

	it('refuses a tray drop on a route with no hand, landing the card on the table', () => {
		// the pack editor: the tray isn't mounted, and a hover flag can arrive
		// stale from a previous /play visit
		const s = state({ cards: { a: card(0, 2, 0) } });
		const drop = resolveDrop(s, 'a', { x: 3, z: -1 }, { tray: true }, { hand: false });
		expect(drop?.kind).toBe('table');
		expect(drop?.position).toEqual([3, CARD_REST_Y, -1]);
	});

	it('still lets a deck win when there is no hand', () => {
		const s = state({
			cards: { a: card(0, 2, 0) },
			decks: { 'deck:1': { position: [8, 0.4, 4], cards: [] } }
		});
		const hover = { tray: true, deckId: 'deck:1' };
		expect(resolveDrop(s, 'a', { x: 0, z: 0 }, hover, { hand: false })?.kind).toBe('deck');
	});

	it('is unfazed by an empty state', () => {
		expect(resolveDrop(undefined, 'a', { x: 0, z: 0 })).toBeNull();
	});

	describe('bag hover', () => {
		const withBag = (over: Partial<GameDTO> = {}) =>
			state({
				pieces: {
					'piece:seat0:bag-0': {
						kind: 'bag',
						name: 'Bag',
						position: [6, PIECE_REST_Y, -3],
						radius: 0.9
					},
					...over.pieces
				},
				cards: over.cards,
				decks: over.decks,
				snapPoints: over.snapPoints
			});

		/**
		 * The precedence the bag and the snap points (tableplace-96) had to be
		 * composed for. A bag you pointed at is an aimed-at target; a snap point
		 * that happens to sit at the same spot is proximity — so the bag wins,
		 * and with no bag under the pointer the snap still catches the drop.
		 */
		describe('against an authored snap point', () => {
			/** the snap point sits exactly where the bag does */
			const withBagOnSnap = (over: Partial<GameDTO> = {}) =>
				withBag({
					...over,
					snapPoints: { 'snap:0': { id: 'snap:0', position: [6, -3], radius: 1, rotation: 90 } }
				});
			const token = {
				'piece:seat0:token-0': {
					kind: 'token' as const,
					position: [0, 1.2, 0] as [number, number, number]
				}
			};

			it('the bag swallows a piece dropped on a point it shares', () => {
				const drop = resolveDrop(
					withBagOnSnap({ pieces: { ...token } }),
					'piece:seat0:token-0',
					{ x: 6, z: -3 },
					{ bagId: 'piece:seat0:bag-0' }
				);
				expect(drop?.kind).toBe('bag');
				expect(drop?.snap).toBeUndefined(); // not a snap landing at all
			});

			it('the same drop with no bag under the pointer still snaps', () => {
				const drop = resolveDrop(withBagOnSnap({ pieces: { ...token } }), 'piece:seat0:token-0', {
					x: 6.3,
					z: -2.8
				});
				expect(drop).toMatchObject({
					kind: 'snap',
					position: [6, PIECE_REST_Y, -3],
					snap: { id: 'snap:0' }
				});
				// a piece takes the authored yaw in DEGREES on rotation[1] (a deck
				// would take radians) — see applySnapRotation
				expect(drop?.rotation).toEqual([0, 90, 0]);
			});

			it('a card is swallowed rather than caught, too', () => {
				const s = withBagOnSnap({ cards: { a: card(0, 2, 0) } });
				expect(resolveDrop(s, 'a', { x: 6, z: -3 }, { bagId: 'piece:seat0:bag-0' })?.kind).toBe(
					'bag'
				);
				expect(resolveDrop(s, 'a', { x: 6, z: -3 })?.kind).toBe('snap');
			});

			it('Alt opts out of snapping but not out of the bag', () => {
				const s = withBagOnSnap({ pieces: { ...token } });
				const hover = { bagId: 'piece:seat0:bag-0' };
				// the bag is aimed at, like a deck or the tray, and Alt has never
				// opted out of those
				expect(
					resolveDrop(s, 'piece:seat0:token-0', { x: 6, z: -3 }, hover, { noSnap: true })?.kind
				).toBe('bag');
				expect(
					resolveDrop(s, 'piece:seat0:token-0', { x: 6, z: -3 }, {}, { noSnap: true })?.kind
				).toBe('table');
			});

			/**
			 * A whole deck has no representation inside a bag (`contents` holds
			 * pieces and cards only), so `returnToBag` would refuse it — and a
			 * refused drop that resolved as 'bag' would leave the pile floating at
			 * drag height. It settles (or snaps) instead.
			 */
			it('a dragged deck is never swallowed — it settles or snaps as usual', () => {
				const s = withBagOnSnap({
					decks: {
						'deck:me:main': {
							id: 'deck:me:main',
							position: [0, CARD_DRAG_Y, 0],
							rotation: [0, 0, 0],
							cards: [{ id: 'c0', faceImageUrl: 'f.png' }]
						}
					}
				});
				const onto = resolveDrop(
					s,
					'deck:me:main',
					{ x: 6, z: -3 },
					{ bagId: 'piece:seat0:bag-0' }
				);
				expect(onto?.kind).toBe('snap');
				expect(onto?.snap).toMatchObject({ id: 'snap:0' });

				const elsewhere = resolveDrop(
					s,
					'deck:me:main',
					{ x: 12, z: 4 },
					{ bagId: 'piece:seat0:bag-0' }
				);
				expect(elsewhere?.kind).toBe('table');
			});
		});

		it('reports a bag drop for a card, targeting the bag and its own spot', () => {
			const s = withBag({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 0, z: 0 }, { bagId: 'piece:seat0:bag-0' });

			expect(drop).toMatchObject({
				kind: 'bag',
				targetId: 'piece:seat0:bag-0',
				position: [6, PIECE_REST_Y, -3],
				footprint: { shape: 'circle', r: 0.9 }
			});
			expect(drop?.footprintY).toBe(TABLE_TOP_Y);
		});

		it('reports a bag drop for a piece too — a bag beats the plain settle', () => {
			const s = withBag({
				pieces: { 'piece:seat0:token-0': { kind: 'token', position: [0, 1.2, 0] } }
			});
			const drop = resolveDrop(
				s,
				'piece:seat0:token-0',
				{ x: 6, z: -3 },
				{ bagId: 'piece:seat0:bag-0' }
			);
			expect(drop?.kind).toBe('bag');
		});

		it('never puts a bag inside a bag, or inside itself', () => {
			const s = withBag({
				pieces: { 'piece:seat0:other-bag-0': { kind: 'bag', position: [0, 1.2, 0] } }
			});
			expect(
				resolveDrop(s, 'piece:seat0:other-bag-0', { x: 6, z: -3 }, { bagId: 'piece:seat0:bag-0' })
					?.kind
			).toBe('table');
			expect(
				resolveDrop(s, 'piece:seat0:bag-0', { x: 1, z: 1 }, { bagId: 'piece:seat0:bag-0' })?.kind
			).toBe('table');
		});

		it('ignores a hover on a piece that is not a bag', () => {
			const s = withBag({
				cards: { a: card(0, 2, 0) },
				pieces: { 'piece:seat0:token-0': { kind: 'token', position: [0, PIECE_REST_Y, 0] } }
			});
			expect(resolveDrop(s, 'a', { x: 0, z: 0 }, { bagId: 'piece:seat0:token-0' })?.kind).toBe(
				'table'
			);
		});

		it('lets the tray win over a bag for a card, but not for a piece', () => {
			const s = withBag({
				cards: { a: card(0, 2, 0) },
				pieces: { 'piece:seat0:token-0': { kind: 'token', position: [0, 1.2, 0] } }
			});
			const hover = { bagId: 'piece:seat0:bag-0', tray: true };
			// the HUD tray sits in front of the table, so both can be "under" the
			// pointer — the hand is the more explicit target for a card
			expect(resolveDrop(s, 'a', { x: 0, z: 0 }, hover)?.kind).toBe('tray');
			// …and a piece can't enter the tray at all
			expect(resolveDrop(s, 'piece:seat0:token-0', { x: 0, z: 0 }, hover)?.kind).toBe('bag');
			// no hand on this route: the bag takes the card after all
			expect(resolveDrop(s, 'a', { x: 0, z: 0 }, hover, { hand: false })?.kind).toBe('bag');
		});

		it('a bag beats a deck under the same pointer', () => {
			const s = withBag({ cards: { a: card(0, 2, 0) } });
			s.decks = { 'deck:1': { position: [8, 0.4, 4], cards: [] } };
			const drop = resolveDrop(
				s,
				'a',
				{ x: 0, z: 0 },
				{
					bagId: 'piece:seat0:bag-0',
					deckId: 'deck:1'
				}
			);
			expect(drop?.kind).toBe('bag');
		});
	});

	describe('noSnap (Alt held at release)', () => {
		const overlapping = () =>
			state({ cards: { a: card(0, 2, 0), resting: card(0.2, CARD_REST_Y, 0.2) } });

		it('commits at the raw point instead of squaring up to the pile', () => {
			const drop = resolveDrop(overlapping(), 'a', { x: 0.5, z: 0.4 }, {}, { noSnap: true });
			expect(drop?.position[0]).toBe(0.5);
			expect(drop?.position[2]).toBe(0.4);
		});

		it('still rests on top of the card it overlaps — coplanar cards z-fight', () => {
			const drop = resolveDrop(overlapping(), 'a', { x: 0.5, z: 0.4 }, {}, { noSnap: true });
			expect(drop).toMatchObject({
				kind: 'stack',
				position: [0.5, CARD_REST_Y + CARD_THICKNESS, 0.4],
				footprintY: CARD_REST_Y + CARD_THICKNESS
			});
		});

		it('keeps climbing on repeated Alt-drops onto the same overlap', () => {
			const s = state({
				cards: {
					a: card(0, 2, 0),
					resting: card(0.2, CARD_REST_Y, 0.2),
					previous: card(0.5, CARD_REST_Y + CARD_THICKNESS, 0.4)
				}
			});
			const drop = resolveDrop(s, 'a', { x: 0.7, z: 0.5 }, {}, { noSnap: true });
			expect(drop?.position[0]).toBe(0.7);
			expect(drop?.position[2]).toBe(0.5);
			expect(drop?.position[1]).toBeCloseTo(CARD_REST_Y + 2 * CARD_THICKNESS);
		});

		it('rests on the felt when nothing is under the pointer', () => {
			const s = state({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 0.5, z: 0.4 }, {}, { noSnap: true });
			expect(drop).toMatchObject({ kind: 'table', position: [0.5, CARD_REST_Y, 0.4] });
		});

		it('still clamps to the felt', () => {
			const drop = resolveDrop(overlapping(), 'a', { x: 999, z: 0 }, {}, { noSnap: true });
			expect(drop?.position[0]).toBe(TABLE_HALF_X - EDGE_MARGIN);
		});

		it('leaves the aimed-at targets alone: deck and tray still win', () => {
			const s = state({ cards: { a: card(0, 2, 0) }, decks: { 'deck:1': { cards: [] } } });
			expect(resolveDrop(s, 'a', { x: 0, z: 0 }, { tray: true }, { noSnap: true })?.kind).toBe(
				'tray'
			);
			expect(
				resolveDrop(s, 'a', { x: 0, z: 0 }, { deckId: 'deck:1' }, { noSnap: true })?.kind
			).toBe('deck');
		});

		it('changes nothing when the modifier is not held', () => {
			expect(resolveDrop(overlapping(), 'a', { x: 0.5, z: 0.4 }, {}, { noSnap: false })).toEqual(
				resolveDrop(overlapping(), 'a', { x: 0.5, z: 0.4 })
			);
		});
	});

	describe('authored snap points', () => {
		const withSnap = (over: Partial<GameDTO> = {}) =>
			state({
				snapPoints: {
					'snap:0': { id: 'snap:0', position: [4, 2], radius: 1, rotation: 90 },
					'snap:1': { id: 'snap:1', position: [-4, 2], radius: 1 }
				},
				...over
			});

		it('pulls a card exactly onto the point and applies its yaw', () => {
			const s = withSnap({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 4.4, z: 2.3 });
			expect(drop).toMatchObject({
				kind: 'snap',
				position: [4, CARD_REST_Y, 2],
				rotation: [0, 0, 90],
				snap: { id: 'snap:0', radius: 1 }
			});
		});

		it('leaves the facing alone for a point with no authored rotation', () => {
			const s = withSnap({ cards: { a: card(0, 2, 0, [180, 0, 45]) } });
			const drop = resolveDrop(s, 'a', { x: -4, z: 2 });
			expect(drop?.kind).toBe('snap');
			expect(drop?.rotation).toEqual([180, 0, 45]);
		});

		/**
		 * A whole dragged deck (tableplace-88) has to snap as well, and it is the
		 * case the two features had to be composed for: the deck branch resolves
		 * before the card path, so it has to consult the snap itself rather than
		 * returning at the raw pointer.
		 */
		describe('a dragged deck', () => {
			const deck = (n: number, rotation: [number, number, number] = [0, 0, 0]) => ({
				id: 'deck:me:main',
				position: [0, CARD_DRAG_Y, 0] as [number, number, number],
				rotation,
				cards: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, faceImageUrl: 'f.png' }))
			});
			const restY = (n: number) => TABLE_TOP_Y + deckHeightForCount(n) / 2;

			it('lands exactly on the point, keeping its own half-height', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(20) } });
				const drop = resolveDrop(s, 'deck:me:main', { x: 4.5, z: 2.2 });
				expect(drop).toMatchObject({
					kind: 'snap',
					position: [4, restY(20), 2],
					snap: { id: 'snap:0', radius: 1 }
				});
			});

			it('takes the authored yaw in RADIANS of the opposite sign, unlike a card', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(20) } });
				// snap:0 authors 90° clockwise. A deck's rotation triple is radians
				// and counter-clockwise, so that is -π/2 — stored wrapped, as 3π/2
				const [rx, ry, rz] = resolveDrop(s, 'deck:me:main', { x: 4, z: 2 })!.rotation;
				expect([rx, rz]).toEqual([0, 0]);
				expect(ry).toBeCloseTo((3 * Math.PI) / 2);
			});

			it('keeps its facing when the point authored no rotation', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(20, [0, Math.PI, 0]) } });
				const drop = resolveDrop(s, 'deck:me:main', { x: -4, z: 2 });
				expect(drop?.kind).toBe('snap');
				expect(drop?.rotation).toEqual([0, Math.PI, 0]);
			});

			it('still settles at the pointer when no point is in range', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(8) } });
				const drop = resolveDrop(s, 'deck:me:main', { x: 9, z: -3 });
				expect(drop).toMatchObject({ kind: 'table', position: [9, restY(8), -3] });
				expect(drop?.snap).toBeUndefined();
			});

			it('is opted out of by Alt, like every other snap', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(8) } });
				const drop = resolveDrop(s, 'deck:me:main', { x: 4.2, z: 2 }, {}, { noSnap: true });
				expect(drop).toMatchObject({ kind: 'table', position: [4.2, restY(8), 2] });
			});

			it('is unaffected by a hovered deck or tray — a pile only ever settles', () => {
				const s = withSnap({ decks: { 'deck:me:main': deck(8) } });
				const hovered = resolveDrop(
					s,
					'deck:me:main',
					{ x: 4, z: 2 },
					{
						tray: true,
						deckId: 'deck:other:main'
					}
				);
				expect(hovered?.kind).toBe('snap');
				expect([hovered?.position[0], hovered?.position[2]]).toEqual([4, 2]);
			});
		});

		it('pulls a piece onto the point too, at piece rest height', () => {
			const s = withSnap({
				pieces: { 'piece:me:t': { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'token' } }
			});
			const drop = resolveDrop(s, 'piece:me:t', { x: 3.6, z: 2 });
			expect(drop).toMatchObject({
				kind: 'snap',
				position: [4, PIECE_REST_Y, 2],
				// a piece keeps its table yaw in y, not z (see applySnapRotation)
				rotation: [0, 90, 0],
				footprint: { shape: 'circle', r: PIECE_DEFAULT_RADIUS }
			});
		});

		/**
		 * One authored yaw, one turn on screen (tableplace-228). The three kinds
		 * store a yaw in different slots, units and signs, so the only place
		 * they can be compared is where the renderers put them: the three.js
		 * `rotation.y` each component binds. A 90° point is the case that tells
		 * the two directions apart — 0° and 180° look the same either way.
		 */
		it('turns a card, a deck and a pawn the same way on screen', () => {
			const s = withSnap({
				cards: { a: card(0, 2, 0) },
				decks: {
					'deck:me:main': {
						id: 'deck:me:main',
						position: [0, CARD_DRAG_Y, 0],
						rotation: [0, 0, 0],
						cards: [{ id: 'c0', faceImageUrl: 'f.png' }]
					}
				},
				pieces: { 'piece:me:p': { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'pawn' } }
			});
			const landed = (id: string) => resolveDrop(s, id, { x: 4, z: 2 })!.rotation;

			// what each renderer hands three.js, in radians about +y
			const rendered = {
				card: -landed('a')[2] * DEG2RAD, // Card.svelte: rotation.y = -z°
				piece: -landed('piece:me:p')[1] * DEG2RAD, // Piece.svelte: -y°
				deck: landed('deck:me:main')[1] // Deck.svelte: y, as stored
			};
			// compared as headings, so whole turns apart are the same facing
			const heading = (yaw: number) => [Math.sin(yaw), Math.cos(yaw)];
			const clockwiseQuarter = heading(-Math.PI / 2);
			for (const yaw of Object.values(rendered)) {
				const [sin, cos] = heading(yaw);
				expect(sin).toBeCloseTo(clockwiseQuarter[0]);
				expect(cos).toBeCloseTo(clockwiseQuarter[1]);
			}
		});

		it('does nothing to a drop outside every radius', () => {
			const s = withSnap({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 6, z: 2 });
			expect(drop).toMatchObject({ kind: 'table', position: [6, CARD_REST_Y, 2] });
			expect(drop?.snap).toBeUndefined();
		});

		it('stacks on a card already sitting on the point instead of clipping into it', () => {
			const s = withSnap({
				cards: { a: card(0, 2, 0), resting: card(4, CARD_REST_Y, 2) }
			});
			const drop = resolveDrop(s, 'a', { x: 4.3, z: 2 });
			expect(drop).toMatchObject({
				kind: 'snap',
				position: [4, CARD_REST_Y + CARD_THICKNESS, 2]
			});
		});

		it('beats a loose pile that the drop also overlaps', () => {
			// a card resting just off the point: without snapping the drop would
			// square up to it, with snapping the authored spot wins the XZ
			const s = withSnap({
				cards: { a: card(0, 2, 0), loose: card(4.6, CARD_REST_Y, 2.4) }
			});
			const drop = resolveDrop(s, 'a', { x: 4.4, z: 2.2 });
			expect(drop?.kind).toBe('snap');
			expect([drop?.position[0], drop?.position[2]]).toEqual([4, 2]);
		});

		it('loses to the aimed-at targets: tray and deck still win', () => {
			const s = withSnap({ cards: { a: card(0, 2, 0) }, decks: { 'deck:1': { cards: [] } } });
			expect(resolveDrop(s, 'a', { x: 4, z: 2 }, { tray: true })?.kind).toBe('tray');
			expect(resolveDrop(s, 'a', { x: 4, z: 2 }, { deckId: 'deck:1' })?.kind).toBe('deck');
		});

		it('is opted out of by Alt, for both cards and pieces', () => {
			const s = withSnap({
				cards: { a: card(0, 2, 0) },
				pieces: { 'piece:me:t': { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'token' } }
			});
			expect(resolveDrop(s, 'a', { x: 4.2, z: 2 }, {}, { noSnap: true })).toMatchObject({
				kind: 'table',
				position: [4.2, CARD_REST_Y, 2]
			});
			expect(resolveDrop(s, 'piece:me:t', { x: 4.2, z: 2 }, {}, { noSnap: true })).toMatchObject({
				kind: 'table',
				position: [4.2, PIECE_REST_Y, 2]
			});
		});

		it('changes nothing for a table that has no snap points', () => {
			const s = state({ cards: { a: card(0, 2, 0) } });
			expect(resolveDrop(s, 'a', { x: 4.4, z: 2.3 })).toEqual(
				resolveDrop(state({ cards: { a: card(0, 2, 0) }, snapPoints: {} }), 'a', {
					x: 4.4,
					z: 2.3
				})
			);
		});
	});

	describe('elevated snap points (y)', () => {
		// the local floor is 2; every rest height is the usual arithmetic with
		// 2 substituted for the table top
		const FLOOR = 2;
		const withElevated = (over: Partial<GameDTO> = {}) =>
			state({
				snapPoints: { 'snap:0': { id: 'snap:0', position: [4, 2], radius: 1, y: FLOOR } },
				...over
			});

		it('rests a card on the substituted floor', () => {
			const s = withElevated({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 4.3, z: 2 });
			expect(drop?.kind).toBe('snap');
			expect(drop?.position).toEqual([4, FLOOR + (CARD_REST_Y - TABLE_TOP_Y), 2]);
		});

		it('rests a piece half a disc above the substituted floor', () => {
			const s = withElevated({
				pieces: { 'piece:me:t': { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'token' } }
			});
			const drop = resolveDrop(s, 'piece:me:t', { x: 4, z: 2 });
			expect(drop?.position).toEqual([4, FLOOR + (PIECE_REST_Y - TABLE_TOP_Y), 2]);
			// the footprint belongs on the elevated floor, not on the felt below
			expect(drop?.footprintY).toBe(FLOOR);
		});

		it('rests a deck at half its body height above the substituted floor', () => {
			const s = withElevated({
				decks: {
					'deck:me:main': {
						id: 'deck:me:main',
						position: [0, CARD_DRAG_Y, 0],
						rotation: [0, 0, 0],
						cards: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, faceImageUrl: 'f.png' }))
					}
				}
			});
			const drop = resolveDrop(s, 'deck:me:main', { x: 4, z: 2 });
			expect(drop?.position).toEqual([4, FLOOR + deckHeightForCount(20) / 2, 2]);
		});

		it('still stacks: a card dropped on a card on an elevated point lands on top', () => {
			const restingY = FLOOR + (CARD_REST_Y - TABLE_TOP_Y);
			const s = withElevated({
				cards: { a: card(0, 2, 0), resting: card(4, restingY, 2) }
			});
			const drop = resolveDrop(s, 'a', { x: 4.3, z: 2 });
			expect(drop?.kind).toBe('snap');
			expect(drop?.position[1]).toBeCloseTo(restingY + CARD_THICKNESS);
		});

		it('ignores a card resting on the felt underneath the platform', () => {
			// a table-level card at the same XZ must not pull the drop down
			// through the elevated floor
			const s = withElevated({
				cards: { a: card(0, 2, 0), below: card(4, CARD_REST_Y, 2) }
			});
			const drop = resolveDrop(s, 'a', { x: 4.3, z: 2 });
			expect(drop?.position[1]).toBeCloseTo(FLOOR + (CARD_REST_Y - TABLE_TOP_Y));
		});
	});

	describe('the surfaceYAt seam (tableplace-135 plugs in here)', () => {
		it('is the floor fallback when no snap point authors one', () => {
			const s = state({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 3, z: 1 }, {}, { surfaceYAt: () => 1.4 });
			expect(drop?.position[1]).toBeCloseTo(1.4 + (CARD_REST_Y - TABLE_TOP_Y));
		});

		it('loses to an elevated snap point — snap.y comes first', () => {
			const s = state({
				cards: { a: card(0, 2, 0) },
				snapPoints: { 'snap:0': { id: 'snap:0', position: [4, 2], radius: 1, y: 3 } }
			});
			const drop = resolveDrop(s, 'a', { x: 4, z: 2 }, {}, { surfaceYAt: () => 1.4 });
			expect(drop?.position[1]).toBeCloseTo(3 + (CARD_REST_Y - TABLE_TOP_Y));
		});

		it('changes nothing when it answers undefined', () => {
			const s = state({ cards: { a: card(0, 2, 0) } });
			expect(resolveDrop(s, 'a', { x: 3, z: 1 }, {}, { surfaceYAt: () => undefined })).toEqual(
				resolveDrop(s, 'a', { x: 3, z: 1 })
			);
		});

		it('does not let elevation stick: a piece leaving the surface returns to felt rest', () => {
			// the CI regression shape (tableplace-135): a token rests on a model
			// surface, then is dropped somewhere with no model under it — the new
			// drop must recompute from TABLE_TOP_Y, never carry the old y along
			const surface = (x: number) => (x < 0 ? 1.55 : undefined); // model only on the left
			const options = { surfaceYAt: (x: number) => surface(x) };

			const onModel = state({ pieces: { 'piece:1': { position: [-4, PIECE_REST_Y, 1] } } });
			const raised = resolveDrop(onModel, 'piece:1', { x: -4, z: 1 }, {}, options);
			expect(raised?.position[1]).toBeCloseTo(1.55 + (PIECE_REST_Y - TABLE_TOP_Y));

			// same piece, now carrying the elevated y in its stored position
			const offModel = state({
				pieces: { 'piece:1': { position: raised!.position } }
			});
			const settled = resolveDrop(offModel, 'piece:1', { x: 6, z: 1 }, {}, options);
			expect(settled?.position[1]).toBeCloseTo(PIECE_REST_Y);
			expect(settled?.footprintY).toBeCloseTo(TABLE_TOP_Y);
		});
	});

	describe('snap grids', () => {
		// cells at x ∈ {8, 10, 12}, z ∈ {0, 2, 4}
		const withGrid = (over: Partial<GameDTO> = {}) =>
			state({
				snapPoints: {
					'snap:0': { id: 'snap:0', position: [10, 2], kind: 'grid', pitch: 2, cols: 3, rows: 3 }
				},
				...over
			});

		it('pulls a card to the nearest cell centre and reports the cell for the preview', () => {
			const s = withGrid({ cards: { a: card(0, 2, 0) } });
			const drop = resolveDrop(s, 'a', { x: 8.4, z: 3.7 });
			expect(drop).toMatchObject({
				kind: 'snap',
				position: [8, CARD_REST_Y, 4],
				snap: { id: 'snap:0', grid: { pitch: 2, rotation: 0 } }
			});
		});

		it('steps a card yaw to the nearest 90°, in degrees on rotation[2]', () => {
			const s = withGrid({ cards: { a: card(0, 2, 0, [180, 0, 130]) } });
			const drop = resolveDrop(s, 'a', { x: 10, z: 2 });
			// the facedown flip on rotation[0] survives, like any snap rotation
			expect(drop?.rotation).toEqual([180, 0, 90]);
		});

		it('steps a piece yaw in degrees on rotation[1]', () => {
			const s = withGrid({
				pieces: { 'piece:me:t': { position: [0, 1.2, 0], rotation: [0, 50, 0], kind: 'token' } }
			});
			const drop = resolveDrop(s, 'piece:me:t', { x: 10, z: 2 });
			expect(drop?.rotation).toEqual([0, 90, 0]);
			expect(drop?.position).toEqual([10, PIECE_REST_Y, 2]);
		});

		it('steps a deck yaw in RADIANS — the deck rotation convention', () => {
			// the deck carries 100° counter-clockwise as radians; the nearest 90°
			// multiple is 90° counter-clockwise, and it must go back in as
			// radians, not degrees (a degree write would spin the pile ~57×)
			const s = withGrid({
				decks: {
					'deck:me:main': {
						id: 'deck:me:main',
						position: [0, CARD_DRAG_Y, 0],
						rotation: [0, (100 * Math.PI) / 180, 0],
						cards: [{ id: 'c0', faceImageUrl: 'f.png' }]
					}
				}
			});
			const drop = resolveDrop(s, 'deck:me:main', { x: 10, z: 2 });
			expect(drop?.kind).toBe('snap');
			const [rx, ry, rz] = drop!.rotation;
			expect([rx, rz]).toEqual([0, 0]);
			expect(ry).toBeCloseTo(Math.PI / 2);
		});

		it('steps a deck onto the same yawed lattice as a card (tableplace-228)', () => {
			// a grid turned 30° has cells at 30°, 120°, … clockwise. A quarter-turn
			// lattice from 0° reads the same in both directions, so only a yawed
			// grid shows a deck stepped — or written back — with the wrong sign.
			const yawed = (over: Partial<GameDTO>) =>
				state({
					snapPoints: {
						'snap:0': {
							id: 'snap:0',
							position: [10, 2],
							kind: 'grid',
							pitch: 2,
							cols: 3,
							rows: 3,
							rotation: 30
						}
					},
					...over
				});
			// both carried at 40° clockwise: z = 40 on the card, -40° in radians on the deck
			const s = yawed({
				cards: { a: card(0, 2, 0, [0, 0, 40]) },
				decks: {
					'deck:me:main': {
						id: 'deck:me:main',
						position: [0, CARD_DRAG_Y, 0],
						rotation: [0, -40 * DEG2RAD, 0],
						cards: [{ id: 'c0', faceImageUrl: 'f.png' }]
					}
				}
			});
			expect(resolveDrop(s, 'a', { x: 10, z: 2 })?.rotation).toEqual([0, 0, 30]);
			const [rx, ry, rz] = resolveDrop(s, 'deck:me:main', { x: 10, z: 2 })!.rotation;
			expect([rx, rz]).toEqual([0, 0]);
			// 30° clockwise is 330° counter-clockwise, the deck's stored direction
			expect(ry).toBeCloseTo(330 * DEG2RAD);
		});

		it('is opted out of by Alt like any snap', () => {
			const s = withGrid({ cards: { a: card(0, 2, 0) } });
			expect(resolveDrop(s, 'a', { x: 10, z: 2 }, {}, { noSnap: true })?.kind).toBe('table');
		});

		/**
		 * Composition with per-card `orientation` (tableplace-132). A landscape
		 * card's quarter turn is render-only: the synced rotation[2] stays
		 * orientation-relative, and tapCard is additive on it. The grid must
		 * therefore step the SYNCED yaw and never consult the rendered one —
		 * stepping rendered yaw would bake the 90° offset into the store, the
		 * exact leak tableplace-132 was built to prevent, and tapping the landed
		 * card would then lay it the wrong way.
		 */
		describe('composes with per-card orientation (tableplace-132)', () => {
			const landscape = (
				x: number,
				y: number,
				z: number,
				rotation: [number, number, number] = [0, 0, 0]
			) => ({ ...card(x, y, z, rotation), orientation: 'landscape' as const });

			it('a resting landscape card (synced yaw 0) lands with its yaw untouched', () => {
				// stepped from the rendered yaw it would come back 90 — the card
				// would stand upright on landing instead of staying landscape
				const s = withGrid({ cards: { a: landscape(0, 2, 0) } });
				expect(resolveDrop(s, 'a', { x: 10, z: 2 })?.rotation).toEqual([0, 0, 0]);
			});

			it('steps identically to a portrait card with the same synced rotation', () => {
				// the resolver is orientation-blind on purpose: the offset lives in
				// the renderer, so in synced space the two cards are the same card
				const asLandscape = withGrid({ cards: { a: landscape(0, 2, 0, [180, 0, 130]) } });
				const asPortrait = withGrid({ cards: { a: card(0, 2, 0, [180, 0, 130]) } });
				const landed = resolveDrop(asLandscape, 'a', { x: 10, z: 2 });
				expect(landed?.rotation).toEqual([180, 0, 90]);
				expect(landed?.rotation).toEqual(resolveDrop(asPortrait, 'a', { x: 10, z: 2 })?.rotation);
			});

			it('keeps a discrete point yaw orientation-relative too', () => {
				const s = state({
					snapPoints: { 'snap:0': { id: 'snap:0', position: [4, 2], radius: 1, rotation: 90 } },
					cards: { a: landscape(0, 2, 0) }
				});
				// the authored 90 goes into the synced slot as-is; the renderer
				// adds the landscape quarter-turn on top
				expect(resolveDrop(s, 'a', { x: 4, z: 2 })?.rotation).toEqual([0, 0, 90]);
			});
		});
	});

	describe('per-piece snap opt-out (snap: false)', () => {
		const withSnapAndPieces = () =>
			state({
				snapPoints: { 'snap:0': { id: 'snap:0', position: [4, 2], radius: 1, rotation: 90 } },
				pieces: {
					'piece:me:snappy': { position: [0, 1.2, 0], rotation: [0, 0, 0], kind: 'token' },
					'piece:me:loose': {
						position: [0, 1.2, 0],
						rotation: [0, 0, 0],
						kind: 'token',
						snap: false
					},
					'piece:me:bag': { kind: 'bag', position: [4, PIECE_REST_Y, 2], radius: 0.9 }
				}
			});

		it('drops as if Alt were held — position and rotation untouched by the point', () => {
			const s = withSnapAndPieces();
			const drop = resolveDrop(s, 'piece:me:loose', { x: 4.2, z: 2 });
			expect(drop).toMatchObject({ kind: 'table', position: [4.2, PIECE_REST_Y, 2] });
			expect(drop?.rotation).toEqual([0, 0, 0]);
			expect(drop?.snap).toBeUndefined();
		});

		it('leaves every other piece snapping as before', () => {
			const drop = resolveDrop(withSnapAndPieces(), 'piece:me:snappy', { x: 4.2, z: 2 });
			expect(drop).toMatchObject({ kind: 'snap', position: [4, PIECE_REST_Y, 2] });
		});

		it('does not opt out of aimed-at targets: a bag still swallows it', () => {
			const drop = resolveDrop(
				withSnapAndPieces(),
				'piece:me:loose',
				{ x: 4, z: 2 },
				{ bagId: 'piece:me:bag' }
			);
			expect(drop?.kind).toBe('bag');
		});
	});
});
