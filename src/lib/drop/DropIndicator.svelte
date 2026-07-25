<script lang="ts">
	import { T } from '@threlte/core';
	import { ImageMaterial } from '@threlte/extras';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { tableFeatures } from '$lib/store/tableFeatures';
	import { resolveDrop } from '$lib/utils/transforms/drop';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import DropFootprint from './DropFootprint.svelte';

	/**
	 * Resolved drop preview: draws the landing the release will actually
	 * commit — edge clamp, stack height, tap rotation, facedown art — plus a
	 * vertical connector from the floating entity down to it.
	 *
	 * The connector is what makes a drop readable at a low camera angle: the
	 * dragged entity floats ~2 units above the felt, which at a shallow orbit
	 * projects it far up-screen from the spot it will occupy.
	 */

	// clear of the table Grid (0.255) and the map overlay plane (0.258)
	const SURFACE_CLEARANCE = 0.0025;
	const COLORS = { table: '#5ee7ff', stack: '#ffc94a' } as const;

	const dragId = $derived($dragStore.isDragging);

	const drop = $derived(
		resolveDrop(
			$gameStore,
			dragId,
			$dragStore.intersectionPoint,
			{ deckId: $dragStore.isDeckHovered, tray: $dragStore.isTrayHovered },
			// live: pressing or releasing Alt mid-drag redraws the preview. Same
			// options the commit resolves with, so the preview stays honest.
			{ noSnap: $dragStore.noSnap, hand: $tableFeatures.hand }
		)
	);

	// the deck / tray highlights are the cue for those targets — a table
	// footprint there would promise a landing that isn't going to happen
	const visible = $derived(drop?.kind === 'table' || drop?.kind === 'stack');

	// primitives, not the resolved objects: all of this recomputes on every
	// pointer move, and threlte rebuilds a geometry whenever its `args` array
	// changes identity. Equal numbers in, no churn.
	const shape = $derived(drop?.footprint.shape ?? 'rect');
	const w = $derived(drop?.footprint.shape === 'rect' ? drop.footprint.w : 0);
	const h = $derived(drop?.footprint.shape === 'rect' ? drop.footprint.h : 0);
	const r = $derived(drop?.footprint.shape === 'circle' ? drop.footprint.r : 0);
	const color = $derived(drop?.kind === 'stack' ? COLORS.stack : COLORS.table);
	const posX = $derived(drop?.position[0] ?? 0);
	const posZ = $derived(drop?.position[2] ?? 0);
	const surfaceY = $derived((drop?.footprintY ?? 0) + SURFACE_CLEARANCE);
	// Card.svelte yaws the card by -rotation[2]; match it so a tapped card
	// previews sideways instead of upright
	const yaw = $derived(-(drop?.rotation[2] ?? 0) * DEG2RAD);

	const card = $derived(
		dragId && !dragId.startsWith('piece:') ? $gameStore?.cards?.[dragId] : undefined
	);
	// 180 on x is the facedown convention (see Card.svelte). Both faces land in
	// the same world orientation once the card is flipped, so the ghost only
	// has to swap which image it draws.
	const isFacedown = $derived((card?.rotation?.[0] ?? 0) === 180);
	const ghostImage = $derived(
		resolveCardImage(
			(isFacedown ? (card?.backImageUrl ?? card?.faceImageUrl) : card?.faceImageUrl) ?? '',
			$sheetRefCache
		)
	);

	// height the dragged entity is floating at, for the connector's top end
	const liftY = $derived(
		(dragId
			? ($gameStore?.pieces?.[dragId] ?? $gameStore?.cards?.[dragId] ?? $gameStore?.decks?.[dragId])
			: undefined
		)?.position?.[1] ?? 0
	);
	const connector = $derived(liftY - surfaceY);
</script>

{#if visible}
	<T.Group position={[posX, surfaceY, posZ]}>
		<T.Group rotation.y={yaw}>
			<T.Group rotation.x={-Math.PI / 2}>
				<DropFootprint {shape} {w} {h} {r} {color} />
				{#if shape === 'rect' && ghostImage}
					{#key ghostImage}
						<T.Mesh position.z={0.001}>
							<T.PlaneGeometry args={[w, h]} />
							<ImageMaterial
								url={ghostImage}
								side={0}
								radius={0.1}
								transparent
								opacity={0.35}
								depthWrite={false}
							/>
						</T.Mesh>
					{/key}
				{/if}
			</T.Group>
		</T.Group>
	</T.Group>

	{#if connector > 0.1}
		<!-- unit-height cylinder scaled to length, so a changing stack height
		     doesn't churn geometry. depthTest off so the line stays readable
		     through decks, stacks and map overlays. -->
		<T.Mesh position={[posX, surfaceY + connector / 2, posZ]} scale.y={connector}>
			<T.CylinderGeometry args={[0.02, 0.02, 1, 8]} />
			<T.MeshBasicMaterial
				{color}
				transparent
				opacity={0.65}
				depthTest={false}
				depthWrite={false}
			/>
		</T.Mesh>
	{/if}
{/if}
