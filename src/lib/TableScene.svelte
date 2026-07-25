<script lang="ts">
	import { T, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { HUD, interactivity } from '@threlte/extras';
	import Table from './Table.svelte';
	import Card from './Card.svelte';
	import TableCamera from './TableCamera.svelte';
	import DropIndicator from './drop/DropIndicator.svelte';
	import HudTrayScene from '$lib/HUDTray/HUDTrayScene.svelte';
	import Deck from './Deck.svelte';
	import Piece from './Piece.svelte';
	import Hdr from './HDR.svelte';
	import HudPreviewScene from './HUDPreview/HUDPreviewScene.svelte';
	import RemoteCameraAvatar from './RemoteCameraAvatar.svelte';
	import { dragStore, setNoSnap, setTrayHover } from '$lib/store/dragStore.svelte';
	import { setTableFeatures, TABLE_FEATURES_DEFAULT } from '$lib/store/tableFeatures';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import { remoteCameraActions, remoteCameraStore } from './store/remoteCameraStore.svelte';
	import { playerColor } from './hud/players';
	import { clampToTable } from './utils/transforms/drop';
	import { cancelActiveDrag, commitActiveDrag } from './drop/commit';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
	import { PIECE_DRAG_Y } from '$lib/utils/constants-pieces';
	import { TABLE_TOP_Y } from '$lib/utils/constants-table';
	import type { GameDTO } from './store/game/types';
	type CardDTO = GameDTO['cards'][string];

	/**
	 * `hand={false}` leaves the local hand tray off the table (the pack editor:
	 * a pack has no way to represent a hand). It also has to reach the drop
	 * resolver — the tray hover flag is module-global and can arrive stale from
	 * a previous /play visit, so an unmounted tray must not win a drop.
	 */
	let { hand = true }: { hand?: boolean } = $props();

	$effect(() => {
		setTableFeatures({ hand });
		if (!hand) setTrayHover(false);
		return () => setTableFeatures(TABLE_FEATURES_DEFAULT);
	});

	const isDragging = $derived($dragStore.isDragging !== null);
	let mesh: THREE.Mesh | undefined = $state();
	const { camera } = useThrelte();

	let intersectionPoint: THREE.Vector3 | null = $state(null);

	// fallback for when the pointer leaves the table mesh: the infinite plane at
	// tabletop height keeps a drag tracking instead of yielding a null hit
	const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_TOP_Y);
	const planeHit = new THREE.Vector3();

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
				if (dragId.startsWith('piece:')) {
					gameStore.updateState({ pieces: { [dragId]: { position: [cx, PIECE_DRAG_Y, cz] } } });
				} else if (dragId.startsWith('deck:')) {
					// decks float at card height while dragged; these stream through
					// the same position throttle as cards (see storeIntegration.ts)
					gameStore.updateState({ decks: { [dragId]: { position: [cx, CARD_DRAG_Y, cz] } } });
				} else {
					gameStore.updateState({ cards: { [dragId]: { position: [cx, CARD_DRAG_Y, cz] } } });
				}
			}

			state.pointer.update((p) => {
				p.x = (event.clientX / window.innerWidth) * 2 - 1;
				p.y = -(event.clientY / window.innerHeight) * 2 + 1;
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
	onMount(() => {
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
<T.PointLight position={[0, 20, 0]} intensity={500} scale={1} castShadow />
<!-- soft fill so vertical faces (card edges, deck sides) aren't pitch black -->
<T.AmbientLight intensity={0.5} />

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

{#each Object.entries($gameStore?.decks ?? {}) as [id] (id)}
	<Deck {id} />
{/each}

{#each cards as [id] (id)}
	<Card {id} />
{/each}

{#each Object.keys($gameStore?.pieces ?? {}).filter((key) => $gameStore?.pieces?.[key]) as id (id)}
	<Piece {id} />
{/each}

{#each remoteCameras as { id, color } (id)}
	<RemoteCameraAvatar playerId={id} {color} />
{/each}
