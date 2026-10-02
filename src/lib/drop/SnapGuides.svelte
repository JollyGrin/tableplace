<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { onDestroy } from 'svelte';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { clampToTable, entitySnaps, type DropTarget } from '$lib/utils/transforms/drop';
	import {
		SNAP_DROP_COLOR,
		SNAP_GUIDE_CELL_INSET,
		SNAP_GUIDE_DIM_OPACITY,
		SNAP_GUIDE_FADE_S,
		SNAP_GUIDE_FILL_OPACITY,
		SNAP_GUIDE_LAYER,
		SNAP_GUIDE_LIFT,
		SNAP_GUIDE_OUT_OF_REACH_OPACITY,
		SNAP_GUIDE_REACH_COLOR,
		SNAP_GUIDE_REACH_OPACITY,
		SNAP_GUIDE_REACH_SCALE,
		SNAP_GUIDE_RING_OPACITY
	} from '$lib/utils/constants-snap';
	import {
		forEachSnapGuide,
		hasSnapPoints,
		poolSize,
		snapFloorY,
		snapGuideCapacity,
		type SnapGuideVisit
	} from './snap-guides';
	import { snapGuideDimMaterial } from './snap-guide-dim';
	import { liftReachSet } from './snap-reach';

	/**
	 * Lift-time snap guides (tableplace-188): while an entity that snaps is in
	 * the air, every snap point it could land on shows a ring, the point that will
	 * catch the drop is marked (a disc, or a square frame for a grid cell), and
	 * a grid draws no field of empty cells — pale squares read as blank cards
	 * (tableplace-269). Also
	 * the overlays under the points dim (see `OverlayCustom`). Alt — the no-snap
	 * modifier — and a piece authored `snap: false` turn it all off.
	 *
	 * `drop` is the resolution `DropIndicator` already computed for this frame,
	 * passed straight through: the filled target IS `drop.snap`, so it follows
	 * the resolver's whole precedence (bag, tray, deck, Alt, snap, pile) and
	 * can never light a point the release won't land on.
	 *
	 * Cost model, for scenarios with dozens of points:
	 * - two InstancedMeshes (rings, cells) sized once per scenario to a
	 *   power-of-two pool, so every guide is one draw call per kind;
	 * - the layout reruns only when the drag's inputs change (a pointer move),
	 *   writing matrices through one reused Object3D — no allocation;
	 * - the fade is a frame task that runs only while an opacity is actually
	 *   moving, and writes three.js materials, never Svelte state.
	 *
	 * Reach rings (tableplace-190): a piece with `reach` lifted off a linked
	 * point draws the points within reach from a third instanced mesh, brighter,
	 * and fades every other ring back. Advisory only — every ring still catches.
	 *
	 * Everything draws on `SNAP_GUIDE_LAYER`: the main camera sees it, the
	 * contact-shadow pass and every raycaster do not.
	 */

	let { drop }: { drop: DropTarget | null } = $props();

	const { camera, invalidate } = useThrelte();

	const dragId = $derived($dragStore.isDragging);
	const snapPoints = $derived($gameStore?.snapPoints);
	const active = $derived(
		!!dragId && !$dragStore.noSnap && hasSnapPoints(snapPoints) && entitySnaps($gameStore, dragId)
	);

	// primitives, so a drag's per-move store updates don't rebuild the pools
	const capacity = $derived(snapGuideCapacity(snapPoints));
	const pointPool = $derived(poolSize(capacity.points));
	const cellPool = 1; // the cell field is retired (tableplace-269); the mesh stays for the harness

	/**
	 * The points within the lifted piece's reach, or null for the ordinary
	 * guides. Computed from the lift's origin, not the pointer — the reach is
	 * where the piece came from, wherever it is being carried.
	 */
	const reachSet = $derived(active ? liftReachSet($gameStore, dragId, $dragStore.origin) : null);

	const ringGeometry = new THREE.RingGeometry(0.86, 1, 48);
	// a 4-segment ring is a diamond; turned 45° it is a square frame
	const cellGeometry = new THREE.RingGeometry(0.86, 1, 4);
	const discGeometry = new THREE.CircleGeometry(1, 48);
	const outline = () =>
		new THREE.MeshBasicMaterial({
			color: SNAP_DROP_COLOR,
			transparent: true,
			opacity: 0,
			depthWrite: false,
			side: THREE.DoubleSide,
			visible: false
		});
	const ringMaterial = outline();
	const fillMaterial = outline();
	const reachMaterial = outline();
	reachMaterial.color.set(SNAP_GUIDE_REACH_COLOR);
	/** whether the last layout had a reach set — the fade targets follow it */
	let reaching = false;

	let rings: THREE.InstancedMesh | undefined = $state();
	let reachRings: THREE.InstancedMesh | undefined = $state();
	let cells: THREE.InstancedMesh | undefined = $state();
	let targetDisc: THREE.Mesh | undefined = $state();
	let targetSquare: THREE.Mesh | undefined = $state();

	const onLayer = (object: THREE.Object3D) => {
		object.layers.set(SNAP_GUIDE_LAYER);
		object.frustumCulled = false; // an instanced mesh's bounds are its geometry's
	};

	$effect(() => {
		$camera.layers.enable(SNAP_GUIDE_LAYER);
	});

	// ---- layout: one matrix per guide, written through reused scratch ----

	const scratch = new THREE.Object3D();
	const pointer = { x: 0, z: 0 };
	let ringCount = 0;
	let reachCount = 0;
	let bright: Set<string> | null = null;
	let cellCount = 0;
	const SQRT2 = Math.SQRT2;

	const place = (x: number, y: number, z: number, scale: number, spin: number) => {
		scratch.position.set(x, y + SNAP_GUIDE_LIFT, z);
		// Euler XYZ: spin in the plane first, then lay it flat — the marker
		// convention (-yaw about the view axis matches a card's table yaw)
		scratch.rotation.set(-Math.PI / 2, 0, spin);
		scratch.scale.set(scale, scale, 1);
		scratch.updateMatrix();
	};

	const visit: SnapGuideVisit = (kind, x, y, z, size, yaw, id) => {
		if (kind === 'point' && bright?.has(id)) {
			if (!reachRings || reachCount >= pointPool) return;
			place(x, y, z, size * SNAP_GUIDE_REACH_SCALE, 0);
			reachRings.setMatrixAt(reachCount++, scratch.matrix);
		} else if (kind === 'point') {
			if (!rings || ringCount >= pointPool) return;
			place(x, y, z, size, 0);
			rings.setMatrixAt(ringCount++, scratch.matrix);
		} else {
			if (!cells || cellCount >= cellPool) return;
			place(x, y, z, (size / 2) * SNAP_GUIDE_CELL_INSET * SQRT2, -yaw * DEG2RAD + Math.PI / 4);
			cells.setMatrixAt(cellCount++, scratch.matrix);
		}
	};

	/** which filled mesh marks the catching point — null while nothing catches */
	let target: 'disc' | 'square' | null = null;
	/** id of the point that will catch the drop, for the harness */
	let targetId: string | null = null;

	$effect(() => {
		// fading out: keep the last layout so the guides fade where they were
		if (!active) return;
		if (!rings || !reachRings || !cells || !targetDisc || !targetSquare) return;

		const hit = $dragStore.intersectionPoint;
		if (hit) [pointer.x, pointer.z] = clampToTable(hit.x, hit.z);

		ringCount = 0;
		reachCount = 0;
		cellCount = 0;
		bright = reachSet;
		// no pointer → no grid cells: only the catching cell is ever drawn
		// (tableplace-269), as a frame — a field of pale squares reads as blank cards
		forEachSnapGuide(snapPoints, null, visit);
		rings.count = ringCount;
		reachRings.count = reachCount;
		cells.count = cellCount;
		reaching = !!bright;
		// for the harness: which points are in the bright set right now
		reachRings.userData.snapGuideReach = bright ? [...bright].sort() : [];
		applyFade();
		rings.instanceMatrix.needsUpdate = true;
		reachRings.instanceMatrix.needsUpdate = true;
		cells.instanceMatrix.needsUpdate = true;

		const caught = drop?.kind === 'snap' ? drop.snap : undefined;
		target = caught ? (caught.grid ? 'square' : 'disc') : null;
		targetId = caught?.id ?? null;
		if (caught && drop) {
			const y = snapFloorY(snapPoints?.[caught.id]);
			if (caught.grid) {
				place(
					drop.position[0],
					y,
					drop.position[2],
					(caught.grid.pitch / 2) * SNAP_GUIDE_CELL_INSET * SQRT2,
					-caught.grid.rotation * DEG2RAD + Math.PI / 4
				);
				scratch.matrix.decompose(
					targetSquare.position,
					targetSquare.quaternion,
					targetSquare.scale
				);
			} else {
				place(drop.position[0], y, drop.position[2], caught.radius, 0);
				scratch.matrix.decompose(targetDisc.position, targetDisc.quaternion, targetDisc.scale);
			}
		}
		targetDisc.visible = target === 'disc';
		targetSquare.visible = target === 'square';
		targetDisc.userData.snapGuideTarget = target === 'disc' ? targetId : null;
		targetSquare.userData.snapGuideTarget = target === 'square' ? targetId : null;
		invalidate();
	});

	// ---- fade: ~150ms in on lift, out on drop / Alt ----

	let fade = 0;
	let fading = $state(false);
	$effect(() => {
		void active;
		fading = true; // reads `active`, writes only `fading`
	});

	const applyFade = () => {
		ringMaterial.opacity =
			fade * (reaching ? SNAP_GUIDE_OUT_OF_REACH_OPACITY : SNAP_GUIDE_RING_OPACITY);
		reachMaterial.opacity = fade * SNAP_GUIDE_REACH_OPACITY;
		fillMaterial.opacity = fade * SNAP_GUIDE_FILL_OPACITY;
		snapGuideDimMaterial.opacity = fade * SNAP_GUIDE_DIM_OPACITY;
		const shown = fade > 0;
		ringMaterial.visible = shown;
		reachMaterial.visible = shown;
		fillMaterial.visible = shown;
		snapGuideDimMaterial.visible = shown;
	};

	useTask(
		(delta) => {
			const goal = active ? 1 : 0;
			const step = delta / SNAP_GUIDE_FADE_S;
			fade = goal > fade ? Math.min(goal, fade + step) : Math.max(goal, fade - step);
			applyFade();
			if (fade === goal) fading = false;
		},
		{ running: () => fading }
	);

	onDestroy(() => {
		fade = 0;
		applyFade();
		ringGeometry.dispose();
		cellGeometry.dispose();
		discGeometry.dispose();
		ringMaterial.dispose();
		reachMaterial.dispose();
		fillMaterial.dispose();
	});
</script>

{#key pointPool}
	<T.InstancedMesh
		args={[ringGeometry, ringMaterial, pointPool]}
		count={0}
		bind:ref={rings}
		oncreate={onLayer}
		userData={{ snapGuide: 'rings' }}
	/>
	<T.InstancedMesh
		args={[ringGeometry, reachMaterial, pointPool]}
		count={0}
		bind:ref={reachRings}
		oncreate={onLayer}
		userData={{ snapGuide: 'reach' }}
	/>
{/key}
{#key cellPool}
	<T.InstancedMesh
		args={[cellGeometry, ringMaterial, cellPool]}
		count={0}
		bind:ref={cells}
		oncreate={onLayer}
		userData={{ snapGuide: 'cells' }}
	/>
{/key}
<T.Mesh
	geometry={discGeometry}
	material={fillMaterial}
	visible={false}
	bind:ref={targetDisc}
	oncreate={onLayer}
	userData={{ snapGuide: 'target' }}
/>
<T.Mesh
	geometry={cellGeometry}
	material={fillMaterial}
	visible={false}
	bind:ref={targetSquare}
	oncreate={onLayer}
	userData={{ snapGuide: 'target' }}
/>
