<script lang="ts">
	import { T, useTask } from '@threlte/core';
	import { OrbitControls } from '@threlte/extras';
	import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';
	import * as THREE from 'three';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { cameraBroadcastSignal, cameraResetSignal } from '$lib/store/cameraStore.svelte';
	import { isRadialOpen } from '$lib/store/radialUi';
	import { gameActions } from './store/game/actions';
	import { gameStore } from './store/game/gameStore.svelte';
	import { createCameraStream } from '$lib/websocket/cameraStream';
	import { isWebSocketConnected, sendMessage } from '$lib/websocket/connection';
	import { isTyping } from '$lib/hotkeys/is-typing';
	import {
		CAMERA_FOV_DEG,
		CAMERA_MAX_DISTANCE,
		CAMERA_MIN_DISTANCE
	} from '$lib/utils/constants-camera';
	import { isPanKey, panDelta } from '$lib/utils/transforms/pan';

	const isDragging = $derived($dragStore.isDragging !== null);

	const y = 25;
	const seating = [
		[0, y, 0],
		[0, y, -0.01],
		[0.1, y, 0],
		[-0.1, y, 0]
	];

	const myId = gameActions?.getMyId() ?? '';
	const seat = $derived($gameStore?.players?.[myId]?.seat ?? 0);

	let camera: THREE.PerspectiveCamera | undefined = $state();
	let controls: OrbitControlsType | undefined = $state();

	// reset to the seat's default birds-eye view when requested (keybind C)
	$effect(() => {
		if ($cameraResetSignal === 0) return;
		const [px, py, pz] = seating[seat];
		if (!camera || !controls) return;
		camera.position.set(px, py, pz);
		controls.target.set(0, 0, 0);
		controls.update();
	});

	/**
	 * Presence: stream our pose to peers so they can draw our camera avatar.
	 *
	 * This bypasses gameStore entirely — see websocket/cameraStream.ts for why
	 * (unthrottled path + poses would be persisted into lobby state). The
	 * stream is self-throttling and silent while the camera is still, so an
	 * idle client puts nothing on the wire.
	 */
	const cameraStream = createCameraStream((sample) => {
		if (!isWebSocketConnected()) return false;
		const playerId = gameActions.getMyId();
		if (!playerId) return false;
		return sendMessage({ type: 'camera', playerId, timestamp: Date.now(), value: sample });
	});

	$effect(() => () => cameraStream.dispose());

	/**
	 * A local drag already spends 5 Hz of the server's 7 msg/s budget, and the
	 * limiter *disconnects* rather than drops. Measured against the Go server:
	 * a sustained 5 Hz drag plus 2.9 Hz of camera is 7.9/s and closes the
	 * socket with StatusPolicyViolation after ~20s. So the camera yields
	 * entirely while dragging — which costs nothing real, since OrbitControls
	 * rotation is already disabled then (only the wheel can still move it) —
	 * and the settled pose goes out on release.
	 */
	let forceOnRelease = false;

	function broadcastPose(force = false) {
		if (!camera || !controls) return;
		if (isDragging) {
			forceOnRelease ||= force;
			return;
		}
		const { x, y, z } = camera.position;
		const { x: tx, y: ty, z: tz } = controls.target;
		cameraStream.offer([x, y, z], [tx, ty, tz], force);
	}

	// a peer just joined and missed everything we sent before they connected
	$effect(() => {
		if ($cameraBroadcastSignal === 0) return;
		broadcastPose(true);
	});

	// drag released: resume the stream, and honour any join request we swallowed
	$effect(() => {
		if (isDragging) return;
		const force = forceOnRelease;
		forceOnRelease = false;
		broadcastPose(force);
	});

	/**
	 * WASD panning, screen-relative (see utils/transforms/pan.ts).
	 *
	 * Held keys, driven per frame rather than off key-repeat: repeat rates differ
	 * per OS and the first repeat is a third of a second late, which reads as a
	 * stutter. The pose that results goes out through the SAME throttled stream
	 * an orbit does — the shift moves camera and target, `controls.update()`
	 * fires OrbitControls' change event, and `broadcastPose` hands it to
	 * `cameraStream` (≤ ~3 Hz). A held key must never outrun that: the relay
	 * disconnects a socket over ~7 msg/s, it does not drop.
	 */
	const held = new SvelteSet<string>();

	onMount(() => {
		// a W typed into a pane field is text, not a pan (the same guard every
		// table hotkey uses)
		const onKeyDown = (event: KeyboardEvent) => {
			if (isTyping(event.target)) return;
			if (isPanKey(event.code)) held.add(event.code);
		};
		const onKeyUp = (event: KeyboardEvent) => held.delete(event.code);
		// alt-tabbing away never delivers the keyup, and a key stuck down pans forever
		const onBlur = () => held.clear();
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
			held.clear();
		};
	});

	/**
	 * `running` is load-bearing, not tidiness.
	 *
	 * threlte renders ON DEMAND — `shouldRender()` is true while any
	 * auto-invalidating task is *started* — and `useTask` opts into invalidation
	 * by default. A pan task that stays started for the camera's whole life
	 * therefore converts the table from on-demand to continuous rendering:
	 * measured at 33.8 renders/sec on an idle /play, where the right answer is
	 * zero. Gating on a key actually being held gives back both halves — a held
	 * key still gets every frame it needs (that is what the auto-invalidation is
	 * FOR), and an idle table draws nothing.
	 *
	 * Hence SvelteSet above: a plain Set mutates without telling anyone, so
	 * `running` would never re-evaluate and the task would never start.
	 */
	useTask(
		(delta) => {
			if (!camera || !controls) return;
			const step = panDelta(
				held,
				// matrixWorld's second column: the camera's up axis in world space
				new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray(),
				camera.position.toArray(),
				controls.target.toArray(),
				delta
			);
			if (!step) return;
			const [dx, dz] = step;
			camera.position.x += dx;
			camera.position.z += dz;
			controls.target.x += dx;
			controls.target.z += dz;
			controls.update();
		},
		{ running: () => held.size > 0 }
	);
</script>

<!-- near/far bound tightly to the orbit range (min 1 / max 62): depth precision
     is proportional to near/far ratio, and card faces are only 0.02 apart. At the
     max distance the depth step is ~z²/(near·2²⁴) ≈ 0.0005, well under 0.02. -->
<T.PerspectiveCamera
	makeDefault
	bind:ref={camera}
	position={seating[seat] as [number, number, number]}
	fov={CAMERA_FOV_DEG}
	near={0.5}
	far={200}
>
	<!-- While the radial wheel is up the same button is still down: the flick that
	     picks a wedge would otherwise pan (right) or rotate (left) the camera
	     underneath it. Disabling the controls outright is safe mid-gesture —
	     three's pointerup cleanup does not check `enabled`, so the press ends
	     cleanly and the next one behaves normally. Bindings are otherwise
	     untouched: a right drag that never held still still pans. -->
	<OrbitControls
		bind:ref={controls}
		onchange={() => broadcastPose()}
		enabled={!$isRadialOpen}
		enableRotate={!isDragging}
		enableDamping
		maxPolarAngle={Math.PI / 2 - 0.1}
		target={[0, 0, 0]}
		minDistance={CAMERA_MIN_DISTANCE}
		maxDistance={CAMERA_MAX_DISTANCE}
	/>
</T.PerspectiveCamera>
