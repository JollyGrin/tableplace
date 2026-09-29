<script lang="ts">
	import { T } from '@threlte/core';
	import * as THREE from 'three';
	import { clearHover, dragStart, dragStore, isCarried, setHover } from './store/dragStore.svelte';
	import { isSelectClick, selectedIds, toggleSelected } from './store/selection';
	import SelectionRing from './SelectionRing.svelte';
	import { Spring } from 'svelte/motion';
	import { untrack } from 'svelte';
	import { ImageMaterial } from '@threlte/extras';
	import type { IntersectionEvent } from '@threlte/extras';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { degrees } from '$lib/utils/constants-rotation';
	import { nearestTurn } from '$lib/utils/yaw';
	import { gameStore } from './store/game/gameStore.svelte';
	import type { GameDTO } from './store/game/types';
	import { gameActions } from './store/game/actions';
	import {
		CARD_WIDTH,
		CARD_HEIGHT,
		CARD_THICKNESS,
		CARD_REST_Y,
		CARD_DRAG_Y,
		CARD_PICK_COLOR,
		CARD_PICK_HALO,
		CARD_PICK_LIFT,
		cardBodyGeometry
	} from '$lib/utils/constants-cards';
	import { fanOffset } from '$lib/utils/transforms/stacking';
	import { pickCard, pickedCard } from './store/cardPick';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { driveSpring } from '$lib/utils/frame-stall.svelte';
	import { claimPointerDown, createSingleDispatchGuard } from '$lib/utils/single-hit-dispatch';
	import { armRadialPress, cancelRadialPress } from '$lib/radial/gesture';
	import { toastLocked } from '$lib/hotkeys/lock';
	import LabelBadge from './LabelBadge.svelte';
	import {
		LOCK_BADGE_FONT_SIZE,
		LOCK_BADGE_LIFT_CARD,
		LOCK_BADGE_TEXT
	} from '$lib/utils/constants-lock';
	type Vec3Array = [number, number, number];

	let { id }: { id: string } = $props();

	let card: THREE.Mesh | undefined = $state();
	const initCardState: GameDTO['cards'][string] = {
		faceImageUrl: '',
		backImageUrl: '',
		position: [0, 0, 0],
		rotation: [0, 0, 0]
	};

	// in the pointer's hand — the card grabbed, or one carried along with it
	// as part of a selection (tableplace-202); either way it floats and tracks
	const isDragging = $derived(isCarried($dragStore, id));
	const isSelected = $derived($selectedIds.includes(id));
	const cardState = $derived($gameStore?.cards?.[id] ?? initCardState);
	const faceImageUrl = $derived(resolveCardImage(cardState?.faceImageUrl, $sheetRefCache));
	const backImageUrl = $derived(resolveCardImage(cardState?.backImageUrl, $sheetRefCache));
	let isHovered = $state(false);
	let emissiveIntensity = $state(0);

	/**
	 * This card is the one the /create pane is editing. Nothing registers a
	 * selection anywhere else, so `isPicked` is permanently false at /play and
	 * /setup and the marker below never mounts there.
	 */
	const isPicked = $derived($pickedCard === id);

	// stiffer than the rotation spring so the card is already airborne when the flip starts
	const height = new Spring((cardState?.position as Vec3Array)?.[1] ?? CARD_REST_Y, {
		stiffness: 0.28,
		damping: 0.7,
		precision: 0.0001
	});

	// Single source of truth for height: entirely derived from this card's own
	// drag ownership and store state, so nothing outside this effect ever
	// writes height.target. That makes an orphaned card impossible — even a
	// handler that misfires and starts a drag this card never actually wins
	// (dragStore.isDragging goes to some other id) leaves isDragging false
	// here, so this effect keeps settling it at restY instead of leaving
	// whatever height a stray handler last poked it to.
	// While dragging: brief overshoot bounce, then settle on CARD_DRAG_Y — the
	// same height the store records mid-drag, so the drop indicator's
	// connector meets the card. Otherwise: stays lifted while a flip is
	// mid-rotation (so the card can't clip the table), settles to the store's
	// stack height once the rotation completes.
	//
	// Every target goes through driveSpring so a starved frame loop puts the
	// card at its store height at once: a card still visibly airborne over the
	// pile it just landed in is a card the next press cannot grab
	// (tableplace-164).
	$effect(() => {
		if (isDragging) {
			driveSpring(height, CARD_DRAG_Y + 0.2);
			const handle = setTimeout(() => driveSpring(height, CARD_DRAG_Y), 150);
			return () => clearTimeout(handle);
		}
		const flipping = Math.abs(rotation.current - rotation.target) > 2;
		// the editor's selection lift rides on top of the store's rest height,
		// and only here: the store keeps the squared-up resting position, same
		// as the hover fan
		const restY = (cardState?.position?.[1] ?? CARD_REST_Y) + (isPicked ? CARD_PICK_LIFT : 0);
		driveSpring(height, flipping ? Math.max(1.5, restY) : restY);
	});

	const rotation = new Spring((cardState?.rotation as Vec3Array)?.[0] ?? 0, {
		stiffness: 0.1,
		damping: 0.8,
		precision: 0.001
	});

	const seatRotation = $derived(degrees[gameActions.getMySeat()] / DEG2RAD);
	const rotationTap = new Spring(-seatRotation, {
		stiffness: 0.1,
		damping: 0.8,
		precision: 0.001
	});

	// Get base position from store
	const basePosition = $derived(cardState?.position ?? [0, 0, 0]);
	const baseRotation = $derived(cardState?.rotation ?? [0, 0, 0]);

	// Landscape cards rest a quarter turn round: a render-only yaw on top of the
	// tap spring, never written into rotation[2] — tapCard is additive there and
	// the snap/group logic reads a squared-up yaw as z % 180 == 0, so the store
	// stays orientation-relative and tapping a landscape card stands it upright.
	const orientationYaw = $derived(cardState?.orientation === 'landscape' ? 90 : 0);

	// 180 on x = facedown (flipCard convention). The face plane stays mounted so
	// its texture never unloads, but is not rendered — no peeking under the card.
	// Asymmetric on purpose: flipping DOWN keeps the face until the spring passes
	// 90° (edge-on, so the hide is invisible); flipping UP shows it immediately
	// so the art is there for the whole reveal.
	const isFacedown = $derived(baseRotation[0] === 180 && rotation.current > 90);

	// Horizontal glide: remote drags only arrive every ~200ms (network throttle),
	// so x/z spring toward the store position instead of teleporting between
	// ticks. Local drags snap instantly — a spring there reads as input lag.
	const planar = new Spring(
		{
			x: (cardState?.position as Vec3Array)?.[0] ?? 0,
			z: (cardState?.position as Vec3Array)?.[2] ?? 0
		},
		{ stiffness: 0.15, damping: 0.8, precision: 0.0001 }
	);

	// Hover fan: while the pointer is on any member of a multi-card loose pile,
	// every member cascades up-screen from the top card so its title band
	// shows — the membership preview for `G`, and what tells a loose pile
	// apart from a deck. Purely a render offset: the store keeps the squared-up
	// rest positions, so nothing here touches shared state.
	const fanIndex = $derived($dragStore.hoveredStack?.indexOf(id) ?? -1);
	const fanShift = $derived(
		fanIndex < 0
			? ([0, 0] as [number, number])
			: fanOffset(
					fanIndex,
					$dragStore.hoveredStack?.length ?? 0,
					// ?? 0: a yaw of undefined would land the card at NaN and fling it
					// off the table — a fan is never worth that
					degrees[gameActions.getMySeat()] ?? 0
				)
	);

	$effect(() => {
		const [x = 0, , z = 0] = cardState?.position ?? [];
		const [fanX, fanZ] = fanShift;
		if (isDragging) driveSpring(planar, { x, z }, true);
		else driveSpring(planar, { x: x + fanX, z: z + fanZ });
	});

	// Create derived values for each component
	const posX = $derived(planar.current.x);
	const posY = $derived(height.current);
	const posZ = $derived(planar.current.z);

	// Combine components into position array
	const position: [number, number, number] = $derived([posX, posY, posZ]);

	// Make card glow when hovered
	$effect(() => {
		emissiveIntensity = isHovered ? 0.1 : 0;
	});

	// Flip / tap rotation targets. The yaw heads for the stored value's nearest
	// equivalent, so a turn takes the shortest arc (tableplace-200) — a Q/E
	// turn wraps the stored yaw into one turn, and a snap writes it absolute.
	// Measured from the spring's last target, read untracked: this effect
	// writes that target, so it must never depend on it.
	$effect(() => {
		driveSpring(rotation, baseRotation[0]);
		const heading = untrack(() => rotationTap.target);
		driveSpring(rotationTap, nearestTurn(heading, baseRotation[2]));
	});

	// px the pointer may travel between down and up and still count as a click
	const DRAG_THRESHOLD_PX = 5;
	let pendingDrag: { x: number; y: number } | null = null;

	function liftIntoDrag() {
		// pinned: the press still claimed the pile (nothing under it moves either),
		// but the card stays put and the toast names the key that frees it
		if (cardState?.locked) return toastLocked();
		// origin is the store position from before the lift, so Esc can put the
		// card back exactly where it was
		dragStart(id, position[1], (cardState?.position as Vec3Array) ?? undefined);
	}

	// Defer the lift until the pointer actually travels: a plain click used to
	// pick the card up and drop it again under the cursor, nudging it for no
	// reason. Same threshold the counter piece uses.
	function onPendingMove(ne: PointerEvent) {
		if (!pendingDrag) return;
		if (Math.hypot(ne.clientX - pendingDrag.x, ne.clientY - pendingDrag.y) < DRAG_THRESHOLD_PX)
			return;
		cancelPendingDrag();
		// this travel is the drag, whichever listener saw it first — the wheel
		// must not still be counting down behind it
		cancelRadialPress();
		liftIntoDrag();
	}

	function cancelPendingDrag() {
		pendingDrag = null;
		window.removeEventListener('pointermove', onPendingMove);
		window.removeEventListener('pointerup', cancelPendingDrag);
	}

	$effect(() => cancelPendingDrag);

	// the radial menu's right-press has to reach exactly one card in a pile,
	// same as the drag does — but WITHOUT stopping the native event, so a right
	// drag still pans the camera (see claimPointerDown for why the left button
	// stops it immediately and this does not)
	const claimRadialPress = createSingleDispatchGuard();

	function handleDragStart(e: IntersectionEvent<PointerEvent>) {
		// right press: hold still for the wheel, travel for a camera pan
		if (e.nativeEvent.button === 2) {
			if (claimRadialPress(e))
				armRadialPress({ target: { kind: 'card', id }, event: e.nativeEvent });
			return;
		}
		// claims the pointerdown for the topmost card in a pile — see
		// claimPointerDown — so the rest of the stack never sees this event
		if (!claimPointerDown(e)) return;
		// Shift/Ctrl+click adds this card to the selection, or takes it out —
		// a press that neither drags nor opens the wheel
		if (isSelectClick(e.nativeEvent)) {
			if (cardState?.locked) return toastLocked();
			toggleSelected(id);
			return;
		}
		pendingDrag = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
		// press-and-hold-still opens the wheel instead; the FIRST travel past the
		// threshold cancels it (in the gesture's own move listener) and this drag
		// proceeds exactly as it always has
		armRadialPress({
			target: { kind: 'card', id },
			event: e.nativeEvent,
			onOpen: cancelPendingDrag
		});
		window.addEventListener('pointermove', onPendingMove);
		window.addEventListener('pointerup', cancelPendingDrag);
	}

	// A click that never became a drag. Inert unless something registered a
	// handler (only /create does — see store/cardPick.ts).
	function handleClick(e: IntersectionEvent<MouseEvent>) {
		if (e.delta > DRAG_THRESHOLD_PX) return; // was a drag, not a click
		// threlte dispatches click to every hit near → far, same as pointerdown
		// (see claimPointerDown): stop here so overlapping cards pick the topmost
		// rather than whichever happened to be furthest. Not
		// stopImmediatePropagation — the native click is nobody else's problem.
		e.stopPropagation();
		pickCard(id);
	}

	function handlePointerEnter() {
		if (!!$dragStore.isDragging) return;
		isHovered = true;
		// via the store action, not a direct write: it also collects the loose
		// stack this card belongs to, which is what fans
		setHover(id);
	}

	function handlePointerLeave() {
		isHovered = false;
		clearHover(id);
	}
