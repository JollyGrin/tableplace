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
	 *
	 * A square token's face (tableplace-254) is the other mode: give `w` and `h`
	 * and the image is laid on a plane of that size with no crop at all — the
	 * caller sizes the plane to the image's aspect (`imageAspect`), so nothing
	 * is stretched either. Numbers rather than a size object, so an unchanged
	 * size never rebuilds the geometry.
	 */
	let {
		url,
		radius = 0,
		segments = 36,
		w = 0,
		h = 0,
		position
	}: {
		url: string;
		/** the disc's radius; unused when `w` and `h` make it a plane */
		radius?: number;
		segments?: number;
		/** plane size — both set means the uncropped rectangular face */
		w?: number;
		h?: number;
		position?: [number, number, number];
	} = $props();

	const isPlane = $derived(w > 0 && h > 0);

	let texture = $state<Texture | null>(null);
	let aspect = $state(1);

	$effect(() => {
		let cancelled = false;
		let loaded: Texture | null = null;
		loadTextureImage(url).then(async (image) => {
			if (cancelled || !image) return; // dead link: the plain disc stays
			const next = await new TextureLoader().loadAsync(image.url).catch(() => null);
			if (!next) return;
			if (cancelled) return next.dispose();
			next.colorSpace = SRGBColorSpace;
			aspect = image.width / image.height;
			loaded = next;
			texture = next;
		});
		return () => {
			cancelled = true;
			loaded?.dispose();
			texture = null;
		};
	});

	// The crop is a property of the face's outline, not of the image, so it is
	// applied here rather than at load: a disc covers — the long axis cropped to
	// the centred square — and a plane shows the whole image.
	$effect(() => {
		if (!texture) return;
		if (isPlane || aspect === 1) {
			texture.repeat.set(1, 1);
			texture.offset.set(0, 0);
		} else if (aspect > 1) {
			texture.repeat.set(1 / aspect, 1);
			texture.offset.set((1 - 1 / aspect) / 2, 0);
		} else {
			texture.repeat.set(1, aspect);
			texture.offset.set(0, (1 - aspect) / 2);
		}
	});
</script>

{#if texture}
	<T.Mesh rotation.x={-Math.PI / 2} {position}>
		{#if isPlane}
			<T.PlaneGeometry args={[w, h]} />
		{:else}
			<T.CircleGeometry args={[radius, segments]} />
		{/if}
		<T.MeshBasicMaterial map={texture} transparent />
	</T.Mesh>
{/if}
