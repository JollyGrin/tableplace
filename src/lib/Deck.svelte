<script lang="ts">
	import * as THREE from 'three';
	import { T } from '@threlte/core';
	import { Text, Billboard, ImageMaterial, interactivity } from '@threlte/extras';
	import type { IntersectionEvent } from '@threlte/extras';
	import { Spring } from 'svelte/motion';
	import { dragStart, dragStore, setDeckHover } from '$lib/store/dragStore.svelte';
	import {
		CARD_DRAG_Y,
		CARD_WIDTH,
		CARD_HEIGHT,
		deckBodyGeometry,
		deckHeightForCount
	} from '$lib/utils/constants-cards';
	import { createDeckEdgeTexture, deckEdgeRepeatY } from '$lib/utils/deck-edge-texture';
	import { browser } from '$app/environment';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import { resolveCardImage, sheetRefCache, CARD_BACK_DEFAULT } from '$lib/packs';
	import { claimPointerDown } from '$lib/utils/single-hit-dispatch';
	import { DRAG_THRESHOLD_PX } from '$lib/utils/counter-input';
	import DropFootprint from './drop/DropFootprint.svelte';

	interactivity();

	let { id = '' }: { id: string } = $props();

	const deck = $derived($gameStore?.decks?.[id] ?? {});
	const deckBackImage = $derived($gameStore?.decks?.[id].deckBackImageUrl ?? CARD_BACK_DEFAULT);

	const cards = $derived($gameStore?.decks?.[id]?.cards ?? []);
	const position: [number, number, number] = $derived(deck.position ?? [0, 0, 0]);
	const rotation: [number, number, number] = $derived(deck.rotation ?? [0, 0, 0]);
	const isFaceUp = $derived(deck.isFaceUp ?? false); // true = cards[0] is top, false = cards[cards.length - 1] is top
	// the element, not just the array, can be missing: a pack may declare a deck
	// with no cards (the tbpp schema allows it) and spawn it empty
	const lastCardImage = $derived(cards?.[0]?.faceImageUrl ?? '');
	const displayedImage = $derived(
		resolveCardImage(isFaceUp ? lastCardImage : deckBackImage, $sheetRefCache)
	);

	// body height tracks how many cards are in the stack (clamped)
	const height = $derived(deckHeightForCount(cards?.length ?? 0));

	// Stacked-card-edge look for the sides: per-deck texture clone so repeat.y
	// can track this deck's height (stripes stay one-card-thick as the deck
	// shrinks). Materials stay UNLIT — side faces must never go black under the
	// current lighting rig; the stripes supply the depth cue instead.
	const edgeTexture = browser ? createDeckEdgeTexture() : null;
	// ExtrudeGeometry has two material groups: 0 = top/bottom lids, 1 = side walls
	const bodyMaterials = [
		new THREE.MeshBasicMaterial({ color: '#e2dfd2' }),
		new THREE.MeshBasicMaterial(edgeTexture ? { map: edgeTexture } : { color: '#e2dfd2' })
	];
	$effect(() => {
		if (edgeTexture) edgeTexture.repeat.y = deckEdgeRepeatY(height);
	});

	const isHovered = $derived(id === $dragStore.isDeckHovered);
	// dropping here replaces the table landing entirely, so the deck has to be
	// the cue — the drop indicator suppresses its table footprint while hovered.
	// Cards only: a dragged deck or piece just settles on the felt (see
	// resolveDrop), so lighting up would promise a landing that can't happen —
	// and the deck being dragged is always hovered by its own pointer.
	const isDragged = $derived($dragStore.isDragging === id);
	const isDropTarget = $derived(
		isHovered &&
			!!$dragStore.isDragging &&
			!$dragStore.isDragging.startsWith('deck:') &&
			!$dragStore.isDragging.startsWith('piece:')
	);

	// Lift + glide springs, same rig as Piece.svelte: the local drag snaps XZ
	// instantly (a spring there reads as input lag), remote decks glide toward
	// the ~200ms-throttled store position instead of teleporting between ticks.
	const lift = new Spring(position[1] ?? 0, {
		stiffness: 0.28,
		damping: 0.7,
		precision: 0.0001
	});
	$effect(() => {
		lift.target = isDragged ? CARD_DRAG_Y : (deck.position?.[1] ?? 0);
	});

	const planar = new Spring(
		{ x: position[0] ?? 0, z: position[2] ?? 0 },
		{ stiffness: 0.15, damping: 0.8, precision: 0.0001 }
	);
	$effect(() => {
		const [x = 0, , z = 0] = deck.position ?? [];
		if (isDragged) planar.set({ x, z }, { instant: true });
		else planar.target = { x, z };
	});

	// Shuffle wiggle: a decaying yaw twitch, kicked whenever `shuffledAt`
	// changes — the reorder patch alone is invisible from the back, so this is
	// what tells everyone (shuffler included) a shuffle happened. Low damping
	// on purpose: the spring overshoots a few times, which reads as a riffle.
	const wiggle = new Spring(0, { stiffness: 0.3, damping: 0.15, precision: 0.001 });
	// null = not seeded yet: the first run only records, so a late joiner
	// doesn't replay a shuffle that happened before they arrived
	let prevShuffledAt: number | null | undefined = null;
	$effect(() => {
		const t = deck.shuffledAt;
		const prev = prevShuffledAt;
		prevShuffledAt = t;
		if (prev === null || t === undefined || t === prev) return;
		wiggle.set(0.3, { instant: true });
		wiggle.target = 0;
	});

	let pendingDrag: { x: number; y: number } | null = null;

	// Drag threshold, same as Card/Piece: the pointerdown only arms the
	// gesture. Travel past the threshold and it's a deck move; release under
	// it and the click handler draws instead.
	function onPendingMove(ne: PointerEvent) {
		if (!pendingDrag) return;
		if (Math.hypot(ne.clientX - pendingDrag.x, ne.clientY - pendingDrag.y) < DRAG_THRESHOLD_PX)
			return;
		cancelPendingDrag();
		// origin (pre-lift store position) is what Esc returns the deck to
		dragStart(id, CARD_DRAG_Y, deck.position);
	}

	function cancelPendingDrag() {
		pendingDrag = null;
		window.removeEventListener('pointermove', onPendingMove);
		window.removeEventListener('pointerup', cancelPendingDrag);
	}

	$effect(() => cancelPendingDrag);

	function handlePointerDown(e: IntersectionEvent<PointerEvent>) {
		// claims the pointerdown ahead of anything behind the deck — see
		// claimPointerDown — and locks OrbitControls out of the gesture
		if (!claimPointerDown(e)) return;
		pendingDrag = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
		window.addEventListener('pointermove', onPendingMove);
		window.addEventListener('pointerup', cancelPendingDrag);
	}

	// a press that never travelled: the draw (the pre-threshold behavior —
	// one card off the top, landing in front of the deck)
	function handleClick(e: IntersectionEvent<MouseEvent>) {
		if (e.delta > DRAG_THRESHOLD_PX) return; // was a drag, not a click
		e.stopPropagation();
		gameActions.drawFromTop(id);
	}
