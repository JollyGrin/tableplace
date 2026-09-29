import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import {
	requestCameraPreset,
	requestCameraReset,
	type CameraFocus
} from '$lib/store/cameraStore.svelte';

// back to the seat's angled view of the whole table (like a fresh page load)
function resetView() {
	requestCameraReset();
}

// straight down for precise placement, and back to the seat view
function toggleTopDown() {
	requestCameraPreset('toggle-top');
}

// frame one entity; without one, the one this player moved last
function focus(entity?: CameraFocus) {
	requestCameraPreset('focus', entity);
}

function togglePreviewHud(isPreview?: boolean) {
	const currentPreviewState = get(dragStore).isPreview;
	const targetPreviewState = isPreview !== undefined ? isPreview : !currentPreviewState;
	dragStore.update((state) => ({
		...state,
		isPreview: targetPreviewState
	}));
}

export const cameraTransforms = {
	resetView,
	toggleTopDown,
	focus,
	togglePreviewHud
};
