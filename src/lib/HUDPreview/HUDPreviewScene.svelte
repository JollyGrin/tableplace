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

	const trayWidth = $derived($viewport.width / 2);
	const trayHeight = $derived($viewport.height / 2); // Adjust height as needed
	const trayX = $derived(-$viewport.width / 2 + trayWidth / 2);
	const trayY = $derived(-$viewport.height / 2 + trayHeight / 2);

	// PreviewCard's plane is 1.96 × 2.8 at scale 2.75; a disc gets the card's width
	const CARD_HALF_HEIGHT = (2 * 1.4 * 2.75) / 2;
	const CARD_HALF_WIDTH = (1.4 * 1.4 * 2.75) / 2;
	const DISC_RADIUS = CARD_HALF_WIDTH;
	const CAPTION_GAP = 0.35;

	const url = $derived($preview ? resolveCardImage($preview.face, $sheetRefCache) : '');
	// the caption hangs below the art's bottom edge, whatever shape the art is
	const captionY = $derived(
		-(
			($preview?.shape === 'disc'
				? DISC_RADIUS
				: $preview?.landscape
					? CARD_HALF_WIDTH
					: CARD_HALF_HEIGHT) + CAPTION_GAP
		)
	);

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
	<T.Group name="hud-preview" position={[-trayX, trayY + 1, 0] as [number, number, number]}>
		{#if $preview.shape === 'disc'}
			<!-- PieceFace lies flat for the table camera; stand it up for this one -->
			<T.Group rotation.x={Math.PI / 2}>
				<PieceFace {url} radius={DISC_RADIUS} segments={64} />
			</T.Group>
		{:else}
			<PreviewCard {url} landscape={$preview.landscape} />
		{/if}
		{#if $preview.caption}
			<LabelBadge text={$preview.caption} fontSize={0.34} position={[0, captionY, 0.1]} />
		{/if}
	</T.Group>
{/if}
