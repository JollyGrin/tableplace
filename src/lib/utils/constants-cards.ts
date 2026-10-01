import * as THREE from 'three';
import { CARD_THICKNESS } from './constants-card-rest';

// plain numbers the headless composer needs too — see constants-card-rest.ts
export { CARD_THICKNESS, CARD_REST_Y } from './constants-card-rest';

/**
 * Physical card dimensions in world units.
 * Cards need real thickness so stacked cards never share a plane —
 * coplanar surfaces z-fight regardless of depth-buffer precision.
 */
export const CARD_WIDTH = 1.4;
export const CARD_HEIGHT = 2;

/** Corner radius of the printed face (ImageMaterial radius prop) */
export const CARD_CORNER_RADIUS = 0.1;

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
	const w = width / 2;
	const h = height / 2;
	const s = new THREE.Shape();
	s.moveTo(-w + radius, -h);
	s.lineTo(w - radius, -h);
	s.absarc(w - radius, -h + radius, radius, -Math.PI / 2, 0, false);
	s.lineTo(w, h - radius);
	s.absarc(w - radius, h - radius, radius, 0, Math.PI / 2, false);
	s.lineTo(-w + radius, h);
	s.absarc(-w + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
	s.lineTo(-w, -h + radius);
	s.absarc(-w + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);
	return s;
}

/**
 * Rounded-rect slab lying flat: width along X, height along Z, thickness
 * along Y, centered on the origin. Extrude side-wall UVs put v along the
 * thickness axis (v = 1 - z before rotation), so a repeat-wrapped texture's
 * rows wrap around the sides as horizontal bands.
 */
function roundedSlabGeometry(
	width: number,
	height: number,
	radius: number,
	thickness: number
): THREE.ExtrudeGeometry {
	const geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, height, radius), {
		depth: thickness,
		bevelEnabled: false,
		curveSegments: 8
	});
	geometry.translate(0, 0, -thickness / 2);
	geometry.rotateX(-Math.PI / 2);
	return geometry;
}

/**
 * Shared body geometry for every card: same footprint and corner radius as
 * the printed face, so the two share one silhouette with no overhanging lip.
 * The body is thinner than CARD_THICKNESS (see roundedSlabGeometry call
 * below) so its flat lids sit just under the face planes — that vertical gap
 * avoids z-fighting between the white lid and the printed face; it's not a
 * lateral inset. Static — build once, share across all card instances.
 */
export const cardBodyGeometry = roundedSlabGeometry(
	CARD_WIDTH,
	CARD_HEIGHT,
	CARD_CORNER_RADIUS,
	CARD_THICKNESS * 0.92
);

/**
 * Shared deck body geometry, unit height (scale the mesh's Y to the deck's
 * actual height). Side-wall v spans exactly 0..1 over the unit thickness, so
 * texture.repeat.y = number of stripe-texture repeats across the full height.
 * Same footprint/radius as the card face — no lateral inset (see cardBodyGeometry).
 */
export const deckBodyGeometry = roundedSlabGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_CORNER_RADIUS, 1);

/**
 * Deck body height per card, clamped so a huge deck doesn't tower and an
 * almost-empty pile is still grabbable. 40 cards ≈ the old fixed 0.4 slab.
 */
export const DECK_HEIGHT_PER_CARD = 0.01;
export const DECK_MIN_HEIGHT = 0.1;
export const DECK_MAX_HEIGHT = 0.5;
export function deckHeightForCount(count: number): number {
	return THREE.MathUtils.clamp(count * DECK_HEIGHT_PER_CARD, DECK_MIN_HEIGHT, DECK_MAX_HEIGHT);
}

/**
 * The editor's selection mark. `/create`'s cursors say which card is being
 * edited, but on the table that answer used to exist nowhere at all (#109), so
 * the selected card floats over a coloured pad the size of its own footprint
 * plus a border.
 *
 * The lift is deliberately small: the spread's camera is close to top-down,
 * and a tall float would slide the card visibly off the pad it is meant to
 * mark. It is a RENDER offset only — never written to the store — so stacking
 * and drop resolution are untouched (both ignore cards above
 * `CARD_STACK_MAX_Y`, which this stays well clear of).
 */
export const CARD_PICK_LIFT = 0.2;

/** Pad border visible around the selected card, per side */
export const CARD_PICK_HALO = 0.14;

/** Same violet as the snap markers: an editor overlay, not table content. */
export const CARD_PICK_COLOR = '#a78bfa';

/**
 * Height a card floats at while being dragged. Shared by every drag entry
 * point (table, deck, tray) so the store position matches what is rendered —
 * the drop indicator's connector line is drawn to this height.
 */
export const CARD_DRAG_Y = 2;

/*
 * The deck's arm-for-move constants (hold duration, lift, amber cue) lived
 * here for tableplace-103. tableplace-161 gave the long press to the radial
 * menu and the pile move to its "Move pile" wedge, so there is no armed state
 * left to time or to draw — see Deck.svelte and drop/grab.ts.
 */

/**
 * Max XZ center-distance for two cards to count as stacked.
 * Covers any overlap of two 1.4x2 cards regardless of tap rotation.
 */
export const CARD_STACK_RADIUS = 1.7;

/**
 * Cards above this height are mid-drag/animation and are ignored
 * when resolving where a dropped card should rest.
 */
export const CARD_STACK_MAX_Y = 1.0;

/**
 * Per-card cascade of a hovered loose pile (render-only, see `fanOffset`).
 * Roughly a fifth of the card's 2-unit length: enough of the top edge to read
 * the title band, without throwing a big pile across the felt.
 */
export const CARD_FAN_STEP = 0.42;
