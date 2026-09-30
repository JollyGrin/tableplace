/**
 * The open radial menu, if any — render-only client state, exactly like
 * `pieceUi`'s `hoveredPiece`. Nothing here is ever patched into `GameDTO`.
 *
 * It lives outside the scene because the wheel is DOM: it renders next to the
 * `<Canvas>` so its text stays legible at any camera angle and the pointer
 * never fights the table's drag handling. The entities only announce "a press
 * landed on me" (see radial/gesture.ts); everything else happens here.
 */

import { derived, writable } from 'svelte/store';
import type { RadialOption, RadialTarget } from '$lib/radial/actions';

/**
 * `flick` is a live gesture: the button is still down, the highlight follows
 * the pointer and the release decides. `sticky` is a menu that stays up after a
 * quick right-click and waits for a click.
 */
export type RadialMode = 'flick' | 'sticky';

export type RadialMenuState = {
	target: RadialTarget;
	mode: RadialMode;
	/** press origin in client coords — the wheel's centre and the angle origin */
	x: number;
	y: number;
	/** resolved once at open time, so the wedges cannot change under the pointer */
	options: RadialOption[];
	/** wedge under the pointer, or null for the deadzone / a sparse wheel's gap */
	hover: number | null;
};

export const radialMenu = writable<RadialMenuState | null>(null);

/**
 * How many `RadialMenu.svelte` overlays are mounted.
 *
 * The entities that open the wheel live in `TableScene`, which /create mounts
 * too — for the pack editor's live preview, where a wheel is not part of the
 * editing model. Without this, a press there would open a menu with nothing
 * drawing it and the release would fire an action nobody could see coming. A
 * route opts in by rendering the overlay; that is the whole opt-in.
 */
let surfaces = 0;

export function registerRadialSurface(): () => void {
	surfaces++;
	return () => {
		surfaces--;
		if (surfaces <= 0) radialMenu.set(null);
	};
}

export function hasRadialSurface(): boolean {
	return surfaces > 0;
}

/** the table camera reads this: OrbitControls must not pan while the wheel is up */
export const isRadialOpen = derived(radialMenu, (menu) => menu !== null);

export function openRadialMenu(state: Omit<RadialMenuState, 'hover'>) {
	radialMenu.set({ ...state, hover: null });
}

export function setRadialHover(index: number | null) {
	radialMenu.update((menu) => (menu && menu.hover !== index ? { ...menu, hover: index } : menu));
}

export function closeRadialMenu() {
	radialMenu.set(null);
}
