<script lang="ts">
	import { T } from '@threlte/core';
	import { get } from 'svelte/store';
	import type { IntersectionEvent } from '@threlte/extras';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { gameStore } from './store/game/gameStore.svelte';
	import { gameActions } from './store/game/actions';
	import { dragStore } from './store/dragStore.svelte';
	import { claimPointerDown } from '$lib/utils/single-hit-dispatch';
	import { compareSnapIds, snapRadius } from '$lib/utils/transforms/snap';
	import { snapEditor, setSnapLinkFrom } from '$lib/store/snapEditor';
	import {
		SNAP_MARKER_COLOR,
		SNAP_MARKER_COLOR_ACTIVE,
		SNAP_MARKER_Y
	} from '$lib/utils/constants-snap';
	import DropFootprint from './drop/DropFootprint.svelte';

	/**
	 * One authored snap point, drawn flat on the felt: a ring at its catch
	 * radius, a dot on the point itself, and a tick pointing along the yaw when
	 * one is authored.
	 *
	 * Editor-only — `TableScene` mounts these behind `snapEditing`, so /play
	 * never draws them (see `store/tableFeatures`). Drag to move, right-click to
	 * delete; the pane has the same operations with exact numbers.
	 *
	 * Links (tableplace-190) draw as a line from each point to the points it
	 * links to — once per pair. With "draw links" armed a click picks this
	 * point instead of moving it; clicking a second point toggles the link
	 * between them and carries the pick on, so a path is drawn click by click.
	 *
	 * The drag is deliberately local rather than routed through `dragStore`:
	 * that store is the card/piece pipeline, whose every consumer assumes the
	 * dragged id is an entity in `cards`/`pieces` that a drop resolves a landing
	 * for. A snap point has no landing — it *is* one. All it needs is the table
	 * raycast point, which `TableScene.compute` already publishes on every
	 * pointer move.
	 */

	let { id }: { id: string } = $props();

	const point = $derived($gameStore?.snapPoints?.[id]);
	const radius = $derived(snapRadius(point));
	const yaw = $derived(point?.rotation);
	const x = $derived(point?.position?.[0] ?? 0);
	const z = $derived(point?.position?.[1] ?? 0);

	let isHovered = $state(false);
	let isMoving = $state(false);
	const picked = $derived($snapEditor.linking && $snapEditor.linkFrom === id);
	const color = $derived(
		isMoving || isHovered || picked ? SNAP_MARKER_COLOR_ACTIVE : SNAP_MARKER_COLOR
	);

	/**
	 * One line per linked pair: this end draws it unless the other end links
	 * back and sorts first. `[dx, dz]` is the offset to the other point.
	 */
	// a link line is a picture, not a handle: clicks go through it to the felt
	const noRaycast = () => {};

	const linkLines = $derived.by(() => {
		const points = $gameStore?.snapPoints;
		return (point?.links ?? []).flatMap((target) => {
			const other = points?.[target];
			const p = other?.position;
			if (!p || target === id) return [];
			if (other?.links?.includes(id) && compareSnapIds(target, id) < 0) return [];
			const dx = p[0] - x;
			const dz = p[1] - z;
			return [{ target, dx, dz, length: Math.hypot(dx, dz) }];
		});
	});

	function onMove() {
		const hit = get(dragStore).intersectionPoint;
		if (!hit) return;
		// clamped inside the felt by moveSnapPoint, same as any other placement
		gameActions.moveSnapPoint(id, [hit.x, hit.z]);
	}

	function stopMoving() {
		isMoving = false;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', stopMoving);
		window.removeEventListener('pointercancel', stopMoving);
	}

	// leaving the editor (or a scenario load removing this point) mid-drag must
	// not leave the window listeners behind
	$effect(() => stopMoving);

	function handlePointerDown(e: IntersectionEvent<PointerEvent>) {
		// a card/piece drag in flight owns the pointer — never steal it, or a
		// release over a marker would move the marker instead of landing the card
		if (get(dragStore).isDragging) return;
		if (!claimPointerDown(e)) return;
		const editor = get(snapEditor);
		if (editor.linking) {
			const from = editor.linkFrom;
			if (from && from !== id) gameActions.toggleSnapLink(from, id);
			// picking the picked point again lets go; otherwise carry the pick on
			setSnapLinkFrom(from === id ? null : id);
			return;
		}
		isMoving = true;
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', stopMoving);
		window.addEventListener('pointercancel', stopMoving);
	}

	function handleContextMenu(e: IntersectionEvent<MouseEvent>) {
		e.stopPropagation();
		e.nativeEvent.preventDefault();
		gameActions.removeSnapPoint(id);
	}
</script>

{#if point?.position}
	<T.Group
		position={[x, SNAP_MARKER_Y, z]}
		onpointerdown={handlePointerDown}
		oncontextmenu={handleContextMenu}
		onpointerenter={() => (isHovered = true)}
		onpointerleave={() => (isHovered = false)}
	>
		<T.Group rotation.x={-Math.PI / 2}>
			{#each linkLines as line (line.target)}
				<!-- flat bar to the linked point; local +y is world -z once laid flat -->
				<T.Mesh
					position={[line.dx / 2, -line.dz / 2, 0.002]}
					rotation.z={Math.atan2(-line.dz, line.dx)}
					raycast={noRaycast}
				>
					<T.PlaneGeometry args={[line.length, 0.06]} />
					<T.MeshBasicMaterial
						color={SNAP_MARKER_COLOR}
						transparent
						opacity={0.8}
						depthWrite={false}
						side={2}
					/>
				</T.Mesh>
			{/each}
			<DropFootprint shape="circle" r={radius} {color} fill={0.14} border={0.045} />
			<!-- the point itself: the ring shows the catch radius, this shows where
			     a caught drop actually lands -->
			<T.Mesh position.z={0.003}>
				<T.CircleGeometry args={[0.07, 16]} />
				<T.MeshBasicMaterial {color} transparent opacity={0.95} depthWrite={false} side={2} />
			</T.Mesh>
			{#if yaw !== undefined}
				<!-- yaw tick. -yaw about the view axis matches how a card renders its
				     table rotation (Card.svelte: rotation.y = -rotation[2]), so the
				     tick points where a caught card's top edge will face. -->
				<T.Group rotation.z={-yaw * DEG2RAD}>
					<T.Mesh position={[0, radius / 2, 0.003]}>
						<T.PlaneGeometry args={[0.05, radius]} />
						<T.MeshBasicMaterial {color} transparent opacity={0.9} depthWrite={false} side={2} />
					</T.Mesh>
				</T.Group>
			{/if}
		</T.Group>
	</T.Group>
{/if}
