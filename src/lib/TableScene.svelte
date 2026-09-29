<script lang="ts">
	import { T, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { HUD, interactivity } from '@threlte/extras';
	import TableContactShadows from './TableContactShadows.svelte';
	import Table from './Table.svelte';
	import Card from './Card.svelte';
	import TableCamera from './TableCamera.svelte';
	import DropIndicator from './drop/DropIndicator.svelte';
	import HudTrayScene from '$lib/HUDTray/HUDTrayScene.svelte';
	import Deck from './Deck.svelte';
	import Piece from './Piece.svelte';
	import SnapPointMarker from './SnapPointMarker.svelte';
	import SnapGridMarker from './SnapGridMarker.svelte';
	import Hdr from './HDR.svelte';
	import HudPreviewScene from './HUDPreview/HUDPreviewScene.svelte';
	import RemoteCameraAvatar from './RemoteCameraAvatar.svelte';
	import TestBridge from './dev/TestBridge.svelte';
	import { dragStore, setNoSnap, setTrayHover } from '$lib/store/dragStore.svelte';
	import { setTableFeatures, TABLE_FEATURES_DEFAULT } from '$lib/store/tableFeatures';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import { remoteCameraActions, remoteCameraStore } from './store/remoteCameraStore.svelte';
	import { playerColor } from './hud/players';
	import { clampToTable } from './utils/transforms/drop';
	import { cancelActiveDrag, commitActiveDrag } from './drop/commit';
	import { watchFrameStalls } from '$lib/utils/frame-stall.svelte';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
	import { PIECE_DRAG_Y } from '$lib/utils/constants-pieces';
	import { TABLE_HALF_X, TABLE_HALF_Z, TABLE_TOP_Y } from '$lib/utils/constants-table';
	import type { GameDTO } from './store/game/types';
	type CardDTO = GameDTO['cards'][string];

	/**
	 * `hand={false}` leaves the local hand tray off the table (the pack editor:
	 * a pack has no way to represent a hand). It also has to reach the drop
	 * resolver — the tray hover flag is module-global and can arrive stale from
	 * a previous /play visit, so an unmounted tray must not win a drop.
	 *
	 * `snapEditing` draws the authored snap-point markers and makes them
	 * draggable — the /setup layer. Snapping itself needs no flag: it is part of
	 * resolving a drop wherever the points exist.
	 */
	let { hand = true, snapEditing = false }: { hand?: boolean; snapEditing?: boolean } = $props();

	$effect(() => {
		setTableFeatures({ hand, snapEditing });
		if (!hand) setTrayHover(false);
		return () => setTableFeatures(TABLE_FEATURES_DEFAULT);
	});

	const isDragging = $derived($dragStore.isDragging !== null);
	let mesh: THREE.Mesh | undefined = $state();
	const { camera, canvas } = useThrelte();

	let intersectionPoint: THREE.Vector3 | null = $state(null);

	// fallback for when the pointer leaves the table mesh: the infinite plane at
	// tabletop height keeps a drag tracking instead of yielding a null hit
	const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_TOP_Y);
	const planeHit = new THREE.Vector3();

	/**
	 * The main scene's one and only interactivity context (see #86). Every
	 * interactive entity on the table — Card, Deck, Piece, Table — registers into
	 * this one, so they share a Raycaster, a dispatch loop (which is what lets
	 * stopPropagation pick the topmost hit across entity types) and the compute
	 * below. Descendants must not call interactivity() themselves: setContext
	 * would shadow this for their subtree. The only other call in the app is
	 * HUDTrayScene's, which needs a second one for its own camera.
	 */
	interactivity({
		compute: (event, state) => {
			if (!mesh) return;
			const intersects = state.raycaster.intersectObject(mesh);
			const [intersection] = intersects;
			intersectionPoint =
				intersection?.point ??
				(state.raycaster.ray.intersectPlane(tablePlane, planeHit) ? planeHit.clone() : null);
			$dragStore.intersectionPoint = intersectionPoint ?? undefined;

			if (isDragging && intersectionPoint) {
				// same clamp the drop commits with (see utils/transforms/drop.ts),
				// so the floating entity can never track somewhere it can't land
				const [cx, cz] = clampToTable(intersectionPoint.x, intersectionPoint.z);
				const dragId = $dragStore.isDragging as string;
				// A drag the referee refused at the pickup (tableplace-171) is a LOCAL
				// rehearsal: the entity follows the pointer here and snaps back on
				// release, and not one frame of it is broadcast — a peer has to be
				// unable to tell the gesture was ever attempted. `updateStateSilently`
				// is the existing apply-without-broadcast path (it is what an inbound
				// patch uses), so nothing new is needed to hold a drag back.
				const apply = $dragStore.denied ? gameStore.updateStateSilently : gameStore.updateState;
				if (dragId.startsWith('piece:')) {
					apply({ pieces: { [dragId]: { position: [cx, PIECE_DRAG_Y, cz] } } });
				} else if (dragId.startsWith('deck:')) {
					// decks float at card height while dragged; these stream through
					// the same position throttle as cards (see storeIntegration.ts)
					apply({ decks: { [dragId]: { position: [cx, CARD_DRAG_Y, cz] } } });
				} else {
					apply({ cards: { [dragId]: { position: [cx, CARD_DRAG_Y, cz] } } });
				}
			}

			// normalized against the CANVAS, not the viewport: /create insets the
			// canvas behind a fixed editor column, and window coordinates would put
			// the ray a third of a screen off — nothing on the table would be
			// clickable where it is drawn. Identical arithmetic when the canvas
			// fills the window, which is what /play and /setup do.
			state.pointer.update((p) => {
				const rect = canvas.getBoundingClientRect();
				if (!rect.width || !rect.height) return p;
				p.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
				p.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
				return p;
			});

			// Update the raycaster
			state.raycaster.setFromCamera(state.pointer.current, $camera);
		}
	});

	const cards = $derived(Object.entries($gameStore?.cards ?? {}) as [string, CardDTO][]);

	// Drag safety, registered once for the whole scene (so both /play and
	// /setup get it):
	// - pointerup anywhere: a release that never reaches the table mesh (off
	//   canvas, over the HUD) used to leave the card stuck in the lifted
	//   state. Bubble phase, so an on-table release has already committed and
	//   this no-ops.
	// - Esc: return the card to where it was picked up.
	// - Alt: the no-snap modifier. Tracked from the events rather than a
	//   keydown latch so the preview follows a press/release mid-drag, and
	//   read off the pointer event at release so the commit agrees with what
	//   the indicator was drawing. Blur clears it — alt-tabbing away never
	//   delivers the keyup.
	// - and the frame-loop watcher, whose whole job is to notice when frames
	//   have stopped arriving so the entity springs stop pretending to animate
	//   (see utils/frame-stall.svelte.ts). Registered here because this is the
	//   scene those springs belong to; it costs one rAF callback that reads a
	//   timestamp.
	onMount(() => {
		const unwatch = watchFrameStalls();
		const onPointerUp = (event: PointerEvent) => {
			setNoSnap(event.altKey);
			commitActiveDrag();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') cancelActiveDrag();
			setNoSnap(event.altKey);
		};
		const onKeyUp = (event: KeyboardEvent) => setNoSnap(event.altKey);
		const onBlur = () => setNoSnap(false);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		return () => {
			unwatch();
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
		};
	});

	/**
	 * Remote camera avatars. Never our own — the store filters it on receive,
	 * this filters it again because the id can arrive before we have one.
	 */
	const remoteCameras = $derived(
		Object.keys($remoteCameraStore)
			.filter((id) => id !== gameActions.getMyId())
			.map((id) => ({ id, color: playerColor(id, $gameStore?.players?.[id]?.seat) }))
	);

	/**
	 * The key light's shadow camera: an ortho box around the whole felt
	 * (60×30, constants-table). The light is tilted, so the felt's projection
	 * onto the light's image plane is wider than its own footprint — the
	 * extent below is the worst-case corner projection at this angle, not
	 * TABLE_HALF_X. One square bound keeps the fit honest either axis; at
	 * mapSize 1024 a texel is ~0.06 world units — 2048 doubled the
	 * SwiftShader fill-rate of the whole shadow pass and tripped the CI
	 * runner's drag race (see PR #157); 1024 is fill-rate parity with the
	 * old 6-face point-light shadow, with normalBias scaled to the texel.
	 */
	const SHADOW_EXTENT = TABLE_HALF_X + 2;

	// One shared clock for the presence fade + expiry, instead of a timer per
	// avatar. Cheap enough to leave running; it only touches a store. The
	// roster goes in so a player the server says is still connected keeps their
	// avatar however long they sit still — expiry is only the fallback for
	// peers we have no presence for (see remoteCameraStore).
	$effect(() => {
		// `get`, not `$gameStore`: reading the store reactively here would make
		// the effect re-run — and rebuild the interval — on every state change
		const handle = setInterval(
			() => remoteCameraActions.tick(Date.now(), get(gameStore)?.players),
			500
		);
		return () => clearInterval(handle);
	});
