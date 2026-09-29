<script lang="ts">
	import { T } from '@threlte/core';
	import DropFootprint from './drop/DropFootprint.svelte';
	import {
		SELECTION_RING_BORDER,
		SELECTION_RING_COLOR,
		SELECTION_RING_FILL,
		SELECTION_RING_MARGIN
	} from '$lib/utils/constants-selection';

	/**
	 * The ring a selected entity wears (tableplace-202): its footprint's outline,
	 * a margin wider, laid flat at `position` and turned by `yaw` only — never
	 * by a flip. The drop indicator's footprint, in the selection's colour.
	 *
	 * Drawn over everything (no depth test) so a selected card low in a pile
	 * still shows it is selected. No pointer handlers, so threlte's dispatch
	 * never sees it.
	 */
	let {
		position,
		yaw = 0,
		shape,
		w = 0,
		h = 0,
		r = 0
	}: {
		position: [number, number, number];
		yaw?: number;
		shape: 'rect' | 'circle';
		w?: number;
		h?: number;
		r?: number;
	} = $props();
</script>

<T.Group {position} rotation.y={yaw}>
	<T.Group rotation.x={-Math.PI / 2}>
		<DropFootprint
			{shape}
			w={w + SELECTION_RING_MARGIN * 2}
			h={h + SELECTION_RING_MARGIN * 2}
			r={r + SELECTION_RING_MARGIN}
			color={SELECTION_RING_COLOR}
			fill={SELECTION_RING_FILL}
			border={SELECTION_RING_BORDER}
			depthTest={false}
		/>
	</T.Group>
</T.Group>
