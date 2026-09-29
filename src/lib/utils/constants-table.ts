/**
 * Table geometry in world units.
 * The felt is a 60×30 box centred on the origin; its top face is at
 * TABLE_TOP_Y (the box is 0.5 thick and sits with its centre at y = 0).
 */
export const TABLE_HALF_X = 30;
export const TABLE_HALF_Z = 15;
export const TABLE_TOP_Y = 0.255;

/**
 * Dragged entities are clamped this far inside the edge so they always land
 * on the felt and stay grabbable.
 */
export const EDGE_MARGIN = 1;

/**
 * The wooden rim framing the felt: a flat-topped frame this wide, standing
 * TABLE_RIM_RISE proud of the felt and dropping TABLE_RIM_DROP below it, so a
 * seat view sees a table edge with an apron rather than a slab in the void.
 * It sits wholly outside the felt, so nothing clamped by EDGE_MARGIN rests on
 * it, and the rise is kept low: an overhanging board or model clips it least.
 */
export const TABLE_RIM_WIDTH = 1.4;
export const TABLE_RIM_RISE = 0.2;
export const TABLE_RIM_DROP = 1.4;

/**
 * The room the table stands in: a flat, warm near-black. It is the renderer's
 * clear colour (scene.background), which costs nothing per frame, and the page
 * wrappers paint the same tone so the canvas never flashes a different one.
 */
export const ROOM_COLOR = '#17120e';
