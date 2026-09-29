<script lang="ts">
	import { T } from '@threlte/core';
	import * as THREE from 'three';
	import { ImageMaterial } from '@threlte/extras';
	import { Spring } from 'svelte/motion';
	import { degrees } from '$lib/utils/constants-rotation';
	import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { resolveCardImage, sheetRefCache, CARD_BACK_DEFAULT } from '$lib/packs';
	import { dragStart, dragStore } from '$lib/store/dragStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { hoveredTrayCard } from './trayHover';

	// No interactivity() here on purpose — one call per card in hand meant one
	// Raycaster and one full set of DOM listeners per card. The handlers below
	// register into HUDTrayScene's context, which is the one that owns the tray's
	// orthographic camera.
	let {
		id,
		offsetX = 0,
		trayWidth = 0
	}: { id: string; offsetX: number; trayWidth?: number } = $props();

	const myPlayerId = $derived(gameActions?.getMe()?.id ?? '');
	const card = $derived($gameStore?.players?.[myPlayerId]?.tray?.[id] ?? {});
	const trayUrl = $derived(resolveCardImage(card.faceImageUrl, $sheetRefCache));
	// landscape cards lie on their side in the hand; the geometry stays portrait
	// (the art is portrait in the texture) and the mesh rotates
	const isLandscape = $derived(card.orientation === 'landscape');

	const isCardHovered = $derived($hoveredTrayCard === id);
	let emissiveIntensity = $state(0);

	$effect(() => {
		emissiveIntensity = isCardHovered ? 0.05 : 0;
	});

	// expansion follows the shared hover owner, not raw enter/leave events
	$effect(() => {
		if (isCardHovered) {
			cardScale.target = 1.5;
			cardY.target = 1.5;
			cardZ = 1;
		} else {
			cardScale.target = 0.55;
			cardY.target = 0;
			cardZ = 0;
		}
	});

	const cardSize = [1.4 * 1.4, 2 * 1.4];
	let cardZ = $state(0); // z-index
	const cardY = new Spring(0, {
		stiffness: 0.15,
		damping: 0.7,
		precision: 0.0001
	});
	const cardScale = new Spring(0.55, {
		stiffness: 0.15,
		damping: 0.7,
		precision: 0.0001
	});

	function handlePointerEnter() {
		hoveredTrayCard.set(id);
	}
	function handlePointerLeave() {
		// guard: a stale leave (fired after a neighbor claimed hover) must not
		// clear the neighbor's expansion
		hoveredTrayCard.update((current) => (current === id ? null : current));
	}
	function handleDragStart() {
		const { x = 0, z = 0 } = $dragStore.intersectionPoint as THREE.Vector3;

		const movedCard = gameActions.moveCardOutOfTray(id, myPlayerId);
		gameStore?.updateState({
			cards: {
				[id]: {
					...movedCard,
					position: [x, CARD_DRAG_Y, z],
					// 180 on x = facedown (matches flipCard convention) — cards leave the hand hidden
					rotation: [180, 0, -degrees[gameActions?.getMySeat()] / DEG2RAD],
					faceImageUrl: movedCard?.faceImageUrl ?? card?.faceImageUrl,
					backImageUrl: movedCard?.backImageUrl ?? card.backImageUrl ?? CARD_BACK_DEFAULT // TODO: update this with its actual cardback
				}
			}
		});
		dragStart(id, CARD_DRAG_Y);
	}
</script>

{#key trayUrl}
	<T.Mesh
		name={id}
		scale={cardScale.current}
		position.z={cardZ}
		position.y={cardY.current}
		position.x={-trayWidth / 2 + 0.65 + offsetX}
		rotation.z={isLandscape ? -Math.PI / 2 : 0}
		onpointerenter={handlePointerEnter}
		onpointerleave={handlePointerLeave}
		onpointerdown={handleDragStart}
	>
		<T.PlaneGeometry args={cardSize} />
		<ImageMaterial url={trayUrl} side={2} radius={0.1} transparent={true} opacity={0.9} />
	</T.Mesh>
{/key}
