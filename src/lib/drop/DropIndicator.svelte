<script lang="ts">
	import { T } from '@threlte/core';
	import { ImageMaterial } from '@threlte/extras';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { tableFeatures } from '$lib/store/tableFeatures';
	import { previewDrop } from './preview';
	import { SNAP_DROP_COLOR } from '$lib/utils/constants-snap';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { currentPieceState } from '$lib/compose/piece';
	import { tokenShape } from '$lib/primitives/token-shape';
	import { imageAspect, imageAspects } from '$lib/utils/image-aspect';
	import DropFootprint from './DropFootprint.svelte';
	import SnapGuides from './SnapGuides.svelte';

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
	const COLORS = { table: '#5ee7ff', stack: '#ffc94a', snap: SNAP_DROP_COLOR } as const;

	const dragId = $derived($dragStore.isDragging);

	// live: pressing or releasing Alt mid-drag redraws the preview. Same
	// resolution the commit makes — a group drag previews its lead as the
	// group commit lands it (see drop/preview.ts).
	//
	// A square token lands as the rectangle its art makes it (tableplace-254),
	// which only the loaded image knows — so the aspect is read here, where the
	// image is, and handed to the resolution.
	const piece = $derived(dragId?.startsWith('piece:') ? $gameStore?.pieces?.[dragId] : undefined);
	const faceAspect = $derived.by(() => {
		if (!piece || tokenShape(piece) !== 'square') return 1;
		const states = piece.states ?? [];
		const face = states.length ? states[currentPieceState(piece)]?.face : piece.imageUrl;
		return imageAspect(resolveCardImage(face, $sheetRefCache), $imageAspects);
	});
	const drop = $derived(previewDrop($gameStore, $dragStore, $tableFeatures.hand, faceAspect));

	// the deck / bag / tray highlights are the cue for those targets — a table
	// footprint there would promise a landing that isn't going to happen
	const visible = $derived(
		drop?.kind === 'table' || drop?.kind === 'stack' || drop?.kind === 'snap'
	);

	/**
	 * A caught snap point shows twice over: the footprint jumps onto the point,
	 * in its own colour, already turned to the authored yaw — and `SnapGuides`
	 * (fed this same `drop`) fills the point or grid cell that caught it among
	 * the rings of every other point the entity could land on.
	 */

	// primitives, not the resolved objects: all of this recomputes on every
	// pointer move, and threlte rebuilds a geometry whenever its `args` array
	// changes identity. Equal numbers in, no churn.
	const shape = $derived(drop?.footprint.shape ?? 'rect');
	const w = $derived(drop?.footprint.shape === 'rect' ? drop.footprint.w : 0);
	const h = $derived(drop?.footprint.shape === 'rect' ? drop.footprint.h : 0);
	const r = $derived(drop?.footprint.shape === 'circle' ? drop.footprint.r : 0);
	const color = $derived(
		drop?.kind === 'snap' ? COLORS.snap : drop?.kind === 'stack' ? COLORS.stack : COLORS.table
	);
	const posX = $derived(drop?.position[0] ?? 0);
	const posZ = $derived(drop?.position[2] ?? 0);
	const surfaceY = $derived((drop?.footprintY ?? 0) + SURFACE_CLEARANCE);
	// Card.svelte yaws the card by -rotation[2]; match it so a tapped card
	// previews sideways instead of upright. A piece keeps its yaw in rotation[1]
	// (Piece.svelte draws -rotation[1]) — it never mattered while every piece
	// landed as a circle, and a square token's rectangle has to turn with it.
	const yaw = $derived(-(drop?.rotation[piece ? 1 : 2] ?? 0) * DEG2RAD);

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

<!-- outside the `visible` gate: over a deck or the tray the rings stay up,
     only the fill (which follows drop.snap) goes -->
<SnapGuides {drop} />

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
