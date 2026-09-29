<script lang="ts">
	import { T } from '@threlte/core';
	import DropFootprint from './drop/DropFootprint.svelte';
	import LabelBadge from './LabelBadge.svelte';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { isHoldLive, myHoldId } from '$lib/store/hold';
	import { playerColor } from '$lib/hud/players';
	import {
		HELD_BADGE_FONT_SIZE,
		HELD_BADGE_LIFT,
		HELD_RING_BORDER,
		HELD_RING_FILL,
		HELD_RING_MARGIN
	} from '$lib/utils/constants-hold';

	/**
	 * Held-by (tableplace-199): the ring and name an entity wears while ANOTHER
	 * player is carrying it — the footprint's outline in the holder's seat
	 * colour, with their name hanging above. Nothing for this client's own
	 * carry, and nothing once the holder has disconnected (their hold reads as
	 * released, see store/hold.ts).
	 *
	 * Drawn over everything (no depth test) like the selection ring, turned by
	 * `yaw` only, and with no pointer handlers — threlte's dispatch never sees
	 * it, and the badge refuses the raycaster itself. `userData.heldMark` is the
	 * test bridge's handle on it; a NAME would steal the raycast attribution.
	 */
	let {
		id,
		heldBy,
		position,
		yaw = 0,
		shape,
		w = 0,
		h = 0,
		r = 0
	}: {
		/** the entity wearing it — only the test bridge reads it */
		id: string;
		heldBy: string | undefined;
		position: [number, number, number];
		yaw?: number;
		shape: 'rect' | 'circle';
		w?: number;
		h?: number;
		r?: number;
	} = $props();

	const holder = $derived(
		heldBy && heldBy !== myHoldId() && isHoldLive($gameStore, heldBy) ? heldBy : null
	);
	const color = $derived(holder ? playerColor(holder, $gameStore?.players?.[holder]?.seat) : '');
</script>

{#if holder}
	<T.Group {position} rotation.y={yaw} userData={{ heldMark: { id, holder, color } }}>
		<T.Group rotation.x={-Math.PI / 2}>
			<DropFootprint
				{shape}
				w={w + HELD_RING_MARGIN * 2}
				h={h + HELD_RING_MARGIN * 2}
				r={r + HELD_RING_MARGIN}
				{color}
				fill={HELD_RING_FILL}
				border={HELD_RING_BORDER}
				depthTest={false}
			/>
		</T.Group>
	</T.Group>
	<LabelBadge
		text={holder}
		fontSize={HELD_BADGE_FONT_SIZE}
		position={[position[0], position[1] + HELD_BADGE_LIFT, position[2]]}
	/>
{/if}
