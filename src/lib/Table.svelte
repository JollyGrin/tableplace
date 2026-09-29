<script lang="ts">
	import { T, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { onDestroy } from 'svelte';
	import { Grid } from '@threlte/extras';
	import { get } from 'svelte/store';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import OverlayCustom from './table-overlay/OverlayCustom.svelte';
	import { commitActiveDrag } from './drop/commit';
	import { dragStore, setNoSnap } from './store/dragStore.svelte';
	import { snapEditor } from './store/snapEditor';
	import { tableFeatures } from './store/tableFeatures';
	import { DRAG_THRESHOLD_PX } from './utils/counter-input';
	import { armRadialPress } from '$lib/radial/gesture';
	import type { IntersectionEvent } from '@threlte/extras';
	import { TABLE_TOP_Y } from './utils/constants-table';
	import { beginBoxSelect } from '$lib/selection/boxSelect';
	import { clearSelection } from '$lib/store/selection';
	import { classicMouse } from '$lib/store/mouseMode';

	let { mesh = $bindable() }: { mesh?: THREE.Mesh } = $props();

	// The drop lives in drop/commit.ts — shared with the window-level release
	// fallback, and resolved by the same pure function the DropIndicator
	// previews with, so what the player saw while dragging is what lands.
	// Alt state is taken off the release itself, so a modifier let go in the
	// same instant as the button can't leave the commit disagreeing with the
	// preview.
	function handleDragEnd(event: IntersectionEvent<PointerEvent>) {
		setNoSnap(event.nativeEvent.altKey);
		commitActiveDrag();
	}

	/**
	 * Snap-point placement (the /setup layer, armed from its pane): a plain click
	 * on bare felt drops a snap point where it landed.
	 *
	 * Two things have to be excluded, because the browser fires `click` for both:
	 * a card drag that happened to be released over the table (its pointerdown
	 * was claimed by the card, so the felt never saw one), and an OrbitControls
	 * camera drag that started on the felt (same down/up element, just moved) —
	 * hence the travel threshold.
	 */
	let pressedFelt: { x: number; y: number } | null = null;

	const { camera, dom } = useThrelte();
	const projected = new THREE.Vector3();

	/** world → client pixels with the live camera, for the selection box */
	function project([x, y, z]: [number, number, number]) {
		const rect = dom.getBoundingClientRect();
		projected.set(x, y, z).project(camera.current);
		if (projected.z > 1) return null; // behind the camera
		return {
			x: rect.left + ((projected.x + 1) / 2) * rect.width,
			y: rect.top + ((1 - projected.y) / 2) * rect.height
		};
	}

	function handlePointerDown(event: IntersectionEvent<PointerEvent>) {
		const carrying = !!get(dragStore).isDragging;
		pressedFelt = carrying ? null : { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
		/**
		 * Left-drag on bare felt draws a selection box (tableplace-202) — the
		 * orbit that used to own it is on the right button now. A press reaches
		 * the felt only when nothing on the table claimed it first. Not while a
		 * pile is being carried (grab.ts): that press is the one placing it. The
		 * classic mapping keeps the left button for orbit.
		 */
		if (event.nativeEvent.button === 0 && !carrying && !get(classicMouse))
			beginBoxSelect(event.nativeEvent, project);
		/**
		 * Bare felt gets a wheel too (v1: reset view) — but ONLY on the right
		 * button, never on a left long-press.
		 *
		 * The felt is the one surface a press can reach by accident. Every other
		 * entity claims its own pointerdown, so a press that arrives here either
		 * was aimed at the table or MISSED what it was aimed at — and a grab that
		 * misses is routine on a stalled renderer, where an entity is still drawn
		 * (and raycast) where it was a frame ago. Arming a left hold on that path
		 * puts a wheel in the middle of what the hand is doing: the left button
		 * on felt already means orbit, and the gesture it interrupts is a drag.
		 * Right-press-hold and right-click are unambiguous, so the table keeps
		 * those and nothing else. Pieces, which open their own wheel, are
		 * vetoed in the gesture.
		 */
		if (event.nativeEvent.button !== 2) return;
		armRadialPress({
			target: { kind: 'table' },
			event: event.nativeEvent,
			// the wheel ate the press: a release on /setup's armed snap layer must
			// not also drop a snap point where the wheel opened
			onOpen: () => (pressedFelt = null)
		});
	}

	function handleClick(event: IntersectionEvent<MouseEvent>) {
		const pressed = pressedFelt;
		pressedFelt = null;
		if (!pressed) return;
		const travel = Math.hypot(
			event.nativeEvent.clientX - pressed.x,
			event.nativeEvent.clientY - pressed.y
		);
		if (travel >= DRAG_THRESHOLD_PX) return; // that was a camera orbit, or a box
		// on the classic mapping there is no box to do this: a plain click on
		// the felt lets go of the selection (the box's own release does it
		// otherwise — see selection/boxSelect)
		if (get(classicMouse) && !event.nativeEvent.shiftKey) clearSelection();
		const { placing, rotation, radius } = get(snapEditor);
		if (!placing || !get(tableFeatures).snapEditing) return;
		event.stopPropagation();
		gameActions.addSnapPoint({ position: [event.point.x, event.point.z], rotation, radius });
	}

	// Create procedural felt texture. Built synchronously: this component only
	// mounts client-side (inside <Canvas>, behind isConnected), so the material
	// is born with its map — no null→texture swap, no shader-recompile timing.
	function createFeltTexture(): THREE.CanvasTexture {
		// Create canvas for procedural texture
		const canvas = document.createElement('canvas');
		canvas.width = 512;
		canvas.height = 512;
		const ctx = canvas.getContext('2d')!;

		// Fill base color (darker)
		ctx.fillStyle = '#2a503d';
		ctx.fillRect(0, 0, 512, 512);

		// Add cross-hatch pattern
		ctx.strokeStyle = '#35654d';
		ctx.lineWidth = 1;

		// Horizontal lines
		for (let y = 0; y < 512; y += 4) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(512, y);
			ctx.stroke();
		}

		// Vertical lines
		for (let x = 0; x < 512; x += 4) {
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, 512);
			ctx.stroke();
		}

		// Add noise pattern for felt texture
		for (let i = 0; i < 100000; i++) {
			const x = Math.random() * 512;
			const y = Math.random() * 512;
			const brightness = Math.random() < 0.5 ? 0.7 : 1.0;
			ctx.fillStyle = `rgba(53, 101, 77, ${brightness})`;
			ctx.fillRect(x, y, 2, 2);
		}

		// Create texture from canvas
		const texture = new THREE.CanvasTexture(canvas);
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
		texture.repeat.set(4, 2);
		return texture;
	}

	const feltTexture = createFeltTexture();

	// Branding wordmark printed into the felt near a board corner. Its own
	// plane (NOT baked into createFeltTexture — that texture repeats 4x2
	// across the board and would tile the mark 8 times).
	function createWordmarkTexture(): THREE.CanvasTexture {
		const canvas = document.createElement('canvas');
		canvas.width = 1024;
		canvas.height = 256;
		const ctx = canvas.getContext('2d')!;

		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = '600 130px "Helvetica Neue", Arial, sans-serif';
		ctx.fillStyle = '#4c8a68';
		ctx.fillText('table.place', canvas.width / 2, canvas.height / 2 + 8);

		const texture = new THREE.CanvasTexture(canvas);
		texture.anisotropy = 4;
		return texture;
	}

	const wordmarkTexture = createWordmarkTexture();

	onDestroy(() => {
		feltTexture.dispose();
		wordmarkTexture.dispose();
	});
