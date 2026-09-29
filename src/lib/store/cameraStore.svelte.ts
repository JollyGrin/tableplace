import { writable } from 'svelte/store';

/**
 * The camera presets (tableplace-185):
 * - `seat`: the angled view from your own side of the table, whole table in frame (C)
 * - `toggle-top`: straight down if you are not looking straight down, else back to `seat` (P)
 * - `focus`: frame one entity — the one named, or the one you moved last (Z, double-click)
 */
export type CameraPreset = 'seat' | 'toggle-top' | 'focus';

/** what a focus frames: an entity on the table */
export type CameraFocus = { kind: 'card' | 'deck' | 'piece'; id: string };

export type CameraRequest = { n: number; preset: CameraPreset; focus?: CameraFocus };

/** Incremented to request a preset move; TableCamera reacts to changes. */
export const cameraRequest = writable<CameraRequest>({ n: 0, preset: 'seat' });

export function requestCameraPreset(preset: CameraPreset, focus?: CameraFocus) {
	cameraRequest.update(({ n }) => ({ n: n + 1, preset, ...(focus ? { focus } : {}) }));
}

/** back to the seat view (keybind C) */
export function requestCameraReset() {
	requestCameraPreset('seat');
}

/**
 * Incremented to ask TableCamera to push its current pose onto the ephemeral
 * `camera` stream even though it hasn't moved — used when a peer joins, since
 * the server never replays ephemeral messages to a joiner.
 */
export const cameraBroadcastSignal = writable(0);

export function requestCameraBroadcast() {
	cameraBroadcastSignal.update((n) => n + 1);
}
