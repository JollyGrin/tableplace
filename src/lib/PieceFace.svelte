<script lang="ts">
	import { T } from '@threlte/core';
	import { SRGBColorSpace, TextureLoader, type Texture } from 'three';
	import { loadTextureImage } from '$lib/utils/image-cors';

	/**
	 * The printed face of a round piece: an image on a flat disc.
	 *
	 * Not `ImageMaterial` (tableplace-175). That shader sizes its cover-fit from
	 * `geometry.parameters.width/height`, which only a plane has — on a
	 * `CircleGeometry` its `scale` uniform goes NaN and every fragment comes out
	 * blank, so a token drew as the bare disc under it while the image fetched
	 * fine. Here the texture maps straight onto the circle's UVs (the disc
	 * inscribed in the unit square) with the cover crop done by repeat/offset,
	 * and it loads through the same CORS-fallback path the map overlay uses.
	 */
	let {
		url,
		radius,
		segments = 36,
		position
	}: {
		url: string;
		radius: number;
		segments?: number;
		position?: [number, number, number];
	} = $props();

	let texture = $state<Texture | null>(null);

	$effect(() => {
		let cancelled = false;
		let loaded: Texture | null = null;
		loadTextureImage(url).then(async (image) => {
			if (cancelled || !image) return; // dead link: the plain disc stays
			const next = await new TextureLoader().loadAsync(image.url).catch(() => null);
			if (!next) return;
			if (cancelled) return next.dispose();
			next.colorSpace = SRGBColorSpace;
			// cover, not stretch: crop the long axis to the centred square
			const aspect = image.width / image.height;
			if (aspect > 1) {
				next.repeat.set(1 / aspect, 1);
				next.offset.set((1 - 1 / aspect) / 2, 0);
			} else if (aspect < 1) {
				next.repeat.set(1, aspect);
				next.offset.set(0, (1 - aspect) / 2);
			}
			loaded = next;
			texture = next;
		});
		return () => {
			cancelled = true;
			loaded?.dispose();
			texture = null;
		};
	});
</script>

{#if texture}
	<T.Mesh rotation.x={-Math.PI / 2} {position}>
		<T.CircleGeometry args={[radius, segments]} />
		<T.MeshBasicMaterial map={texture} transparent />
	</T.Mesh>
{/if}
