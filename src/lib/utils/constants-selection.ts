/**
 * The selection ring (tableplace-202): the outline every selected card, deck
 * and piece wears. Its own colour — not the drop indicator's cyan, the stack
 * amber or the snap violets — because during a group drag all of them are on
 * screen at once and each has to read as what it is.
 */
export const SELECTION_RING_COLOR = '#f0abfc';
/** how far the ring stands out past the entity's own footprint, each side */
export const SELECTION_RING_MARGIN = 0.18;
/** the outline's thickness, in world units */
export const SELECTION_RING_BORDER = 0.08;
/** a whisper of fill inside it, so a selected thing reads at a low angle */
export const SELECTION_RING_FILL = 0.06;
