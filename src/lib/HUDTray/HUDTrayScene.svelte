<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { T, useThrelte } from '@threlte/core';
	import { dragStore, setTrayHover } from '$lib/store/dragStore.svelte';
	import { useViewport, interactivity } from '@threlte/extras';
	import TrayCard from './TrayCard.svelte';
	import DropFootprint from '$lib/drop/DropFootprint.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { registerHud } from '$lib/dev/hud-registry';
	import { DRAG_THRESHOLD_PX } from '$lib/utils/counter-input';
	import {
		HAND_CARD_H,
		HAND_CARD_W,
		HAND_HOVER_SCALE,
		HAND_REST_SCALE,
		fanLayout,
		handOrderOf,
		hoverX,
		hoverY,
		moveInOrder,
		slotAt,
		type FanSlot
	} from '$lib/utils/hand';
	import { hoveredTrayCard } from './trayHover';
	import { handDropIndex, handGesture } from './handGesture';
	import { playFromHand, settlePlayFace } from './handPlay';

	/**
	 * The one interactivity() the HUD keeps, and the only one besides
	 * TableScene's (see #86). `<HUD>` calls createCameraContext(), so
	 * `useThrelte().camera` inside it resolves to the OrthographicCamera below,
	 * not the table camera — and a Raycaster is set from exactly one camera. The
	 * tray's meshes sit in that ortho camera's space, so a ray cast from the
	 * table's perspective camera would never hit them. Hence a second context,
	 * whose default compute picks up this camera.
	 *
	 * `<HUD>` does not create a DOM context, so `useDOM().dom` — interactivity's
	 * listener target — is still the shared canvas element. Only the camera is
	 * re-rooted, which is why this needs to be per HUD root and never per card.
	 * The tray background is the only mesh that listens: the cards overlap in
	 * the fan, so which one the pointer is on is worked out here, from the
	 * layout, topmost first (see `cardAt`).
	 */
	interactivity();

	const { renderer } = useThrelte();

	// the e2e harness hovers hand cards, so it needs this HUD's camera to aim
	if (import.meta.env.DEV) {
		const { camera, scene } = useThrelte();
		onMount(() => registerHud('tray', { camera: () => camera.current, scene: () => scene }));
	}

	const viewport = useViewport();

	const trayWidth = $derived($viewport.width / 1);
	const trayHeight = $derived($viewport.height / 6); // Adjust height as needed
	const trayX = $derived(-$viewport.width / 2 + trayWidth / 2);
	const trayY = $derived(-$viewport.height / 2 + trayHeight / 2);

	const isDropTarget = $derived($dragStore.isTrayHovered && !!$dragStore.isDragging);

	const myPlayerId = $derived(gameActions?.getMe()?.id ?? '');
	const tray = $derived($gameStore?.players?.[myPlayerId]?.tray);
	/** the hand, left to right, as it is stored */
	const order = $derived(handOrderOf(tray));

	/**
	 * The hand as it is drawn: the stored order, with the card being dragged
	 * along the fan moved to where it would land, or a gap where a carried
	 * table card would go in. Local only — nothing is sent until the release.
	 */
	const GAP = '\u0000drop';
	const shown = $derived.by(() => {
		if ($handGesture?.reordering) return moveInOrder(order, $handGesture.id, $handGesture.index);
		if (isDropTarget && $handDropIndex !== null) return moveInOrder(order, GAP, $handDropIndex);
		return order;
	});
	const landscapeOf = (id: string) => tray?.[id]?.orientation === 'landscape';
	const slots = $derived(fanLayout(shown.map(landscapeOf), trayWidth, trayHeight));
	const slotOf = $derived(new Map(shown.map((id, i) => [id, slots[i]!] as const)));

	type Pose = FanSlot & { scale: number; z: number };

	/** where each card is drawn right now: its slot, raised when hovered, under the pointer when held */
	const poses = $derived.by(() => {
		const held = $handGesture?.reordering ? $handGesture : null;
		// hover shows nothing while a card is carried, so the gap stays in view
		const hovered = held || $dragStore.isDragging ? null : $hoveredTrayCard;
		const out = new Map<string, Pose>();
		shown.forEach((id, i) => {
			const slot = slots[i]!;
			const landscape = landscapeOf(id);
			if (held?.id === id) {
				out.set(id, {
					x: held.x,
					y: slot.y + 0.3,
					angle: 0,
					scale: HAND_REST_SCALE * 1.12,
					z: shown.length + 2
				});
			} else if (hovered === id) {
				out.set(id, {
					x: hoverX(slot.x, landscape, trayWidth),
					y: hoverY(landscape, trayHeight),
					angle: 0,
					scale: HAND_HOVER_SCALE,
					z: shown.length + 1
				});
			} else {
				out.set(id, { ...slot, scale: HAND_REST_SCALE, z: i * 0.01 });
			}
		});
		return out;
	});

	// ---- pointer → hand -------------------------------------------------------

	function canvas(): HTMLElement {
		return renderer.domElement;
	}

	/** a client point in the tray group's own units (its centre is 0,0) */
	function trayLocal(clientX: number, clientY: number) {
		const rect = canvas().getBoundingClientRect();
		const { width, height } = get(viewport);
		return {
			x: ((clientX - rect.left) / rect.width - 0.5) * width,
			y: (0.5 - (clientY - rect.top) / rect.height) * height - trayY
		};
	}

	/** does tray-local (x, y) fall on a card drawn with `pose`? */
	function onCard(pose: Pose, landscape: boolean, x: number, y: number): boolean {
		const dx = x - pose.x;
		const dy = y - pose.y;
		const c = Math.cos(-pose.angle);
		const s = Math.sin(-pose.angle);
		const lx = dx * c - dy * s;
		const ly = dx * s + dy * c;
		const w = (landscape ? HAND_CARD_H : HAND_CARD_W) * pose.scale;
		const h = (landscape ? HAND_CARD_W : HAND_CARD_H) * pose.scale;
		return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
	}

	/** the topmost hand card under a client point, or null */
	function cardAt(clientX: number, clientY: number): string | null {
		const { x, y } = trayLocal(clientX, clientY);
		const drawn = [...poses.entries()].filter(([id]) => id !== GAP);
		drawn.sort(([, a], [, b]) => b.z - a.z);
		return drawn.find(([id, pose]) => onCard(pose, landscapeOf(id), x, y))?.[0] ?? null;
	}

	/** the client y above which a press has left the hand: the tray's top edge */
	function handTop(): number {
		const rect = canvas().getBoundingClientRect();
		return rect.bottom - rect.height / 6;
	}

	/** a press on a hand card, until it moves far enough to mean something */
	let press: { id: string; x: number; y: number } | null = null;

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0 || event.target !== canvas() || get(dragStore).isDragging) return;
		const id = cardAt(event.clientX, event.clientY);
		if (!id) return;
		hoveredTrayCard.set(id);
		press = { id, x: event.clientX, y: event.clientY };
		// the press is the hand's: the felt must not start a selection box under
		// it, nor a table card behind the fan a drag of its own
		event.stopPropagation();
	}

	function onPointerMove(event: PointerEvent) {
		settlePlayFace(event.shiftKey);
		const gesture = get(handGesture);
		if (press && !gesture) {
			if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
			const index = order.indexOf(press.id);
			if (index < 0) return void (press = null);
			handGesture.set({ id: press.id, reordering: true, x: slotOf.get(press.id)?.x ?? 0, index });
		}
		const held = get(handGesture);
		if (held && press) {
			// up and out of the hand (above both the tray and where the press
			// began, so a press high on a raised card can still slide sideways):
			// it becomes a play, carried like anything on the table
			if (event.clientY < Math.min(handTop(), press.y) - DRAG_THRESHOLD_PX) {
				const id = held.id;
				press = null;
				handGesture.set(null);
				hoveredTrayCard.set(null);
				playFromHand(id, event.shiftKey, {
					clientX: event.clientX,
					clientY: event.clientY,
					canvas: canvas()
				});
				return;
			}
			const { x } = trayLocal(event.clientX, event.clientY);
			// the slot it would land in: among the fan as drawn without it
			const index = slotAt(fanLayout(order.map(landscapeOf), trayWidth, trayHeight), x);
			handGesture.set({ ...held, x, index });
			return;
		}
		if (get(dragStore).isDragging) {
			// a table card carried over the hand: open a gap where it would go
			const next = get(dragStore).isTrayHovered
				? slotAt(
						fanLayout([...order, GAP].map(landscapeOf), trayWidth, trayHeight),
						trayLocal(event.clientX, event.clientY).x
					)
				: null;
			if (next !== get(handDropIndex)) handDropIndex.set(next);
			return;
		}
		if (get(handDropIndex) !== null) handDropIndex.set(null);
		// hover: the topmost card under the pointer, and only over the canvas
		const over = event.target === canvas() ? cardAt(event.clientX, event.clientY) : null;
		if (over !== get(hoveredTrayCard)) hoveredTrayCard.set(over);
	}

	// capture phase: the face must be settled, and a reorder committed, before
	// the table's own release handlers commit the drop
	function onPointerUp(event: PointerEvent) {
		settlePlayFace(event.shiftKey);
		const held = get(handGesture);
		// a press that stayed in the hand ends here too: the table never saw it
		// go down, so it must not see it come up as a click on whatever is behind
		if (press) event.stopPropagation();
		press = null;
		if (held) {
			handGesture.set(null);
			if (held.index !== order.indexOf(held.id))
				gameActions.reorderHand(myPlayerId, held.id, held.index);
		}
	}

	function onShift(event: KeyboardEvent) {
		if (event.key === 'Shift') settlePlayFace(event.type === 'keydown');
	}

	onMount(() => {
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp, true);
		window.addEventListener('pointercancel', onPointerUp, true);
		window.addEventListener('keydown', onShift);
		window.addEventListener('keyup', onShift);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp, true);
			window.removeEventListener('pointercancel', onPointerUp, true);
			window.removeEventListener('keydown', onShift);
			window.removeEventListener('keyup', onShift);
			handGesture.set(null);
			handDropIndex.set(null);
			hoveredTrayCard.set(null);
		};
	});
