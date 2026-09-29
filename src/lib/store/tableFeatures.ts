import { writable } from 'svelte/store';

/**
 * Which table surfaces the current route mounts.
 *
 * `TableScene` publishes this from its props so the pieces that resolve a drop
 * (`commit.ts`, `DropIndicator`) can't offer a target the route never rendered.
 * The pack editor is the case that needs it: `/create` has no hand — a hand
 * holds cards no pack can represent, and a card dropped there would survive
 * every preview respawn invisibly.
 */
export interface TableFeatures {
	/** whether the local hand tray is mounted, and so may win a drop */
	hand: boolean;
	/**
	 * Whether snap points are being authored, and so drawn on the felt.
	 *
	 * Only /setup sets it. Snap points still *work* everywhere — a drop is
	 * caught by them on any route — they just aren't drawn at rest in /play,
	 * where an authored board would otherwise be permanently speckled with
	 * rings. The drop preview highlights the one that caught the drag, which is
	 * the moment the guide is actually worth seeing.
	 */
	snapEditing: boolean;
	/**
	 * Where a plain click on a deck sends the drawn card: your hand (`true`,
	 * /play) or the felt in front of the deck. Shift+click always takes the
	 * felt. Off in /setup, where the table is being authored and a hand is not
	 * part of what a scenario saves, and wherever there is no hand to receive.
	 */
	drawToHand: boolean;
}

export const TABLE_FEATURES_DEFAULT: TableFeatures = {
	hand: true,
	snapEditing: false,
	drawToHand: true
};

export const tableFeatures = writable<TableFeatures>({ ...TABLE_FEATURES_DEFAULT });

export function setTableFeatures(patch: Partial<TableFeatures>) {
	tableFeatures.set({ ...TABLE_FEATURES_DEFAULT, ...patch });
}
