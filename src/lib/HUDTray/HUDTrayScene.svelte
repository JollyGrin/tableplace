<script lang="ts">
	import { onMount } from 'svelte';
	import { T, useThrelte } from '@threlte/core';
	import { dragStore, setTrayHover } from '$lib/store/dragStore.svelte';
	import * as THREE from 'three';
	import { useViewport, interactivity } from '@threlte/extras';
	import TrayCard from './TrayCard.svelte';
	import DropFootprint from '$lib/drop/DropFootprint.svelte';
	import type { GameDTO } from '$lib/store/game/types';
	import { gameActions } from '$lib/store/game/actions';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { registerHud } from '$lib/dev/hud-registry';

	/**
	 * The one interactivity() the HUD keeps, and the only one besides
	 * TableScene's (see #86). `<HUD>` calls createCameraContext(), so
	 * `useThrelte().camera` inside it resolves to the OrthographicCamera below,
	 * not the table camera — and a Raycaster is set from exactly one camera. The
	 * tray's meshes sit in that ortho camera's space, so a ray cast from the
	 * table's perspective camera would never hit them. Hence a second context,
	 * whose default compute picks up this camera.
	 *
	 * `<HUD>` does not create a DOM context, so `useDOM().dom` — interactivity's
	 * listener target — is still the shared canvas element. Only the camera is
	 * re-rooted, which is why this needs to be per HUD root and never per card:
	 * TrayCard registers into this context.
	 */
	interactivity();
	let {}: {} = $props();

	// the e2e harness hovers hand cards, so it needs this HUD's camera to aim
	if (import.meta.env.DEV) {
		const { camera, scene } = useThrelte();
		onMount(() => registerHud('tray', { camera: () => camera.current, scene: () => scene }));
	}

	const viewport = useViewport();

	const trayWidth = $derived($viewport.width / 1);
	const trayHeight = $derived($viewport.height / 6); // Adjust height as needed
	const trayX = $derived(-$viewport.width / 2 + trayWidth / 2);
	const trayY = $derived(-$viewport.height / 2 + trayHeight / 2);

	let trayMesh: THREE.Mesh | undefined = $state(undefined);

	const isDropTarget = $derived($dragStore.isTrayHovered && !!$dragStore.isDragging);

	const myPlayerId = $derived(gameActions?.getMe()?.id ?? '');
	const cards = $derived(
		Object.entries($gameStore?.players?.[myPlayerId]?.tray ?? {}) as [
			string,
			GameDTO['cards'][string]
		][]
	);

	// Per-card slot widths, not a fixed pitch: a landscape card lies on its side
	// and is wider than the 1.2 units a portrait slot spans, so its neighbors
	// step round it instead of underneath it. Portrait slots keep the historical
	// 1.2 pitch exactly.
	const SLOT_PORTRAIT = 1.2;
	const SLOT_LANDSCAPE = 1.7;
	const offsets = $derived.by(() => {
		let x = 0;
		return cards.map(([, card]) => {
			const width = card?.orientation === 'landscape' ? SLOT_LANDSCAPE : SLOT_PORTRAIT;
			const centre = x + width / 2;
			x += width;
			return centre;
		});
	});
</script>

<T.OrthographicCamera makeDefault zoom={80} position={[0, 0, 10]} />
<T.AmbientLight intensity={Math.PI / 2} />
<T.PointLight position={[10, 10, 10]} decay={0} intensity={Math.PI * 2} />

<T.Group position={[trayX, trayY, 0] as [number, number, number]}>
	<T.Mesh
		bind:ref={trayMesh}
		onpointerenter={() => setTrayHover(true)}
		onpointerleave={() => setTrayHover(false)}
	>
		<T.PlaneGeometry args={[trayWidth, trayHeight]} />
		<T.MeshBasicMaterial
			color="white"
			transparent
			opacity={$dragStore.isTrayHovered ? 0.3 : 0.1}
			side={2}
		/>
	</T.Mesh>

	{#if isDropTarget}
		<!-- the tray is the whole cue while it's hovered: the drop indicator
		     drops its table footprint, since the card is going to the hand -->
		<T.Group position.z={0.01}>
			<DropFootprint
				shape="rect"
				w={trayWidth - 0.12}
				h={trayHeight - 0.12}
				color="#5ee7ff"
				fill={0.1}
				border={0.08}
			/>
		</T.Group>
	{/if}

	{#each cards as [id], index (id)}
		<TrayCard {id} offsetX={offsets[index]} {trayWidth} />
	{/each}
</T.Group>