</script>

{#each Object.keys($gameStore?.overlays ?? {}).filter((key) => $gameStore?.overlays?.[key]) as overlayId (overlayId)}
	<OverlayCustom id={overlayId} />
{/each}

<!-- fadeOrigin pinned to table center (default follows the camera, which kept
     the grid strong ~100 units out). Radial fade: solid over the felt, gone
     ~20 units past the long edge. -->
<Grid
	position.y={TABLE_TOP_Y}
	cellColor="#fff"
	sectionColor="#fff"
	sectionThickness={0}
	cellThickness={0.5}
	fadeOrigin={[0, TABLE_TOP_Y, 0]}
	fadeDistance={50}
	fadeStrength={0.5}
	infiniteGrid
/>
<T.Group position={[0, 0, 0]}>
	<T.Mesh
		receiveShadow
		bind:ref={mesh}
		onpointerup={handleDragEnd}
		onpointerdown={handlePointerDown}
		onclick={handleClick}
	>
		<T.BoxGeometry args={[60, 0.5, 30]} />
		<!-- one stable material with its map from birth.
		     (swapping whole materials via {#if}+<T is> detaches without reattaching in threlte 8.5) -->
		<T.MeshStandardMaterial
			map={feltTexture}
			roughness={0.9}
			metalness={0}
			bumpMap={feltTexture}
			bumpScale={0.02}
			side={THREE.DoubleSide}
		/>
	</T.Mesh>
	<!-- printed felt wordmark: not a raycast target (compute() in TableScene
	     only intersects the table mesh above), no pointer handlers, so it
	     can never intercept a drag/drop. -->
	<T.Mesh position={[9, 0.256, -4.5]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
		<T.PlaneGeometry args={[5, 1.25]} />
		<T.MeshStandardMaterial
			map={wordmarkTexture}
			transparent
			opacity={0.22}
			depthWrite={false}
			roughness={1}
			metalness={0}
			side={THREE.DoubleSide}
		/>
	</T.Mesh>
</T.Group>
