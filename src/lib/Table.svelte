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
	import {
		ROOM_COLOR,
		TABLE_HALF_X,
		TABLE_HALF_Z,
		TABLE_RIM_DROP,
		TABLE_RIM_RISE,
		TABLE_RIM_WIDTH,
		TABLE_TOP_Y
	} from './utils/constants-table';

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

	function handlePointerDown(event: IntersectionEvent<PointerEvent>) {
		pressedFelt = get(dragStore).isDragging
			? null
			: { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
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
		const { placing, rotation, radius } = get(snapEditor);
		if (!placing || !pressed || !get(tableFeatures).snapEditing) return;
		const travel = Math.hypot(
			event.nativeEvent.clientX - pressed.x,
			event.nativeEvent.clientY - pressed.y
		);
		if (travel >= DRAG_THRESHOLD_PX) return; // that was a camera orbit
		event.stopPropagation();
		gameActions.addSnapPoint({ position: [event.point.x, event.point.z], rotation, radius });
	}

	// Procedural felt, built once. Built synchronously: this component only
	// mounts client-side (inside <Canvas>, behind isConnected), so the material
	// is born with its map — no null→texture swap, no shader-recompile timing.
	//
	// Three layers, all drawn so the tile wraps seamlessly (the map repeats
	// 4×2 across the felt): a soft low-frequency mottle so the cloth isn't one
	// flat tone, a fine twill weave, and loose fibres. The base is a deep,
	// saturated baize — the lights and ACES lift it, and a lighter base read
	// as washed-out sage.
	function createFeltTexture(): THREE.CanvasTexture {
		const SIZE = 512;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = SIZE;
		const ctx = canvas.getContext('2d')!;

		ctx.fillStyle = '#1b5236';
		ctx.fillRect(0, 0, SIZE, SIZE);

		// mottle: each blob is drawn at its wrapped offsets too, so no seam
		for (let i = 0; i < 70; i++) {
			const x = Math.random() * SIZE;
			const y = Math.random() * SIZE;
			const r = 30 + Math.random() * 80;
			const light = Math.random() < 0.5;
			for (const dx of [-SIZE, 0, SIZE]) {
				for (const dy of [-SIZE, 0, SIZE]) {
					const blob = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
					blob.addColorStop(0, light ? 'rgba(52, 118, 78, 0.1)' : 'rgba(8, 36, 22, 0.12)');
					blob.addColorStop(1, 'rgba(0, 0, 0, 0)');
					ctx.fillStyle = blob;
					ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
				}
			}
		}

		// twill: a 4px diagonal rib, lit on one side, shaded on the other
		for (let y = 0; y < SIZE; y += 2) {
			for (let x = 0; x < SIZE; x += 2) {
				const rib = ((x + y) / 2) % 4;
				if (rib === 0) ctx.fillStyle = 'rgba(70, 140, 96, 0.16)';
				else if (rib === 2) ctx.fillStyle = 'rgba(0, 20, 10, 0.18)';
				else continue;
				ctx.fillRect(x, y, 2, 2);
			}
		}

		// fibres
		for (let i = 0; i < 40000; i++) {
			ctx.fillStyle = Math.random() < 0.5 ? 'rgba(80, 150, 104, 0.18)' : 'rgba(4, 24, 14, 0.22)';
			ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 1.5, 1.5);
		}

		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
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

	// Wood grain for the rim, built once: streaks running along the texture's
	// u axis, which every rail below lays along its own length.
	function createWoodTexture(): THREE.CanvasTexture {
		const canvas = document.createElement('canvas');
		canvas.width = 512;
		canvas.height = 64;
		const ctx = canvas.getContext('2d')!;

		ctx.fillStyle = '#5a3620';
		ctx.fillRect(0, 0, 512, 64);
		for (let i = 0; i < 90; i++) {
			const y = Math.random() * 64;
			const wobble = 1 + Math.random() * 3;
			const phase = Math.random() * Math.PI * 2;
			ctx.strokeStyle = Math.random() < 0.6 ? 'rgba(38, 20, 10, 0.35)' : 'rgba(128, 84, 50, 0.3)';
			ctx.lineWidth = 0.5 + Math.random() * 1.5;
			ctx.beginPath();
			// whole periods across the width, so the grain wraps without a seam
			for (let x = 0; x <= 512; x += 8) {
				const at = y + Math.sin((x / 512) * Math.PI * 2 * 2 + phase) * wobble;
				if (x === 0) ctx.moveTo(x, at);
				else ctx.lineTo(x, at);
			}
			ctx.stroke();
		}

		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
		texture.repeat.set(3, 1);
		return texture;
	}

	const woodTexture = createWoodTexture();
	const woodMaterial = new THREE.MeshStandardMaterial({
		map: woodTexture,
		roughness: 0.55,
		metalness: 0
	});

	/**
	 * The rim: four rails wholly outside the felt. The long rails run the full
	 * length and cover the corners; the short ones are the same geometry turned
	 * a quarter, so the grain follows every rail. Not raycast (only the felt
	 * mesh is — see compute() in TableScene), no pointer handlers.
	 */
	const RIM_HEIGHT = TABLE_RIM_RISE + TABLE_RIM_DROP;
	const RIM_Y = TABLE_TOP_Y + (TABLE_RIM_RISE - TABLE_RIM_DROP) / 2;
	const rails: { position: [number, number, number]; length: number; yaw: number }[] = [
		{
			position: [0, RIM_Y, -TABLE_HALF_Z - TABLE_RIM_WIDTH / 2],
			length: 2 * (TABLE_HALF_X + TABLE_RIM_WIDTH),
			yaw: 0
		},
		{
			position: [0, RIM_Y, TABLE_HALF_Z + TABLE_RIM_WIDTH / 2],
			length: 2 * (TABLE_HALF_X + TABLE_RIM_WIDTH),
			yaw: 0
		},
		{
			position: [-TABLE_HALF_X - TABLE_RIM_WIDTH / 2, RIM_Y, 0],
			length: 2 * TABLE_HALF_Z,
			yaw: Math.PI / 2
		},
		{
			position: [TABLE_HALF_X + TABLE_RIM_WIDTH / 2, RIM_Y, 0],
			length: 2 * TABLE_HALF_Z,
			yaw: Math.PI / 2
		}
	];

	// The room: a flat clear colour, so it costs no draw at all — a gradient
	// texture background is a full-screen pass every frame, which the CI
	// runner's frame-gap canary punishes (#164). Restored on unmount so a
	// canvas that outlives the table falls back to the page behind it.
	const { scene } = useThrelte();
	const previousBackground = scene.background;
	scene.background = new THREE.Color(ROOM_COLOR);

	onDestroy(() => {
		scene.background = previousBackground;
		feltTexture.dispose();
		wordmarkTexture.dispose();
		woodTexture.dispose();
		woodMaterial.dispose();
	});
</script>

{#each Object.keys($gameStore?.overlays ?? {}).filter((key) => $gameStore?.overlays?.[key]) as overlayId (overlayId)}
	<OverlayCustom id={overlayId} />
{/each}

<!-- The grid is ambience printed on the cloth, not a debug plane: sized to
     the felt (never past the rim), a few shades darker than the baize, and
     fading from the centre so the edges stay quiet. A hair above the felt's
     top face, so it never z-fights it. -->
<Grid
	position.y={TABLE_TOP_Y}
	gridSize={[TABLE_HALF_X * 2, TABLE_HALF_Z * 2]}
	cellColor="#0b2616"
	sectionColor="#0b2616"
	sectionThickness={0}
	cellThickness={0.6}
	fadeOrigin={[0, TABLE_TOP_Y, 0]}
	fadeDistance={45}
	fadeStrength={1}
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
	{#each rails as rail, i (i)}
		<T.Mesh position={rail.position} rotation.y={rail.yaw} material={woodMaterial} receiveShadow>
			<T.BoxGeometry args={[rail.length, RIM_HEIGHT, TABLE_RIM_WIDTH]} />
		</T.Mesh>
	{/each}
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
