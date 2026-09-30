<script lang="ts">
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { T } from '@threlte/core';
	import { ImageMaterial } from '@threlte/extras';
	import { loadTextureImage } from '$lib/utils/image-cors';
	import { snapGuideDimMaterial } from '$lib/drop/snap-guide-dim';
	import { overlayUnderSnapPoints } from '$lib/drop/snap-guides';
	import { SNAP_GUIDE_DIM_LIFT, SNAP_GUIDE_LAYER } from '$lib/utils/constants-snap';

	const FLOOR_HEIGHT = 0.255;
	// lift the map plane above the table Grid (also at 0.255) — coplanar surfaces
	// z-fight. Applied on the mesh, not the group, so it also fixes overlays whose
	// synced position already stores y = 0.255. Stays below card rest height (0.26).
	const GRID_CLEARANCE = 0.003;

	let { id = '' }: { id: string } = $props();
	const overlay = $derived($gameStore.overlays?.[id]);

	// resolved through the CORS fallback; null until loaded, stays null on dead links
	let resolvedUrl = $state<string | null>(null);
	let ratio = $state(1);

	$effect(() => {
		const url = overlay?.imageUrl ?? '';
		resolvedUrl = null;
		if (!url) return;
		let cancelled = false;
		loadTextureImage(url).then((loaded) => {
			if (cancelled || !loaded) return;
			ratio = loaded.width / loaded.height;
			resolvedUrl = loaded.url;
		});
		return () => {
			cancelled = true;
		};
	});

	// plane is aspect-normalized (height 1); overlay.scale = world height
	const worldScale = $derived(overlay?.scale ?? 12);

	/**
	 * Recedes while something that snaps is lifted, so the landing spots on it
	 * read (tableplace-188). Only an overlay with a snap point on it: the plane
	 * shares one material whose fade `drop/SnapGuides` drives, so this costs no
	 * state and no draw while nothing is lifted. A boolean, so a drag's
	 * per-move store updates don't remount it.
	 */
	const dimmable = $derived(
		overlayUnderSnapPoints(
			$gameStore.snapPoints,
			overlay?.position,
			overlay?.rotation?.[1] ?? 0,
			ratio * worldScale,
			worldScale
		)
	);
</script>

{#if resolvedUrl}
	<T.Group position={overlay?.position ?? [0, FLOOR_HEIGHT, 0]} rotation={overlay?.rotation}>
		<T.Mesh receiveShadow rotation.x={-Math.PI / 2} position.y={GRID_CLEARANCE} scale={worldScale}>
			<T.PlaneGeometry args={[ratio, 1]} />
			<ImageMaterial url={resolvedUrl} side={0} radius={0.02} />
		</T.Mesh>
		{#if dimmable}
			<T.Mesh
				rotation.x={-Math.PI / 2}
				position.y={SNAP_GUIDE_DIM_LIFT}
				scale={worldScale}
				material={snapGuideDimMaterial}
				oncreate={(mesh) => mesh.layers.set(SNAP_GUIDE_LAYER)}
			>
				<T.PlaneGeometry args={[ratio, 1]} />
			</T.Mesh>
		{/if}
	</T.Group>
{/if}
