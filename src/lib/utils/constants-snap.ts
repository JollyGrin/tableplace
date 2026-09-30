import { TABLE_TOP_Y } from './constants-table';

/**
 * Snap points — authored placement guides on the felt. A drop that lands
 * inside a point's catch radius finishes exactly on the point.
 */

/**
 * Catch radius for a snap point that doesn't declare one, in world units.
 * Sized off the card footprint: a shade under half a card's length, so two
 * snap points a card-length apart never fight over the same drop, and a drop
 * aimed at the point still catches if it lands anywhere over its middle.
 */
export const SNAP_RADIUS_DEFAULT = 0.9;

/** Below this a point could never catch anything; authored values clamp up. */
export const SNAP_RADIUS_MIN = 0.05;

/**
 * Sanity ceiling for an authored radius — a whole-table snap point is a bug.
 * Deliberately not applied to a grid's extent: a grid covers area on purpose.
 */
export const SNAP_RADIUS_MAX = 15;

/**
 * Yaw stepping a grid applies when it doesn't author `yawStep`: snapped
 * entities' yaw rounds to the nearest 90° — the modular-kit case, and the
 * right-angle world most tile-layers live in.
 */
export const SNAP_GRID_YAW_STEP_DEFAULT = 90;

/** What the editor stamps on a point freshly switched to `kind: 'grid'`. */
export const SNAP_GRID_PITCH_DEFAULT = 2;
export const SNAP_GRID_COLS_DEFAULT = 3;
export const SNAP_GRID_ROWS_DEFAULT = 3;

/** y the editor draws snap markers at: on the felt, under everything that rests on it. */
export const SNAP_MARKER_Y = TABLE_TOP_Y + 0.0015;

/** Editor marker colors: idle, and while being dragged. */
export const SNAP_MARKER_COLOR = '#a78bfa';
export const SNAP_MARKER_COLOR_ACTIVE = '#f0abfc';

/** A one-way link's arrowhead in the editor: its size, and how far along the line it sits. */
export const SNAP_LINK_ARROW_SIZE = 0.2;
export const SNAP_LINK_ARROW_AT = 0.6;

/** Color the drop preview uses when a drop is caught by a snap point. */
export const SNAP_DROP_COLOR = '#c4b5fd';

/**
 * Snap guides (tableplace-188): while an entity that can snap is lifted, every
 * point it could land on shows a ring and the one that will catch the drop is
 * filled. Purely local rendering — see `drop/SnapGuides.svelte`.
 */

/** how long the guides take to fade fully in or out, in seconds */
export const SNAP_GUIDE_FADE_S = 0.15;

/** peak opacities: ring outlines, the filled catching target, the overlay dim */
export const SNAP_GUIDE_RING_OPACITY = 0.7;
export const SNAP_GUIDE_FILL_OPACITY = 0.45;
export const SNAP_GUIDE_DIM_OPACITY = 0.28;

/**
 * Height above a point's floor the guides draw at: over a map overlay (felt +
 * 0.003) and still under the contact-shadow plane (felt + 0.0045), which is
 * also why the guides never cast into that pass.
 */
export const SNAP_GUIDE_LIFT = 0.004;

/** the overlay dim sits just over its image, under the rings */
export const SNAP_GUIDE_DIM_LIFT = 0.0035;

/**
 * A grid shows only the cells whose centres are within this many world units
 * of the pointer — never the whole lattice. Never less than one pitch, so a
 * coarse grid still shows the cell under the pointer.
 */
export const SNAP_GUIDE_GRID_REVEAL = 3;

/** a revealed cell is drawn this fraction of its pitch, so neighbours read apart */
export const SNAP_GUIDE_CELL_INSET = 0.86;

/**
 * three.js layer the guides render on. The main camera enables it; the
 * contact-shadow camera and every raycaster stay on layer 0, so a guide can
 * neither darken the felt nor intercept a pointer.
 */
export const SNAP_GUIDE_LAYER = 2;

/**
 * Reach rings (tableplace-190): lifting a piece with `reach` off a linked snap
 * point draws the points within reach brighter than the rest. Advisory — the
 * other rings stay drawn, and still catch.
 */

/** peak opacity of a point within reach */
export const SNAP_GUIDE_REACH_OPACITY = 0.95;

/** what every other ring fades to while a reach set is showing, so the reach reads */
export const SNAP_GUIDE_OUT_OF_REACH_OPACITY = 0.3;

/** a ring within reach is this much wider than its catch radius, so it reads as a glow */
export const SNAP_GUIDE_REACH_SCALE = 1.08;

/** a ring within reach is drawn in this lighter tone of the drop colour */
export const SNAP_GUIDE_REACH_COLOR = '#ede9fe';
