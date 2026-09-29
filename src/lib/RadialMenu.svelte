<!--
	The radial ("wheel") context menu: press a card, a deck, a piece or the felt
	and the verbs for that thing fan out around the pointer, each printed with
	its hotkey (or, for a verb with no key, its click) — using the wheel is how
	you learn you no longer need it.

	DOM rather than in-scene: the labels have to stay legible at any camera
	angle, and the pointer must not fight the table's drag handling. Rendered
	once per route, next to the Canvas.

	It draws only. The gesture — which button, how long, which wedge, and what
	the release means — lives in `radial/gesture.ts`, because a flick leaves this
	overlay's pixels immediately and has to be tracked on the window. What this
	component owns is the sticky wheel's clicks and its click-away.

	The wedges are `<button>`s laid on top of the drawn ring at the same angles
	the maths selects by (radial/geometry.ts), so aiming at a label and flicking
	in its direction are the same gesture. They are always in the DOM — in flick
	mode they are inert (`pointer-events: none`; the release is what fires) — so
	"is the wheel up, and what is on it" is one query for a spec as well as for a
	screen reader.
-->
<script lang="ts">
	import { radialMenu, registerRadialSurface, setRadialHover } from '$lib/store/radialUi';
	import { dismiss, fireRadialOption } from '$lib/radial/gesture';
	import { radialTitle } from '$lib/radial/actions';
	import {
		RADIAL_BOX_PX,
		RADIAL_INNER_PX,
		wedgeLabelOffset,
		wedgePath
	} from '$lib/radial/geometry';

	// mounting this overlay is what turns the gesture on for a route — see
	// registerRadialSurface (the /create preview deliberately has no wheel)
	$effect(() => registerRadialSurface());

	const menu = $derived($radialMenu);
	const count = $derived(menu?.options.length ?? 0);
	const sticky = $derived(menu?.mode === 'sticky');
</script>

{#if menu}
	<!-- click-away catcher. Inert during a flick: that gesture is already down
	     and tracked on the window, and swallowing its release here would be a
	     second opinion on what the release meant. -->
	<div
		class="fixed inset-0 z-40 {sticky ? '' : 'pointer-events-none'}"
		role="presentation"
		onpointerdown={dismiss}
		oncontextmenu={(event) => {
			// the browser's own menu must never appear over the wheel
			event.preventDefault();
			dismiss();
		}}
	></div>

	<div
		class="pointer-events-none fixed z-50 font-sans select-none"
		style="left: {menu.x - RADIAL_BOX_PX}px; top: {menu.y - RADIAL_BOX_PX}px;
		       width: {RADIAL_BOX_PX * 2}px; height: {RADIAL_BOX_PX * 2}px"
		role="menu"
		tabindex="-1"
		aria-label="{radialTitle(menu.target)} actions"
	>
		<svg
			class="absolute inset-0 h-full w-full overflow-visible"
			viewBox="{-RADIAL_BOX_PX} {-RADIAL_BOX_PX} {RADIAL_BOX_PX * 2} {RADIAL_BOX_PX * 2}"
			aria-hidden="true"
		>
			{#each menu.options as option, index (option.id)}
				<path
					d={wedgePath(index, count)}
					class={menu.hover === index
						? 'fill-emerald-400/35 stroke-emerald-200/70'
						: 'fill-gray-900/80 stroke-white/15'}
					stroke-width="1"
				/>
			{/each}
			<!-- the deadzone, drawn: release in here and nothing happens -->
			<circle r={RADIAL_INNER_PX - 8} class="fill-gray-950/85 stroke-white/15" stroke-width="1" />
		</svg>

		<div
			class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center leading-tight"
		>
			<div class="text-[11px] tracking-widest text-white/70 uppercase">
				{radialTitle(menu.target)}
			</div>
			<div class="text-[10px] text-white/35">{sticky ? 'Esc' : 'release'}</div>
		</div>

		{#each menu.options as option, index (option.id)}
			{@const at = wedgeLabelOffset(index, count)}
			<button
				type="button"
				role="menuitem"
				data-radial-action={option.id}
				class="absolute max-w-24 -translate-x-1/2 -translate-y-1/2 rounded px-1 text-center
				       text-[11px] leading-tight font-medium {sticky
					? 'pointer-events-auto cursor-pointer'
					: 'pointer-events-none'} {menu.hover === index ? 'text-emerald-200' : 'text-white/80'}"
				style="left: calc(50% + {at.x}px); top: calc(50% + {at.y}px)"
				onpointerenter={() => setRadialHover(index)}
				onpointerleave={() => setRadialHover(null)}
				onclick={() => fireRadialOption(index)}
			>
				<span class="block">{option.label}</span>
				{#if option.key}
					<kbd
						data-radial-key
						class="block font-sans text-[10px] font-normal {menu.hover === index
							? 'text-emerald-100/80'
							: 'text-emerald-300/70'}">{option.key}</kbd
					>
				{/if}
			</button>
		{/each}
	</div>
{/if}