</script>

<!-- the store id, mirrored onto the object3D: what makes an entity findable in
     the scene graph — by devtools, and by the headless harness, which has to
     know where a thing actually draws in order to click it -->
<T.Group
	name={id}
	{position}
	rotation.z={rotation.current * DEG2RAD}
	rotation.y={(rotationTap.current + orientationYaw) * -DEG2RAD}
	onpointerdown={handleDragStart}
	onpointerleave={handlePointerLeave}
	onpointerenter={handlePointerEnter}
	onclick={handleClick}
>
	<!-- card body: visible paper edge between the two faces (unlit so side faces
	     never go black). Rounded to match the face's corner radius — a square box
	     pokes white nubs past the ImageMaterial's alpha-cutout arc. The geometry
	     is shared across all cards: dispose={false} keeps one card's unmount from
	     destroying it for everyone. -->
	<T.Mesh castShadow>
		<T is={cardBodyGeometry} attach="geometry" dispose={false} />
		<T.MeshBasicMaterial color="#d9d6c9" />
	</T.Mesh>
	<!-- key the MESH, not the material: threlte 8.5 material swaps on a live
	     mesh detach without reattaching (same bug as the felt table), leaving
	     the default white material. Mesh recreation attaches cleanly. -->
	{#key faceImageUrl}
		<T.Mesh
			castShadow
			receiveShadow
			bind:ref={card}
			visible={!isFacedown}
			rotation.x={-Math.PI / 2}
			position.y={CARD_THICKNESS / 2}
		>
			<T.PlaneGeometry args={[CARD_WIDTH, CARD_HEIGHT]} />
			<ImageMaterial
				url={faceImageUrl ?? ''}
				side={0}
				radius={0.1}
				monochromeColor={'#fff'}
				monochromeStrength={emissiveIntensity}
			/>
		</T.Mesh>
	{/key}

	{#if backImageUrl}
		<!-- rotation.z compensates the width-axis flip so directional backs read upright -->
		{#key backImageUrl}
			<T.Mesh
				castShadow
				receiveShadow
				rotation.x={-DEG2RAD * 270}
				rotation.z={Math.PI}
				position.y={-CARD_THICKNESS / 2}
			>
				<T.PlaneGeometry args={[CARD_WIDTH, CARD_HEIGHT]} />
				<ImageMaterial
					url={backImageUrl}
					side={0}
					radius={0.1}
					monochromeColor={'#fff'}
					monochromeStrength={emissiveIntensity}
				/>
			</T.Mesh>
		{/key}
	{:else}
		<T.Mesh rotation.x={Math.PI / 2} position.y={-CARD_THICKNESS / 2}>
			<T.PlaneGeometry args={[CARD_WIDTH, CARD_HEIGHT]} />
			<T.MeshBasicMaterial color="white" />
		</T.Mesh>
	{/if}
</T.Group>

{#if isHovered && cardState?.locked}
	<!-- the pin's hover mark: outside the card's group so a flip never turns it -->
	<LabelBadge
		text={LOCK_BADGE_TEXT}
		fontSize={LOCK_BADGE_FONT_SIZE}
		position={[posX, posY + LOCK_BADGE_LIFT_CARD, posZ]}
	/>
{/if}

{#if isSelected}
	<!-- the selection ring: at the card's own height, turned with its tap and
	     never with its flip, so it follows the card through a group drag -->
	<SelectionRing
		shape="rect"
		w={CARD_WIDTH}
		h={CARD_HEIGHT}
		position={[posX, posY - CARD_THICKNESS / 2, posZ]}
		yaw={(rotationTap.current + orientationYaw) * -DEG2RAD}
	/>
{/if}

{#if isPicked}
	<!--
		The selection pad, drawn at the height the card RESTS at with the card
		floating over it, so it reads as a marked slot rather than as a second
		card. Its OWN group, outside the one above: a child of that group would
		inherit the flip rotation and swing over the face the moment the card was
		turned over. The tap yaw it does follow, so the pad stays square to a
		tapped card. No pointer handlers, so threlte's dispatch never sees it.
	-->
	<T.Group
		name="pick:{id}"
		position={[posX, basePosition[1], posZ]}
		rotation.y={(rotationTap.current + orientationYaw) * -DEG2RAD}
	>
		<T.Mesh rotation.x={-Math.PI / 2}>
			<T.PlaneGeometry args={[CARD_WIDTH + CARD_PICK_HALO * 2, CARD_HEIGHT + CARD_PICK_HALO * 2]} />
			<T.MeshBasicMaterial color={CARD_PICK_COLOR} transparent opacity={0.85} />
		</T.Mesh>
	</T.Group>
{/if}
