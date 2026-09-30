<!--
	Other players' pointers on the felt (tableplace-197): a cursor in their seat
	colour with their name beside it, its tip on the table point under their
	mouse.

	The point arrives on the camera stream (≤ ~3 Hz, see websocket/cameraStream),
	so each cursor glides toward its newest sample rather than jumping between
	packets. It fades once that player's pointer has sat still for
	POINTER_IDLE_MS, and is gone the moment a sample says their pointer left the
	canvas or the felt.

	Render-only and imperative, like PingRipples: one task moves, sizes and fades
	every cursor, and writes no $state per frame. It runs only while some cursor
	is still showing. Nothing here raycasts — a cursor must never eat a grab.
-->
<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core';
	import { Billboard, Text } from '@threlte/extras';
	import * as THREE from 'three';
	import {
		POINTER_FADE_MS,
		POINTER_IDLE_MS,
		pointerOpacity,
		remoteCameraNow,
		remoteCameraStore
	} from '$lib/store/remoteCameraStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { playerColor } from '$lib/hud/players';
	import { TABLE_TOP_Y } from '$lib/utils/constants-table';
	import { remotePointersEnabled } from './settings';

	const { camera, invalidate } = useThrelte();

	/** just clear of the felt; depthTest is off, so this only orders the sort */
	const LIFT = 0.03;
	/**
	 * Cursor scale per world unit of camera distance, so it keeps one on-screen
	 * size at any zoom: ~22px tall and a ~13px name at an 800px-high view
	 * (CAMERA_FOV_DEG 35 → the view spans 0.63 × distance).
	 */
	const SCALE_PER_DISTANCE = 0.026;
	/** glide time constant — about a third of the 350ms sample interval */
	const GLIDE_MS = 110;

	// The cursor outline from the interaction mockup (a 16×20 SVG path, y down),
	// tip moved to the origin and flipped to y up.
	const ARROW: [number, number][] = [
		[1, 1],
		[14, 11],
		[8, 12],
		[12, 19],
		[9, 20],
		[6, 13],
		[1, 17]
	];
	const ARROW_UNIT = 0.035;
	const arrowPoints = ARROW.map(
		([x, y]) => new THREE.Vector2((x - 1) * ARROW_UNIT, -(y - 1) * ARROW_UNIT)
	);
	const arrowGeometry = new THREE.ShapeGeometry(new THREE.Shape(arrowPoints));
	const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
		arrowPoints.map((p) => new THREE.Vector3(p.x, p.y, 0.001))
	);
	$effect(() => () => {
		arrowGeometry.dispose();
		outlineGeometry.dispose();
	});

	/** the name hangs off the arrow's lower right, clear of its tail */
	const LABEL_AT: [number, number, number] = [9 * ARROW_UNIT, -15 * ARROW_UNIT, 0];
	const LABEL_SIZE = 0.4;

	const noRaycast = () => null;

	const myId = gameActions?.getMyId() ?? '';

	const pointers = $derived(
		$remotePointersEnabled
			? Object.keys($remoteCameraStore)
					.filter((id) => id !== myId && id !== gameActions?.getMyId())
					.map((id) => ({ id, color: playerColor(id, $gameStore?.players?.[id]?.seat) }))
			: []
	);

	// Some cursor still showing, on the 500ms presence clock: a pointer that
	// idled out (or left) stops the task within half a second, and the next
	// sample that moves it starts it again.
	const showing = $derived(
		pointers.some(({ id }) => {
			const cam = $remoteCameraStore[id];
			return !!cam?.c && $remoteCameraNow - cam.pointerAt < POINTER_IDLE_MS + POINTER_FADE_MS;
		})
	);

	/** what each cursor draws with, filled as they mount */
	const groups = new Map<string, THREE.Group>();
	/** where each cursor is drawn right now — the glide's state, never reactive */
	const drawn = new Map<string, { x: number; z: number }>();

	function setOpacity(group: THREE.Group, opacity: number) {
		group.userData.opacity = opacity;
		group.traverse((object) => {
			const text = object as THREE.Object3D & { fillOpacity?: number; outlineOpacity?: number };
			if ('fillOpacity' in text) {
				text.fillOpacity = opacity;
				text.outlineOpacity = opacity;
				return;
			}
			const material = (object as THREE.Mesh).material as THREE.Material | undefined;
			if (material && !Array.isArray(material)) material.opacity = opacity * 0.95;
		});
	}

	function hide(id: string, group: THREE.Group) {
		group.visible = false;
		group.userData.target = null;
		group.userData.opacity = 0;
		// the next appearance lands where it is, not a glide from here
		drawn.delete(id);
	}

	let lastFrame = 0;

	function draw() {
		const now = Date.now();
		const frame = performance.now();
		const step = lastFrame ? 1 - Math.exp(-(frame - lastFrame) / GLIDE_MS) : 1;
		lastFrame = frame;
		const cams = $remoteCameraStore;
		for (const [id, group] of groups) {
			const cam = cams[id];
			const opacity = cam?.c ? pointerOpacity(now - cam.pointerAt) : 0;
			if (!cam?.c || opacity <= 0) {
				hide(id, group);
				continue;
			}
			const [tx, tz] = cam.c;
			let at = drawn.get(id);
			if (!at) drawn.set(id, (at = { x: tx, z: tz }));
			else {
				at.x += (tx - at.x) * step;
				at.z += (tz - at.z) * step;
			}
			group.position.set(at.x, TABLE_TOP_Y + LIFT, at.z);
			group.scale.setScalar(
				camera.current.position.distanceTo(group.position) * SCALE_PER_DISTANCE
			);
			group.userData.target = [tx, tz];
			group.visible = true;
			setOpacity(group, opacity);
		}
	}

	useTask(draw, { running: () => showing });

	// stopped: hide whatever the last frame left up (a pointer that left the
	// canvas), since no frame will run to do it
	$effect(() => {
		if (showing) return;
		lastFrame = 0;
		for (const [id, group] of groups) hide(id, group);
		invalidate();
	});

	// forget the cursors of players who went away
	$effect(() => {
		const live = new Set(pointers.map((p) => p.id));
		for (const id of groups.keys()) if (!live.has(id)) groups.delete(id);
		for (const id of drawn.keys()) if (!live.has(id)) drawn.delete(id);
	});
</script>

{#each pointers as { id, color } (id)}
	<T.Group
		oncreate={(group) => {
			// set once here, not as a prop: `pointers` rebuilds on every sample,
			// and a userData prop would be reassigned — wiping what draw() keeps
			// on it — each time
			group.userData.remotePointer = id;
			group.visible = false;
			groups.set(id, group);
		}}
	>
		<Billboard>
			<T.Mesh geometry={arrowGeometry} renderOrder={20} raycast={noRaycast}>
				<T.MeshBasicMaterial
					{color}
					transparent
					depthTest={false}
					depthWrite={false}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<T.LineLoop geometry={outlineGeometry} renderOrder={21} raycast={noRaycast}>
				<T.LineBasicMaterial color="#16130f" transparent depthTest={false} depthWrite={false} />
			</T.LineLoop>
			<Text
				text={id}
				fontSize={LABEL_SIZE}
				position={LABEL_AT}
				anchorX="left"
				anchorY="top"
				{color}
				outlineWidth={LABEL_SIZE * 0.08}
				outlineColor="#16130f"
				raycast={noRaycast}
				renderOrder={22}
				depthOffset={-1}
				material.depthTest={false}
				material.depthWrite={false}
			/>
		</Billboard>
	</T.Group>
{/each}
