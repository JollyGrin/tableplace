<script lang="ts">
	import { untrack } from 'svelte';
	import { T, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { ImageMaterial } from '@threlte/extras';
	import { Spring, Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { HAND_CARD_H, HAND_CARD_W, type FanSlot } from '$lib/utils/hand';
	import { FLIGHT_MS, getTableCamera, prefersReducedMotion, takeFlight } from './drawFlight';

	/**
	 * One card of the fan. Where it sits, how big and how tilted is decided by
	 * HUDTrayScene (`pose`: its slot, raised when hovered, under the pointer
	 * when held) — this only springs toward it and draws the face. Pointer
	 * handling lives in the scene too: the cards overlap, so which one the
	 * pointer is on is worked out from the layout, not from a raycast here.
	 */
	let {
		id,
		pose,
		landscape = false
	}: {
		id: string;
		pose: FanSlot & { scale: number; z: number };
		landscape?: boolean;
	} = $props();

	const myPlayerId = $derived(gameActions?.getMe()?.id ?? '');
	const card = $derived($gameStore?.players?.[myPlayerId]?.tray?.[id] ?? {});
	const trayUrl = $derived(resolveCardImage(card.faceImageUrl, $sheetRefCache));

	const SPRING = { stiffness: 0.15, damping: 0.7, precision: 0.0001 };
	// the first pose is where the card starts: no swoop in from the origin
	const cardX = new Spring(
		untrack(() => pose.x),
		SPRING
	);
	const cardY = new Spring(
		untrack(() => pose.y),
		SPRING
	);
	const cardAngle = new Spring(
		untrack(() => pose.angle),
		SPRING
	);
	const cardScale = new Spring(
		untrack(() => pose.scale),
		SPRING
	);

	// writes only the springs' targets, which nothing here reads back
	$effect(() => {
		cardX.target = pose.x;
		cardY.target = pose.y;
		cardAngle.target = pose.angle;
		cardScale.target = pose.scale;
	});

	// the art is portrait in the texture: a landscape card's mesh lies on its side
	const cardSize: [number, number] = [HAND_CARD_W, HAND_CARD_H];

	/**
	 * Deck → hand (tableplace-194): a card drawn into the hand starts over the
	 * deck it left, and glides to its slot. `flight` is the offset from the
	 * slot (and a scale factor), so it is zero/one at rest and the pose
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
</script>

{#key trayUrl}
	<T.Mesh
		bind:ref={mesh}
		name={id}
		scale={cardScale.current * flight.current.s}
		position.z={pose.z + (flying ? 2 : 0)}
		position.y={cardY.current + flight.current.y}
		position.x={cardX.current + flight.current.x}
		rotation.z={cardAngle.current + (landscape ? -Math.PI / 2 : 0)}
	>
		<T.PlaneGeometry args={cardSize} />
		<ImageMaterial url={trayUrl} side={2} radius={0.1} transparent={true} />
	</T.Mesh>
{/key}
