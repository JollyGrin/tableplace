<script lang="ts">
	import { untrack } from 'svelte';
	import { T, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { ImageMaterial } from '@threlte/extras';
	import { Spring, Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { degrees } from '$lib/utils/constants-rotation';
	import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { resolveCardImage, sheetRefCache, CARD_BACK_DEFAULT } from '$lib/packs';
	import { dragStart, dragStore } from '$lib/store/dragStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { hoveredTrayCard } from './trayHover';
	import { FLIGHT_MS, getTableCamera, prefersReducedMotion, takeFlight } from './drawFlight';

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

	/**
	 * Deck → hand (tableplace-194): a card drawn into the hand starts over the
	 * deck it left, and glides to its slot. `flight` is the offset from the
	 * slot (and a scale factor), so it is zero/one at rest and the hover
	 * springs above keep working untouched. The deck's table point goes through
	 * the table camera to the screen, and back out through this HUD's own
	 * orthographic camera into the tray group's space.
	 */
	const { camera: hudCamera } = useThrelte();
	const flight = new Tween({ x: 0, y: 0, s: 1 }, { duration: FLIGHT_MS, easing: cubicOut });
	let flying = $state(false);
	let mesh: THREE.Mesh | undefined = $state();

	// Launched from an effect, not onMount: threlte binds `mesh` after this
	// component's own mount, and the drawer queues the flight just after the
	// patch that mounts us. By the first effect flush both are in place. Reads
	// only `mesh`; everything it writes is untracked, and it runs once.
	let launched = false;
	$effect(() => {
		const target = mesh;
		if (!target || launched) return;
		launched = true;
		untrack(() => launchFlight(target));
	});

	function launchFlight(mesh: THREE.Mesh, tries = 3) {
		// threlte may attach the mesh to the tray group a frame after binding it
		if (!mesh.parent) {
			if (tries > 0) requestAnimationFrame(() => launchFlight(mesh, tries - 1));
			return;
		}
		const launch = takeFlight(id);
		const tableCamera = getTableCamera();
		const parent = mesh.parent;
		if (!launch || !tableCamera || prefersReducedMotion()) return;
		const ndc = new THREE.Vector3(...launch.from).project(tableCamera);
		// behind the table camera: no honest screen point to fly from
		if (ndc.z > 1) return;
		parent.updateWorldMatrix(true, false);
		const from = parent.worldToLocal(
			new THREE.Vector3(ndc.x, ndc.y, 0).unproject(hudCamera.current)
		);
		flying = true;
		flight.set(
			{ x: from.x - mesh.position.x, y: from.y - mesh.position.y, s: 0.8 },
			{ duration: 0 }
		);
		flight.set({ x: 0, y: 0, s: 1 }, { delay: launch.delayMs }).then(() => (flying = false));
	}

	function handlePointerEnter() {
		// a card still in the air isn't in the hand yet: sweeping over its path
		// must not blow it up to the hover size mid-flight
		if (flying) return;
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
		bind:ref={mesh}
		name={id}
		scale={cardScale.current * flight.current.s}
		position.z={cardZ + (flying ? 2 : 0)}
		position.y={cardY.current + flight.current.y}
		position.x={-trayWidth / 2 + 0.65 + offsetX + flight.current.x}
		rotation.z={isLandscape ? -Math.PI / 2 : 0}
		onpointerenter={handlePointerEnter}
		onpointerleave={handlePointerLeave}
		onpointerdown={handleDragStart}
	>
		<T.PlaneGeometry args={cardSize} />
		<ImageMaterial url={trayUrl} side={2} radius={0.1} transparent={true} opacity={0.9} />
	</T.Mesh>
{/key}
