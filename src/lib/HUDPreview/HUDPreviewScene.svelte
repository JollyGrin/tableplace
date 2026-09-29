<script lang="ts">
	import { onMount } from 'svelte';
	import { T, useThrelte } from '@threlte/core';
	import { useViewport } from '@threlte/extras';
	import { resolveCardImage, sheetRefCache } from '$lib/packs';
	import { cameraTransforms } from '$lib/utils/transforms/camera';
	import LabelBadge from '$lib/LabelBadge.svelte';
	import PieceFace from '$lib/PieceFace.svelte';
	import PreviewCard from './PreviewCard.svelte';
	import { preview } from './previewStore';
	import { registerHud } from '$lib/dev/hud-registry';

	// No interactivity() — the preview pane is display-only. If it ever gains a
	// pointer handler it needs its own call, not the parent's: this HUD has its
	// own camera (see HUDTrayScene) and the table camera's ray would never hit it.
	let {}: {} = $props();

	const viewport = useViewport();

	// The art is fitted into the right half of the screen, below the DOM panes
	// that sit along the top edge and above the bottom one, leaving room under
	// it for the caption. Sizes are world units of the zoom-80 ortho camera.
	const TOP_CLEARANCE = 3.2; // the players/settings panes
	const BOTTOM_CLEARANCE = 0.3;
	const CAPTION_ROOM = 0.9;
	const CAPTION_GAP = 0.3;
	const MAX_SCALE = 2.75;
	const MIN_SCALE = 1;
	// PreviewCard's unscaled plane; a disc is as wide as a card
	const CARD_W = 1.4 * 1.4;
	const CARD_H = 2 * 1.4;

	const url = $derived($preview ? resolveCardImage($preview.face, $sheetRefCache) : '');

	// unscaled on-screen footprint of the art
	const box = $derived.by((): [number, number] => {
		if ($preview?.shape === 'disc') return [CARD_W, CARD_W];
		return $preview?.landscape ? [CARD_H, CARD_W] : [CARD_W, CARD_H];
	});
	const layout = $derived.by(() => {
		const { width, height } = $viewport;
		const top = height / 2 - TOP_CLEARANCE;
		const bottom = -height / 2 + BOTTOM_CLEARANCE + CAPTION_ROOM;
		const scale = Math.max(
			MIN_SCALE,
			Math.min(MAX_SCALE, (top - bottom) / box[1], (width / 2 - 1) / box[0])
		);
		const artHeight = box[1] * scale;
		const y = top - artHeight / 2;
		return {
			scale,
			position: [width / 4, y, 0] as [number, number, number],
			captionY: -(artHeight / 2 + CAPTION_GAP)
		};
	});

	// Space (held in the route's key handler) and Alt (tracked scene-wide as the
	// no-snap modifier) both open the preview. Two things neither of those
	// handles covers:
	// - blur: alt-tabbing away never delivers Space's keyup, which would leave
	//   the zoom stuck open on return;
	// - a bare Alt release: Firefox and Windows browsers move focus to the menu
	//   bar on it, which swallows the next keypress. The table has no use for
	//   that, so the default is suppressed.
	onMount(() => {
		const onBlur = () => cameraTransforms.togglePreviewHud(false);
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === 'Alt') event.preventDefault();
		};
		window.addEventListener('blur', onBlur);
		window.addEventListener('keyup', onKeyUp);
		return () => {
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('keyup', onKeyUp);
		};
	});

	if (import.meta.env.DEV) {
		const { camera, scene } = useThrelte();
		onMount(() => registerHud('preview', { camera: () => camera.current, scene: () => scene }));
	}
</script>

<T.OrthographicCamera makeDefault zoom={80} position={[0, 0, 10]} />
<T.AmbientLight intensity={Math.PI / 2} />
<T.PointLight position={[10, 10, 10]} decay={0} intensity={Math.PI * 2} />

{#if $preview && url}
	<T.Group name="hud-preview" position={layout.position}>
		{#if $preview.shape === 'disc'}
			<!-- PieceFace lies flat for the table camera; stand it up for this one -->
			<T.Group rotation.x={Math.PI / 2}>
				<PieceFace {url} radius={(CARD_W / 2) * layout.scale} segments={64} position={[0, 0, 0]} />
			</T.Group>
		{:else}
			<PreviewCard {url} landscape={$preview.landscape} scale={layout.scale} />
		{/if}
		{#if $preview.caption}
			<LabelBadge text={$preview.caption} fontSize={0.34} position={[0, layout.captionY, 0.1]} />
		{/if}
	</T.Group>
{/if}