</script>

<T.Group
	position={[planar.current.x, lift.current, planar.current.z]}
	rotation={[rotation[0], rotation[1] + wiggle.current, rotation[2]]}
	onpointerdown={handlePointerDown}
	onclick={handleClick}
	onpointerenter={() => setDeckHover(id)}
	onpointerleave={() => setDeckHover(null)}
>
	<Billboard>
		<Text
			fontSize={0.5}
			text={(cards ?? [])?.length?.toString() ?? '0'}
			position={[0, 1.75, 0]}
			anchorX="center"
		/>
	</Billboard>
	{#if cards?.length > 0}
		{#key displayedImage}
			<T.Mesh castShadow receiveShadow rotation.x={-Math.PI / 2} position.y={height / 2 + 0.01}>
				<T.PlaneGeometry args={[1.4, 2]} />
				<ImageMaterial url={displayedImage} side={2} radius={0.1} opacity={isHovered ? 0.8 : 1} />
			</T.Mesh>
		{/key}
	{/if}

	<!-- PRELOAD THE NEXT DISCARD IMAGE -->
	{#if isFaceUp && cards.length > 1}
		{@const preloadUrl = resolveCardImage(cards[1]?.faceImageUrl, $sheetRefCache)}
		{#key preloadUrl}
			<T.Mesh>
				<T.PlaneGeometry args={[0, 0]} />
				<ImageMaterial url={preloadUrl} side={2} radius={0.1} opacity={0} />
			</T.Mesh>
		{/key}
	{/if}

	{#if isDropTarget}
		<T.Group rotation.x={-Math.PI / 2} position.y={height / 2 + 0.03}>
			<DropFootprint
				shape="rect"
				w={CARD_WIDTH + 0.3}
				h={CARD_HEIGHT + 0.3}
				color="#5ee7ff"
				fill={0.15}
				border={0.08}
				depthTest={false}
			/>
		</T.Group>
	{/if}

	<!-- deck body: rounded slab (matches the top image's corner radius) whose
	     sides wear the stacked-card-edge stripes. Unit-height shared geometry,
	     scaled to this deck's height; dispose={false} keeps one deck's unmount
	     from destroying the shared geometry for everyone. -->
	<T.Mesh scale.y={height} material={bodyMaterials}>
		<T is={deckBodyGeometry} attach="geometry" dispose={false} />
	</T.Mesh>
</T.Group>
