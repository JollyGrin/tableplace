<script lang="ts">
	import { T } from '@threlte/core';
	import { ImageMaterial } from '@threlte/extras';

	// The preview is display-only: nothing here registers a pointer handler, so
	// it needs no interactivity context of its own.
	let {
		url,
		landscape = false,
		scale = 2.75
	}: { url: string; landscape?: boolean; scale?: number } = $props();

	// landscape cards preview turned on their side — the art stays portrait in
	// the texture, so the mesh rotates rather than the size tuple swapping
	const cardSize = [1.4 * 1.4, 2 * 1.4];
</script>

{#key url}
	<T.Mesh {scale} rotation.z={landscape ? -Math.PI / 2 : 0}>
		<T.PlaneGeometry args={cardSize} />
		<ImageMaterial {url} side={0} radius={0.3} opacity={1} />
	</T.Mesh>
{/key}
