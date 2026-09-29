<script lang="ts">
	import { T } from '@threlte/core';
	import type { IntersectionEvent } from '@threlte/extras';
	import { Spring } from 'svelte/motion';
	import { untrack } from 'svelte';
	import {
		clearBagHover,
		dragStart,
		dragStore,
		isCarried,
		setBagHover
	} from './store/dragStore.svelte';
	import { isSelectClick, selectedIds, toggleSelected } from './store/selection';
	import SelectionRing from './SelectionRing.svelte';
	import HeldMark from './HeldMark.svelte';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { claimPointerDown, createSingleDispatchGuard } from '$lib/utils/single-hit-dispatch';
	import { armRadialPress, cancelRadialPress } from '$lib/radial/gesture';
	import { driveSpring } from '$lib/utils/frame-stall.svelte';
	import { Weight } from '$lib/utils/weight.svelte';
	import { WEIGHT_CARRY_EPSILON } from '$lib/utils/constants-weight';
	import { createCounterInput, DRAG_THRESHOLD_PX } from '$lib/utils/counter-input';
	import { setPieceHover, clearPieceHover } from '$lib/store/pieceUi';
	import { createDieInput } from '$lib/utils/die-input';
	import { createBagInput } from '$lib/utils/bag-input';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { nearestTurn } from '$lib/utils/yaw';
	import { SEAT_ROTATION_DEG } from '$lib/hud/players';
	import { placeholderSeat } from '$lib/compose/pack';
	import CounterDial from './CounterDial.svelte';
	import Die from './Die.svelte';
	import LabelBadge from './LabelBadge.svelte';
	import { toastLocked } from '$lib/hotkeys/lock';
	import { LOCK_BADGE_TEXT } from '$lib/utils/constants-lock';
	import Model from './models/Model.svelte';
	import PieceFace from './PieceFace.svelte';
	import DropFootprint from './drop/DropFootprint.svelte';
	import {
		BAG_HEIGHT,
		DIE_SIDES_DEFAULT,
		PIECE_CHIP_ROUGHNESS,
		PIECE_DEFAULT_RADIUS,
		PIECE_DRAG_Y,
		PIECE_RADIUS,
		PIECE_REST_Y,
		PIECE_THICKNESS
	} from '$lib/utils/constants-pieces';

	let { id }: { id: string } = $props();

	const piece = $derived($gameStore?.pieces?.[id]);
	const kind = $derived(piece?.kind ?? 'token');
	const radius = $derived(
		piece?.radius ?? (kind === 'die' ? PIECE_RADIUS.die : PIECE_DEFAULT_RADIUS)
	);
	const color = $derived(piece?.color ?? '#c8c4b8');

	// multi-state piece: the face is whichever state it is showing. `states[0]`
	// is the base face (see PackPieceDef.states), so `imageUrl` only applies to
	// a piece with no states at all.
	//
	// Never a die. States are alternate face *images*; a die's faces are
	// procedural geometry, so a hand-authored pack that puts `states` on one
	// must not give it a state name, or an image on top of the
	// numbers. The two concepts are orthogonal and this is where that is kept
	// true — `kind` decides the body, `states` only ever decorates the disc.
	const states = $derived(kind === 'die' ? [] : (piece?.states ?? []));
	const stateIndex = $derived(gameActions.currentPieceState(piece));
	const faceRef = $derived(states.length ? states[stateIndex]?.face : piece?.imageUrl);
	const imageUrl = $derived(resolveCardImage(faceRef, $sheetRefCache));
	// carried: grabbed, or riding along with a selected entity (tableplace-202)
	const isDragging = $derived(isCarried($dragStore, id));
	const isSelected = $derived($selectedIds.includes(id));
	let isHovered = $state(false);

	// a bag under the pointer mid-drag swallows the drop, so it has to be the
	// cue — the DropIndicator suppresses its table footprint while hovered
	const isBagDropTarget = $derived(
		kind === 'bag' && $dragStore.isBagHovered === id && !!$dragStore.isDragging && !isDragging
	);

	const THICKNESS = PIECE_THICKNESS;
	const REST_Y = PIECE_REST_Y;

	const height = new Spring(piece?.position?.[1] ?? REST_Y, {
		stiffness: 0.28,
		damping: 0.7,
		precision: 0.0001
	});

	// Entirely derived from this piece's own drag ownership and store state —
	// see the matching comment on Card's height effect — so a piece that
	// starts a drag it never actually wins can't stay stuck airborne.
	//
	// driveSpring, not `height.target =`, so a starved frame loop lands the
	// piece at its store height at once instead of leaving it visibly airborne
	// over the tile it just landed on — where the next press aimed at it hits
	// the tile instead (tableplace-164).
	$effect(() => {
		driveSpring(height, isDragging ? PIECE_DRAG_Y : (piece?.position?.[1] ?? REST_Y));
	});

	// Horizontal glide: remote drags only arrive every ~200ms (network throttle),
	// so x/z spring toward the store position instead of teleporting between
	// ticks. Local drags snap instantly — a spring there reads as input lag.
	const planar = new Spring(
		{ x: piece?.position?.[0] ?? 0, z: piece?.position?.[2] ?? 0 },
		{ stiffness: 0.15, damping: 0.8, precision: 0.0001 }
	);

	$effect(() => {
		const [x = 0, , z = 0] = piece?.position ?? [];
		driveSpring(planar, { x, z }, isDragging);
	});

	// Weight (tableplace-203): a lean against the travel while carried — here
	// or, read off the store's carry height, by another player — and one small
	// bounce on landing. Render-only; see utils/weight.svelte.ts.
	const carried = $derived(
		isDragging || Math.abs((piece?.position?.[1] ?? REST_Y) - PIECE_DRAG_Y) < WEIGHT_CARRY_EPSILON
	);
	const weight = new Weight('piece', () => ({
		x: planar.current.x,
		z: planar.current.z,
		y: height.current,
		rest: height.target,
		carried
	}));
	$effect(() => {
		if (carried) weight.wake();
	});
	$effect(() => () => weight.stop());

	const position: [number, number, number] = $derived([
		planar.current.x,
		height.current + weight.lift,
		planar.current.z
	]);

	/**
	 * The piece's table yaw, rendered at last: `rotation[1]` in degrees (the
	 * convention applySnapRotation documents), drawn with the same sign as a
	 * card's yaw (`Card.svelte` renders `-rotation[2]`) so a piece and a card
	 * caught by the same yawed grid cell line up with the drawn cell. This
	 * binding is what makes snap-written rotations — and R/T on a model —
	 * visible; it was previously stored and synced but never applied.
	 *
	 * Sprung through the shortest arc (tableplace-200): the stored yaw wraps
	 * into [0, 360), so 315° + 45° is 0° and must turn on to 360°, not spin
	 * back. The next target is measured from the last one, read untracked —
	 * the effect writes it.
	 */
	const yawSpring = new Spring(
		untrack(() => piece?.rotation?.[1] ?? 0),
		{
			stiffness: 0.15,
			damping: 0.8,
			precision: 0.01
		}
	);
	$effect(() => {
		const stored = piece?.rotation?.[1] ?? 0;
		const heading = untrack(() => yawSpring.target);
		driveSpring(yawSpring, nearestTurn(heading, stored));
	});
	const yaw = $derived(-(yawSpring.current * DEG2RAD));

	let pendingDrag: { x: number; y: number } | null = null;
	let dragMoved = false;

	function liftIntoDrag() {
		// pinned: a click still counts / rolls / draws, but the piece stays put
		// and the toast names the key that frees it
		if (piece?.locked) return toastLocked();
		// origin (pre-lift store position) is what Esc returns the piece to
		dragStart(id, position[1], piece?.position as [number, number, number] | undefined);
	}

	// Every piece defers the lift until the pointer actually travels — the
	// same as a card — so a press that holds still can become the radial wheel,
	// and a plain click on a counter / die / bag acts without picking the piece
	// up and dropping it. Still draggable: the first travel lifts.
	function onPendingMove(ne: PointerEvent) {
		if (!pendingDrag) return;
		if (Math.hypot(ne.clientX - pendingDrag.x, ne.clientY - pendingDrag.y) < DRAG_THRESHOLD_PX)
			return;
		cancelPendingDrag();
		dragMoved = true;
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

	// the wheel took the press: nothing is lifted, and the release that closes
	// a held wheel must not also land as a click (a counter's −1, a roll, a draw)
	function yieldToWheel() {
		cancelPendingDrag();
		dragMoved = true;
	}

	// the right press has to reach exactly one piece in a pile, same as the
	// drag does — but WITHOUT stopping the native event, so a right drag still
	// pans the camera (see Card.svelte's matching guard)
	const claimRadialPress = createSingleDispatchGuard();

	function handlePointerDown(e: IntersectionEvent<PointerEvent>) {
		const target = { kind: 'piece', id } as const;
		// right press: a quick click or a still hold is the wheel, travel pans
		if (e.nativeEvent.button === 2) {
			if (claimRadialPress(e))
				armRadialPress({ target, event: e.nativeEvent, onOpen: yieldToWheel });
			return;
		}
		// claims the pointerdown for the topmost piece in a pile — see
		// claimPointerDown — so the rest of the stack never sees this event
		if (!claimPointerDown(e)) return;
		// Shift/Ctrl+click adds the piece to the selection or takes it out — only
		// Ctrl/Cmd on a counter, whose Shift+click counts up. `dragMoved` makes
		// the click that follows do nothing (no count, roll or draw).
		if (isSelectClick(e.nativeEvent, kind === 'counter')) {
			dragMoved = true;
			if (piece?.locked) return toastLocked();
			toggleSelected(id);
			return;
		}
		dragMoved = false;
		pendingDrag = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
		// press-and-hold-still opens the wheel instead; the first travel past
		// the threshold cancels it and lifts the piece exactly as before
		armRadialPress({ target, event: e.nativeEvent, onOpen: yieldToWheel });
		window.addEventListener('pointermove', onPendingMove);
		window.addEventListener('pointerup', cancelPendingDrag);
	}

	// click / wheel on a counter. Lives in counter-input so the
	// one-step-per-input guarantee is unit-tested against Threlte's dispatch
	// loop — a counter group has 2-3 raycastable children and Threlte queues
	// the group once per child the ray pierces (tableplace-84).
	const counterInput = createCounterInput({
		id: () => id,
		isCounter: () => kind === 'counter',
		wasDrag: () => dragMoved,
		increment: gameActions.incrementCounter
	});

	// click-to-roll, and click-to-draw, guarded the same way and for the same
	// reason. Each input owns its own dispatch guard and bails out before
	// claiming when the piece is not its kind, so exactly one of the three ever
	// acts on a given click.
	const dieInput = createDieInput({
		id: () => id,
		isDie: () => kind === 'die',
		wasDrag: () => dragMoved,
		roll: gameActions.rollDie
	});

	const bagInput = createBagInput({
		id: () => id,
		isBag: () => kind === 'bag',
		wasDrag: () => dragMoved,
		draw: gameActions.drawFromBag
	});

	function handleClick(e: IntersectionEvent<MouseEvent>) {
		counterInput.onclick(e);
		dieInput.onclick(e);
		bagInput.onclick(e);
	}

	function handlePointerEnter() {
		isHovered = true;
		setPieceHover(id); // what the piece hotkeys act on
		// a bag under the pointer mid-drag is the drop target (see resolveDrop)
		if (kind === 'bag') setBagHover(id);
	}

	function handlePointerLeave() {
		isHovered = false;
		clearPieceHover(id);
		if (kind === 'bag') clearBagHover(id);
	}

	// a piece removed (or claimed into a new id) while the pointer is over it
	// would otherwise leave stale hover state behind — for the X hotkey to act
	// on, or for the next drop to find
	$effect(() => () => {
		clearPieceHover(id);
		clearBagHover(id);
	});

	/**
	 * A bag shows how much is LEFT, never what is in it — the count is public
	 * (you can see the bag is nearly empty), the contents are not. An infinite
	 * bag never runs down, so it shows ∞ instead of a number.
	 */
	const bagLabel = $derived.by(() => {
		const remaining = piece?.infinite ? '∞' : String((piece?.contents ?? []).length);
		// hovering names the bag, since its badge is otherwise just a number
		return isHovered && piece?.name ? `${piece.name} · ${remaining}` : remaining;
	});

	// a counter's base label is empty — its dial face prints name and value
	// (tableplace-191) — so a hovered locked counter wears just the lock pill
	const label = $derived.by(() => {
		const base = baseLabel();
		// a pinned piece says so on hover, in the badge it already wears
		return isHovered && piece?.locked
			? base
				? `${base} · ${LOCK_BADGE_TEXT}`
				: LOCK_BADGE_TEXT
			: base;
	});

	function baseLabel(): string {
		if (kind === 'bag') return bagLabel;
		if (kind === 'counter') return '';
		// name the face, not just the piece: with several states that is the only
		// on-table clue which one is showing
		const stateName = states.length > 1 ? states[stateIndex]?.name : undefined;
		const name = piece?.name ?? '';
		return stateName ? (name ? `${name} — ${stateName}` : stateName) : name;
	}

	const counterValue = $derived(piece?.value ?? piece?.maxValue ?? 0);

	/**
	 * The seat a counter's face reads from: its owner's (the player id in
	 * `piece:<owner>:…`, or a scenario's `seatN` placeholder), else seat 0.
	 * Returned as a yaw in the piece's own frame, so the text stays square to
	 * that seat however the piece itself has been turned.
	 */
	const dialFacing = $derived.by(() => {
		if (kind !== 'counter') return 0;
		const owner = id.split(':')[1] ?? '';
		const seat = placeholderSeat(owner) ?? $gameStore?.players?.[owner]?.seat ?? 0;
		return (SEAT_ROTATION_DEG[seat] ?? 0) * DEG2RAD - yaw;
	});

	// pulse the dial once when the value changes (local or remote) so it's noticed
	const valuePulse = new Spring(1, { stiffness: 0.15, damping: 0.5, precision: 0.001 });
	let prevValue: number | undefined = undefined;
	$effect(() => {
		const v = piece?.value;
		if (prevValue !== undefined && v !== undefined && v !== prevValue) {
			valuePulse.set(1.18, { instant: true });
			valuePulse.target = 1;
		}
		prevValue = v;
	});
</script>

{#if piece}
	<!-- the store id, mirrored onto the object3D: what makes an entity findable in
	     the scene graph — by devtools, and by the headless harness, which has to
	     know where a thing actually draws in order to click it -->
	<!-- the lean rides on its own group, in the world frame, so it tips the
	     piece against its travel whatever way the piece itself is turned -->
	<T.Group {position} rotation.x={weight.tiltX} rotation.z={weight.tiltZ}>
		<T.Group
			name={id}
			rotation.y={yaw}
			onpointerdown={handlePointerDown}
			onclick={handleClick}
			onwheel={counterInput.onwheel}
			onpointerenter={handlePointerEnter}
			onpointerleave={handlePointerLeave}
		>
			{#if kind === 'die'}
				<Die
					sides={piece.sides ?? DIE_SIDES_DEFAULT}
					value={piece.value ?? 1}
					rollSeq={piece.rollSeq ?? 0}
					{radius}
					{color}
				/>
			{:else if kind === 'model'}
				<!-- catalog GLB (or its placeholder box) — geometry only; this group
			     already owns the drag, the yaw and the store id -->
				<Model {id} modelRef={piece.model} {radius} />
			{:else if kind === 'bag'}
				<!-- procedural pouch: tapered body, tie ring, gathered neck. Sized off
			     the same `radius` every other piece uses, so a bag drawn at the
			     default radius reads as bigger than the tokens it holds. -->
				<T.Mesh castShadow position.y={BAG_HEIGHT * 0.36}>
					<T.CylinderGeometry args={[radius * 0.66, radius, BAG_HEIGHT * 0.72, 24]} />
					<T.MeshStandardMaterial {color} roughness={0.85} />
				</T.Mesh>
				<T.Mesh castShadow position.y={BAG_HEIGHT * 0.72} rotation.x={Math.PI / 2}>
					<T.TorusGeometry args={[radius * 0.62, radius * 0.1, 10, 24]} />
					<T.MeshStandardMaterial color="#5b4a36" roughness={0.7} />
				</T.Mesh>
				<T.Mesh castShadow position.y={BAG_HEIGHT * 0.85}>
					<T.CylinderGeometry args={[radius * 0.7, radius * 0.5, BAG_HEIGHT * 0.28, 20]} />
					<T.MeshStandardMaterial {color} roughness={0.85} />
				</T.Mesh>
				{#if imageUrl}
					<!-- same decal treatment as a token, laid on the neck opening -->
					<PieceFace
						url={imageUrl}
						radius={radius * 0.46}
						segments={24}
						position={[0, BAG_HEIGHT * 0.99, 0]}
					/>
				{/if}
				{#if isBagDropTarget}
					<T.Group rotation.x={-Math.PI / 2} position.y={-THICKNESS / 2 + 0.005}>
						<DropFootprint
							shape="circle"
							r={radius + 0.25}
							color="#5ee7ff"
							fill={0.15}
							border={0.08}
							depthTest={false}
						/>
					</T.Group>
				{/if}
			{:else if kind === 'pawn'}
				<!-- procedural pawn: base disc + stem + head -->
				<T.Mesh castShadow position.y={0.06}>
					<T.CylinderGeometry args={[radius * 0.5, radius * 0.6, 0.12, 24]} />
					<T.MeshStandardMaterial {color} roughness={PIECE_CHIP_ROUGHNESS} />
				</T.Mesh>
				<T.Mesh castShadow position.y={0.45}>
					<T.CylinderGeometry args={[radius * 0.16, radius * 0.3, 0.75, 16]} />
					<T.MeshStandardMaterial {color} roughness={PIECE_CHIP_ROUGHNESS} />
				</T.Mesh>
				<T.Mesh castShadow position.y={0.95}>
					<T.SphereGeometry args={[radius * 0.32, 20, 16]} />
					<T.MeshStandardMaterial {color} roughness={PIECE_CHIP_ROUGHNESS} />
				</T.Mesh>
			{:else}
				<!-- token / counter: flat disc, image or color on top -->
				<T.Mesh castShadow>
					<T.CylinderGeometry args={[radius, radius, THICKNESS, 36]} />
					<T.MeshStandardMaterial {color} roughness={PIECE_CHIP_ROUGHNESS} />
				</T.Mesh>
				{#if imageUrl}
					<!-- a counter's image (dial art from an import) is its face background -->
					<PieceFace
						url={imageUrl}
						radius={radius * 0.96}
						position={[0, THICKNESS / 2 + 0.002, 0]}
					/>
				{/if}
				{#if kind === 'counter'}
					<CounterDial
						name={piece.name ?? ''}
						value={counterValue}
						maxValue={piece.maxValue}
						overImage={!!imageUrl}
						radius={radius * 0.97}
						y={THICKNESS / 2 + 0.004}
						facing={dialFacing}
						scale={valuePulse.current}
					/>
				{/if}
			{/if}

			<!-- a bag's remaining count is always on: it's the only thing about a bag
		     that is legible from across the table -->
			{#if label && (kind === 'bag' || isHovered)}
				<LabelBadge
					text={label}
					fontSize={kind === 'bag' ? 0.45 : 0.35}
					position={[
						0,
						kind === 'pawn'
							? 1.5
							: kind === 'bag'
								? BAG_HEIGHT + 0.45
								: kind === 'model'
									? 2.4
									: 0.75,
						0
					]}
				/>
			{/if}
		</T.Group>
	</T.Group>
{/if}

<!-- the box selection's ring (tableplace-202), at the piece's foot. Outside its
     group: a child would be raycast as part of the piece and widen its grab. -->
{#if piece && isSelected}
	<SelectionRing
		shape="circle"
		r={radius}
		position={[position[0], position[1] - THICKNESS / 2 + 0.01, position[2]]}
	/>
{/if}

<!-- held-by (tableplace-199): another player is carrying this piece -->
{#if piece}
	<HeldMark
		{id}
		heldBy={piece.heldBy}
		shape="circle"
		r={radius}
		position={[position[0], position[1] - THICKNESS / 2 + 0.01, position[2]]}
	/>
{/if}
