<script lang="ts">
	import * as THREE from 'three';
	import { untrack } from 'svelte';
	import { T } from '@threlte/core';
	import { DIAL_TEXTURE_PX, dialKey, drawCounterDial } from '$lib/primitives/counter-dial';

	/**
	 * A counter's printed face (tableplace-191): name, value, `of max` and the
	 * rim arc, on one canvas texture laid over the top of the disc. It replaces
	 * the floating pill, so the counter reads from the seat without hovering.
	 *
	 * The canvas is drawn only when what it shows changes (`dialKey`) — never per
	 * frame. `userData.dial` carries the drawn state and a redraw count so the
	 * headless harness can see what is printed without reading pixels.
	 */
	let {
		name,
		value,
		maxValue,
		overImage = false,
		radius,
		y,
		facing = 0,
		scale = 1
	}: {
		name: string;
		value: number;
		maxValue?: number;
		/** an image face sits under the dial: draw a scrim instead of a plate */
		overImage?: boolean;
		radius: number;
		/** height of the face above the piece origin */
		y: number;
		/** yaw (radians, in the piece's frame) the text's baseline faces */
		facing?: number;
		/** the value-change pulse */
		scale?: number;
	} = $props();

	const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
	const context = canvas?.getContext('2d') ?? null;
	if (canvas) canvas.width = canvas.height = DIAL_TEXTURE_PX;
	const texture = canvas ? new THREE.CanvasTexture(canvas) : null;
	if (texture) {
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 4;
	}

	// mutated in place, never reassigned: Threlte hands the object to the mesh
	// once, and the harness reads it back off the scene graph
	const info = { name: '', value: 0, maxValue: null as number | null, redraws: 0 };

	const face = $derived({ name, value, maxValue, overImage });
	const key = $derived(dialKey(face));

	$effect(() => {
		void key; // the one dependency: redraw when what is printed changes
		if (!context || !texture) return;
		const printed = untrack(() => face);
		drawCounterDial(context, DIAL_TEXTURE_PX, printed);
		texture.needsUpdate = true;
		info.name = printed.name;
		info.value = printed.value;
		info.maxValue = printed.maxValue ?? null;
		info.redraws++;
	});

	$effect(() => () => texture?.dispose());
</script>

{#if texture}
	<T.Group position.y={y} rotation.y={facing} scale.x={scale} scale.z={scale}>
		<T.Mesh rotation.x={-Math.PI / 2} userData={{ dial: info }}>
			<T.CircleGeometry args={[radius, 48]} />
			<T.MeshBasicMaterial map={texture} transparent toneMapped={false} />
		</T.Mesh>
	</T.Group>
{/if}
