import { MeshBasicMaterial } from 'three';

/**
 * The one material every overlay's lift-time dim plane shares (tableplace-188).
 *
 * `SnapGuides.svelte` owns the fade and writes this material's opacity and
 * `visible` from its frame task; each `OverlayCustom` under a snap point just
 * mounts a plane with it. One shared material instead of a store means the
 * fade touches no Svelte state per frame and no overlay re-renders — and
 * `visible: false` at rest costs the overlays nothing to draw.
 */
export const snapGuideDimMaterial = new MeshBasicMaterial({
	color: '#07100b',
	transparent: true,
	opacity: 0,
	depthWrite: false,
	visible: false
});
