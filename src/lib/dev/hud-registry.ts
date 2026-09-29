/**
 * Where the dev test bridge finds the `<HUD>` roots. Each HUD has its own scene
 * and orthographic camera (see HUDTrayScene), invisible to the table scene the
 * bridge otherwise reads, so a HUD that the harness needs to see into
 * registers its handles here. Only called under `import.meta.env.DEV`.
 */

import type * as THREE from 'three';

export type HudKey = 'tray' | 'preview';

export type HudHandles = {
	camera: () => THREE.Camera | undefined;
	scene: () => THREE.Scene | undefined;
};

export const huds = new Map<HudKey, HudHandles>();

/** Register a HUD root; returns the unregister, for `onMount`. */
export function registerHud(key: HudKey, handles: HudHandles): () => void {
	huds.set(key, handles);
	return () => {
		if (huds.get(key) === handles) huds.delete(key);
	};
}