</script>

<TableCamera />
<!-- Directional key light, slightly warm, angled in from the player's right.
     The point light this replaces sat dead overhead, so every resting piece
     hid its own shadow — a keyed angle throws a visible offset shadow instead.
     bias/normalBias are tuned together: bias alone left acne bands on the
     flat felt, normalBias alone detached the shadow from card edges
     (peter-panning); the pair below shows neither in the harness captures. -->
<T.DirectionalLight
	position={[14, 26, 10]}
	intensity={1.5}
	color="#fff3e2"
	castShadow
	shadow.mapSize.width={1024}
	shadow.mapSize.height={1024}
	shadow.camera.left={-SHADOW_EXTENT}
	shadow.camera.right={SHADOW_EXTENT}
	shadow.camera.top={SHADOW_EXTENT}
	shadow.camera.bottom={-SHADOW_EXTENT}
	shadow.camera.near={4}
	shadow.camera.far={65}
	shadow.bias={-0.0002}
	shadow.normalBias={0.06}
/>
<!-- soft fill so vertical faces (card edges, deck sides) aren't pitch black -->
<T.AmbientLight intensity={0.5} />
<!-- Contact shadows: a blurred top-down depth pass composited on a plane just
     above the felt (see TableContactShadows for why this is a fork of the
     @threlte/extras component). This — not the shadow map — is what grounds
     pieces on a map overlay: the overlay's ImageMaterial is unlit, so real
     shadows can never darken it, but this plane sits ABOVE the overlay
     (felt + overlay clearance 0.003 < 0.0045 < card rest 0.26). `far` stops
     at 0.5 so only the GROUNDED BULK of resting entities casts: anything held
     aloft (CARD_DRAG_Y 2, PIECE_DRAG_Y 1.2) and the billboarded labels are
     clipped out, and so are the wide upper bulges of tall pieces — the bag's
     pouch and the pawn's head used to inflate their shadows well past their
     bases (each translucent depth layer accumulates, so a wide silhouette
     saturates oversized). -->
