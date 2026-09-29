import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { requestCameraReset } from '$lib/store/cameraStore.svelte';

// reset camera to the seat's default top-down view (like a fresh page load)
function resetView() {
	requestCameraReset();
}

function togglePreviewHud(isPreview?: boolean) {
	const currentPreviewState = get(dragStore).isPreview;
	const targetPreviewState =
		isPreview !== undefined ? isPreview : !currentPreviewState;
	dragStore.update((state) => ({
		...state,
		isPreview: targetPreviewState
	}));
}

export const cameraTransforms = {
	resetView,
	togglePreviewHud
};
