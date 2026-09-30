/**
 * Render-only UI state for pieces: which one the pointer is over. Nothing here
 * is ever patched into `GameDTO` — it is local to this client, exactly like
 * `dragStore`'s hover fields.
 *
 * It lives outside Piece.svelte because its consumers are elsewhere: the piece
 * hotkeys (on `window`) and the felt's radial veto need to know what is hovered.
 * A piece's menu is the radial wheel (radial/gesture.ts).
 */

import { writable } from 'svelte/store';

/** id of the piece under the pointer, or null */
export const hoveredPiece = writable<string | null>(null);

export function setPieceHover(id: string) {
	hoveredPiece.set(id);
}

/** Only the piece that claimed the hover may release it (pointerleave order). */
export function clearPieceHover(id: string) {
	hoveredPiece.update((current) => (current === id ? null : current));
}