</script>

<T.OrthographicCamera makeDefault zoom={80} position={[0, 0, 10]} />
<T.AmbientLight intensity={Math.PI / 2} />
<T.PointLight position={[10, 10, 10]} decay={0} intensity={Math.PI * 2} />

<T.Group position={[trayX, trayY, 0] as [number, number, number]}>
	<T.Mesh
		name="hand-tray"
		onpointerenter={() => setTrayHover(true)}
		onpointerleave={() => setTrayHover(false)}
	>
		<T.PlaneGeometry args={[trayWidth, trayHeight]} />
		<T.MeshBasicMaterial
			color="white"
			transparent
			opacity={$dragStore.isTrayHovered ? 0.3 : 0.1}
			side={2}
		/>
	</T.Mesh>

	{#if isDropTarget}
		<!-- the tray is the whole cue while it's hovered: the drop indicator
		     drops its table footprint, since the card is going to the hand,
		     and the fan opens a gap where it will go in -->
		<T.Group position.z={0.01}>
			<DropFootprint
				shape="rect"
				w={trayWidth - 0.12}
				h={trayHeight - 0.12}
				color="#5ee7ff"
				fill={0.1}
				border={0.08}
			/>
		</T.Group>
	{/if}

	{#each order as id (id)}
		{@const pose = poses.get(id)}
		{#if pose}
			<TrayCard {id} {pose} landscape={landscapeOf(id)} viewport={`${trayWidth}x${trayHeight}`} />
		{/if}
	{/each}
</T.Group>
