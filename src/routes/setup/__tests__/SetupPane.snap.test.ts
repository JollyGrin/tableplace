/**
 * The /setup snap-point layer, driven through the real tweakpane controls in
 * jsdom (like PaneDecks.test.ts / HUDPieces.test.ts).
 *
 * Two things are being guarded. The obvious one: place → move → delete works
 * from the pane. The subtle one: the snap-point list is a `{#each}` of tabs that
 * appears once the first point exists, and in this repo a pane whose blade tree
 * is edited the wrong way tears itself down silently — no error, just an empty
 * pane (see the comments in create/BulkSheet.svelte). So every assertion here
 * also checks the pane's other controls are still rendered afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import SetupPane from '../SetupPane.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { snapEditor } from '$lib/store/snapEditor';
import { SNAP_RADIUS_DEFAULT } from '$lib/utils/constants-snap';

// jsdom has neither observer: the draggable Pane watches its own size, and the
// camerakit Wheel blade (the rotation dials) waits to be added to the DOM
class NoopObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('IntersectionObserver', NoopObserver);

/** tweakpane renders asynchronously; let its microtasks flush */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const button = (container: HTMLElement, label: string) =>
	[...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

const snapPoints = () => get(gameStore).snapPoints ?? {};

describe('SetupPane — snap points', () => {
	beforeEach(() => {
		cleanup();
		localStorage.clear();
		gameStore.set({ players: {}, cards: {}, decks: {}, pieces: {}, overlays: {}, snapPoints: {} });
	});

	it('places a point, and the pane survives the list appearing', async () => {
		const { container } = render(SetupPane);
		await settle();

		const add = button(container, 'Add at table centre');
		expect(add).toBeDefined();
		await fireEvent.click(add!);
		await settle();

		expect(Object.values(snapPoints())).toEqual([
			{ id: 'snap:0', position: [0, 0], radius: SNAP_RADIUS_DEFAULT }
		]);
		// the blade tree grew a TabGroup — the pane must still be intact
		expect(button(container, 'Add at table centre')).toBeDefined();
		expect(button(container, 'Delete this point')).toBeDefined();
		expect(button(container, 'Clear table')).toBeDefined();
	});

	it('deletes the selected point, and the pane survives the list going away', async () => {
		const { container } = render(SetupPane);
		await settle();
		await fireEvent.click(button(container, 'Add at table centre')!);
		await settle();

		await fireEvent.click(button(container, 'Delete this point')!);
		await settle();

		expect(snapPoints()).toEqual({});
		expect(button(container, 'Add at table centre')).toBeDefined();
		expect(button(container, 'Delete this point')).toBeUndefined();
	});

	it('reflects a point moved in the scene, with no remount', async () => {
		const { container } = render(SetupPane);
		await settle();
		await fireEvent.click(button(container, 'Add at table centre')!);
		await settle();

		// what dragging the marker does (SnapPointMarker.svelte)
		gameActions.moveSnapPoint('snap:0', [4, -2]);
		await settle();

		expect(snapPoints()['snap:0']?.position).toEqual([4, -2]);
		expect(button(container, 'Delete this point')).toBeDefined();
	});

	it('arms click-to-place for the table mesh', async () => {
		const { container } = render(SetupPane);
		await settle();
		expect(get(snapEditor).placing).toBe(false);

		// the snap folder's first checkbox (the Table folder above has its own)
		const checkbox = [
			...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
		].find((input) => input.closest('.tp-lblv')?.textContent?.includes('place on click'));
		expect(checkbox).not.toBeNull();
		await fireEvent.click(checkbox!);
		await settle();

		expect(get(snapEditor).placing).toBe(true);
		// and the defaults the click will stamp are published
		expect(get(snapEditor).radius).toBe(SNAP_RADIUS_DEFAULT);
	});

	it('clears snap points along with the rest of the table', async () => {
		const { container } = render(SetupPane);
		await settle();
		await fireEvent.click(button(container, 'Add at table centre')!);
		await settle();

		// non-empty table: the first click only arms the button (#114)
		await fireEvent.click(button(container, 'Clear table')!);
		await settle();
		expect(snapPoints()).not.toEqual({});

		await fireEvent.click(button(container, 'Really clear the whole table?')!);
		await settle();

		expect(snapPoints()).toEqual({});
	});
});
