<script lang="ts">
	import * as THREE from 'three';
	import { T } from '@threlte/core';
	import { ImageMaterial } from '@threlte/extras';
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
	import { driveSpring } from '$lib/utils/frame-stall.svelte';
	import { claimPointerDown, createSingleDispatchGuard } from '$lib/utils/single-hit-dispatch';
	import { DRAG_THRESHOLD_PX } from '$lib/utils/counter-input';
	import { armRadialPress, cancelRadialPress } from '$lib/radial/gesture';
	import { drawHoveredDeckToHand } from '$lib/hotkeys/draw';
	import { tableFeatures } from '$lib/store/tableFeatures';
	import DropFootprint from './drop/DropFootprint.svelte';
	import LabelBadge from './LabelBadge.svelte';
	import { selectedDeckId, DECK_SELECT_COLOR } from '$lib/store/deckSelection';

	// No interactivity() here on purpose. It calls setContext, so a per-deck call
	// would shadow TableScene's context — the handlers below would raycast with
	// the default compute instead of TableScene's (no intersectionPoint, no
	// table-plane fallback) and stopPropagation could never reach a card. They
	// register into TableScene's one context instead.
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
	// the scenario editor's "you are positioning THIS one" outline — set only by
	// /setup's pane, so it never draws in /play (see store/deckSelection)
	const isSelected = $derived(id === $selectedDeckId);
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
	// driveSpring: on a starved frame loop the pile lands at its store height at
	// once rather than gliding down through the pointer that is about to press
	// on it (tableplace-164)
	$effect(() => {
		driveSpring(lift, isDragged ? CARD_DRAG_Y : (deck.position?.[1] ?? 0));
	});

	const planar = new Spring(
		{ x: position[0] ?? 0, z: position[2] ?? 0 },
		{ stiffness: 0.15, damping: 0.8, precision: 0.0001 }
	);
	$effect(() => {
		const [x = 0, , z = 0] = deck.position ?? [];
		driveSpring(planar, { x, z }, isDragged);
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

	let pendingDrag: { x: number; y: number; t: number } | null = null;
	// A gesture that stopped being a tap must do NOTHING extra on release:
	// threlte's click fires on pointerdown+pointerup DISPLACEMENT (e.delta),
	// not path length, so both a long press that never travelled AND a drag
	// that wandered and released back over its own start pixel (drawing a
	// card off the top and dropping it back on the pile does exactly this)
	// would otherwise read as a tap and draw a card nobody asked for.
	let suppressClick = false;

	/**
	 * What a press on a deck becomes (tableplace-161's revision of -103):
	 *  - travel → draw the top card INTO the drag. The card spawns under the
	 *    pointer and dragStart hands it the in-flight gesture (the pipeline is
	 *    store-driven — TableScene streams position to whatever id isDragging —
	 *    so ownership transfer is just the id swap). ALWAYS, however long the
	 *    press sat still first: dragging a deck means drawing off it.
	 *  - hold still → the wheel (armed in handlePointerDown)
	 *  - release without travel → the click handler draws 1 into your hand
	 *    (Shift: onto the felt)
	 *
	 * Moving the whole pile is no longer a drag at all — it is the wheel's
	 * "Move pile" wedge, which carries the pile to the next click (drop/grab.ts).
	 * The hold-then-travel arm, its amber cue and the event-time draw-vs-move
	 * decision are all gone with it; there is nothing left to disambiguate.
	 */
	function onPendingMove(ne: PointerEvent) {
		if (!pendingDrag) return;
		if (Math.hypot(ne.clientX - pendingDrag.x, ne.clientY - pendingDrag.y) < DRAG_THRESHOLD_PX)
			return;
		// past the threshold this is a drag, whatever pixel it ends on — the
		// click that follows the eventual release must not also draw
		suppressClick = true;
		cancelPendingDrag();
		// travel means draw, never the wheel
		cancelRadialPress();
		// the last raycast already put the pointer's table point in the store,
		// so the card materialises exactly under the cursor at drag height.
		// An empty deck simply has nothing to draw — the wheel moves that pile.
		const point = $dragStore.intersectionPoint;
		const cardId = gameActions.drawIntoDrag(id, point ? [point.x, point.z] : undefined);
		// no origin: a card drawn out of a deck has no table position for Esc
		// to return to — cancel settles it where it floats (see cancelActiveDrag)
		if (cardId) dragStart(cardId, CARD_DRAG_Y);
	}

	// touch: the browser answers a long press with its context menu (and some
	// platforms with a text-selection callout); while a deck gesture is live
	// that press belongs to the table
	function blockContextMenu(e: Event) {
		e.preventDefault();
	}

	function cancelPendingDrag() {
		pendingDrag = null;
		window.removeEventListener('pointermove', onPendingMove);
		window.removeEventListener('pointerup', cancelPendingDrag);
		window.removeEventListener('pointercancel', cancelPendingDrag);
		window.removeEventListener('contextmenu', blockContextMenu);
	}

	$effect(() => cancelPendingDrag);

	// one wheel per right press, on the nearest entity only — and without
	// stopping the native event, so a right DRAG still pans the camera
	const claimRadialPress = createSingleDispatchGuard();

	function handlePointerDown(e: IntersectionEvent<PointerEvent>) {
		// right press: hold still for the wheel, travel for a camera pan
		if (e.nativeEvent.button === 2) {
			if (claimRadialPress(e))
				armRadialPress({ target: { kind: 'deck', id }, event: e.nativeEvent });
			return;
		}
		// claims the pointerdown ahead of anything behind the deck — see
		// claimPointerDown — and locks OrbitControls out of the gesture
		if (!claimPointerDown(e)) return;
		// A click that PLACES a carried pile must not also draw off it: the
		// pile is under the pointer by definition at that moment
		suppressClick = $dragStore.isDragging === id;
		// the left hold is the wheel's, at the same beat as every other entity
		armRadialPress({
			target: { kind: 'deck', id },
			event: e.nativeEvent,
			onOpen: () => {
				cancelPendingDrag();
				suppressClick = true; // the release belongs to the wheel, not to a draw
			}
		});
		pendingDrag = {
			x: e.nativeEvent.clientX,
			y: e.nativeEvent.clientY,
			t: e.nativeEvent.timeStamp
		};
		window.addEventListener('pointermove', onPendingMove);
		window.addEventListener('pointerup', cancelPendingDrag);
		// touch long-press can end in pointercancel when the browser reclaims
		// the gesture — clean up the same way a release would
		window.addEventListener('pointercancel', cancelPendingDrag);
		window.addEventListener('contextmenu', blockContextMenu);
	}

	// a press that never travelled: the draw — one card off the top into your
	// hand, or with Shift onto the felt in front of the deck (the old default,
	// kept for games that deal face-down to the table) — unless it was a long
	// press, which draws nothing
	function handleClick(e: IntersectionEvent<MouseEvent>) {
		if (e.delta > DRAG_THRESHOLD_PX) return; // was a drag, not a click
		e.stopPropagation();
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		if (e.nativeEvent.shiftKey || !$tableFeatures.drawToHand) gameActions.drawFromTop(id);
		else drawHoveredDeckToHand(id);
	}
</script>

<!-- the store id, mirrored onto the object3D: what makes an entity findable in
     the scene graph — by devtools, and by the headless harness, which has to
     know where a thing actually draws in order to click it -->
<T.Group
	name={id}
	position={[planar.current.x, lift.current, planar.current.z]}
	rotation={[rotation[0], rotation[1] + wiggle.current, rotation[2]]}
	onpointerdown={handlePointerDown}
	onclick={handleClick}
	onpointerenter={() => setDeckHover(id)}
	onpointerleave={() => setDeckHover(null)}
>
	<LabelBadge
		text={(cards ?? [])?.length?.toString() ?? '0'}
		fontSize={0.5}
		position={[0, 1.75, 0]}
	/>
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

	<!-- Editing outline: a hair wider than the drop footprint and drawn above
	     it, so a deck that is both selected and a drop target still reads as
	     both. depthTest={false} for the same reason the drop cue disables it —
	     at a low camera angle the deck's own body would swallow it. -->
	{#if isSelected}
		<T.Group rotation.x={-Math.PI / 2} position.y={height / 2 + 0.05}>
			<DropFootprint
				shape="rect"
				w={CARD_WIDTH + 0.5}
				h={CARD_HEIGHT + 0.5}
				color={DECK_SELECT_COLOR}
				fill={0.08}
				border={0.07}
				depthTest={false}
			/>
		</T.Group>
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