<TableContactShadows
	position.y={TABLE_TOP_Y + 0.0045}
	width={TABLE_HALF_X * 2 + 2}
	height={TABLE_HALF_Z * 2 + 2}
	far={0.5}
	resolution={256}
	opacity={0.6}
	blur={1.2}
/>

{#if hand}
	<HUD>
		<HudTrayScene />
	</HUD>
{/if}

<HUD>
	<HudPreviewScene />
</HUD>

<Hdr />
<DropIndicator />
<Table bind:mesh />

<!-- the headless harness's window handle; a literal `false` in a static build -->
{#if import.meta.env.DEV}
	<TestBridge />
{/if}

{#each Object.entries($gameStore?.decks ?? {}) as [id] (id)}
	<Deck {id} />
{/each}

{#each cards as [id] (id)}
	<Card {id} />
{/each}

{#each Object.keys($gameStore?.pieces ?? {}).filter((key) => $gameStore?.pieces?.[key]) as id (id)}
	<Piece {id} />
{/each}

<!-- authored placement guides, drawn only while they're being authored -->
{#if snapEditing}
	{#each Object.keys($gameStore?.snapPoints ?? {}).filter((key) => $gameStore?.snapPoints?.[key]) as id (id)}
		{#if $gameStore?.snapPoints?.[id]?.kind === 'grid'}
			<SnapGridMarker {id} />
		{:else}
			<SnapPointMarker {id} />
		{/if}
	{/each}
{/if}

{#each remoteCameras as { id, color } (id)}
	<RemoteCameraAvatar playerId={id} {color} />
{/each}
