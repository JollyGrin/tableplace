<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core';
	import { OrbitControls } from '@threlte/extras';
	import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';
	import * as THREE from 'three';
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { dragStore } from '$lib/store/dragStore.svelte';
	import { get } from 'svelte/store';
	import {
		cameraBroadcastSignal,
		cameraRequest,
		requestCameraPreset,
		type CameraFocus,
		type CameraRequest
	} from '$lib/store/cameraStore.svelte';
	import { lastMoved } from '$lib/store/lastMoved';
	import { SEAT_ROTATION_DEG } from '$lib/hud/players';
	import { pointerTargets } from '$lib/verbs/keyboard';
	import { isRadialOpen } from '$lib/store/radialUi';
	import { gameActions } from './store/game/actions';
	import { gameStore } from './store/game/gameStore.svelte';
	import { createCameraStream } from '$lib/websocket/cameraStream';
	import { isWebSocketConnected, sendMessage } from '$lib/websocket/connection';
	import { isTyping } from '$lib/hotkeys/is-typing';
	import {
		CAMERA_EMPTY_BOUNDS,
		CAMERA_FOCUS_MIN_DISTANCE,
		CAMERA_FOCUS_PADDING,
		CAMERA_FOV_DEG,
		CAMERA_MAX_DISTANCE,
		CAMERA_MIN_DISTANCE,
		CAMERA_SEAT_POLAR,
		CAMERA_TOP_POLAR,
		CAMERA_TWEEN_MS
	} from '$lib/utils/constants-camera';
	import {
		angleOf,
		contentBounds,
		fitPose,
		seatAzimuth,
		type CameraPose
	} from '$lib/utils/camera-fit';
	import { distanceOf, easeInOutCubic, interpolatePose } from '$lib/utils/camera-tween';
	import { isPanKey, panDelta } from '$lib/utils/transforms/pan';
	import { classicMouse } from '$lib/store/mouseMode';
	import { ping } from '$lib/ping';
	import { feltPointAt } from '$lib/ping/felt';

	/**
	 * The mouse mapping (tableplace-202). Left-drag on the felt belongs to the
	 * selection box (Table.svelte), so OrbitControls gives up the left button —
	 * -1 is "no action" to three's switch — and orbits on the right, pans on
	 * the middle: the Tabletop Simulator convention. A right press that never
	 * travels is still the radial wheel (radial/gesture.ts), exactly as it was
	 * when right-drag panned. The classic mapping (left orbits, right pans) is
	 * one Settings checkbox away for one release — see store/mouseMode.ts.
	 */
	const MOUSE_BUTTONS = {
		LEFT: -1 as THREE.MOUSE,
		MIDDLE: THREE.MOUSE.PAN,
		RIGHT: THREE.MOUSE.ROTATE
	};
	const CLASSIC_MOUSE_BUTTONS = {
		LEFT: THREE.MOUSE.ROTATE,
		MIDDLE: THREE.MOUSE.DOLLY,
		RIGHT: THREE.MOUSE.PAN
	};

	const isDragging = $derived($dragStore.isDragging !== null);

	const myId = gameActions?.getMyId() ?? '';
	const seat = $derived($gameStore?.players?.[myId]?.seat ?? 0);

	const { invalidate, dom } = useThrelte();

	let camera: THREE.PerspectiveCamera | undefined = $state();
	let controls: OrbitControlsType | undefined = $state();

	/**
	 * How far the orbit may zoom out. Normally the felt's max, but a seat view
	 * fitted for a narrow window can sit farther than that, and OrbitControls
	 * clamps every `update()` to it — so it widens to whatever the last preset
	 * needed (see CAMERA_FIT_MAX_DISTANCE).
	 */
	let reach = $state(CAMERA_MAX_DISTANCE);

	/** where the camera mounts, before the seat effect below seats it properly */
	const INITIAL = fitPose(CAMERA_EMPTY_BOUNDS, 16 / 10, {
		azimuth: 0,
		polar: CAMERA_SEAT_POLAR
	});

	/**
	 * The seat's view along `polar`: from the seat's own side of the table
	 * (its rotation, not any layout), at the distance that fits the whole
	 * table's content at the current aspect. An empty table frames its middle.
	 */
	function presetPose(polar: number): CameraPose {
		const azimuth = seatAzimuth(SEAT_ROTATION_DEG[seat] ?? 0);
		const bounds = contentBounds(get(gameStore)) ?? CAMERA_EMPTY_BOUNDS;
		return fitPose(bounds, camera?.aspect ?? 16 / 10, { azimuth, polar });
	}

	function currentPose(): CameraPose | null {
		if (!camera || !controls) return null;
		return { position: camera.position.toArray(), target: controls.target.toArray() };
	}

	/** frames one entity, keeping whatever angle the camera is looking from */
	function focusPose(entity: CameraFocus | null): CameraPose | null {
		const from = currentPose();
		if (!entity || !from) return null;
		// the named kind first, then the others: the hover store that names a
		// card also carries a hovered piece's id (dragStore.isHovered), so the
		// kind is a hint and the id is what counts
		const state = get(gameStore);
		const named = ({ card: 'cards', deck: 'decks', piece: 'pieces' } as const)[entity.kind];
		const collection = [named, 'cards', 'decks', 'pieces'].find(
			(c) => state?.[c as typeof named]?.[entity.id]
		) as typeof named | undefined;
		const found = collection && state?.[collection]?.[entity.id];
		const bounds = found && contentBounds({ [collection]: { [entity.id]: found } });
		if (!bounds) return null;
		return fitPose(bounds, camera?.aspect ?? 16 / 10, angleOf(from), {
			minDistance: CAMERA_FOCUS_MIN_DISTANCE,
			padding: CAMERA_FOCUS_PADDING
		});
	}

	/**
	 * A preset move in flight. Played by the task below over CAMERA_TWEEN_MS,
	 * eased; the pose it writes each frame fires OrbitControls' change event,
	 * so it streams to peers through the same throttled cameraStream an orbit
	 * does (≤ ~3 Hz, silent once it lands). `tweening` gates the task the way
	 * `held` gates the pan task — see `running` below for why that matters.
	 */
	let tween: { from: CameraPose; to: CameraPose; elapsed: number } | null = null;
	let tweening = $state(false);

	const reducedMotion = () =>
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function apply(pose: CameraPose) {
		if (!camera || !controls) return;
		camera.position.set(...pose.position);
		controls.target.set(...pose.target);
		controls.update();
		invalidate();
	}

	function stopTween() {
		tween = null;
		tweening = false;
	}

	/** move to `pose`: tweened, or a cut on request or under reduced motion */
	function moveTo(pose: CameraPose, cut = false) {
		const from = currentPose();
		if (!from || !controls) return;
		reach = Math.max(CAMERA_MAX_DISTANCE, Math.ceil(distanceOf(pose)));
		// now, not on the prop's next flush: this frame's update() clamps to it
		controls.maxDistance = reach;
		if (cut || reducedMotion()) {
			stopTween();
			apply(pose);
			return;
		}
		tween = { from, to: pose, elapsed: 0 };
		tweening = true;
	}

	/**
	 * A frame advances the move by at most this much. At 60 fps that is never
	 * reached; on a hitch (a loaded machine, a software-rendered one at a few
	 * frames a second) it turns what would be a single-frame teleport back into
	 * a visible move — slower in wall-clock, but never a cut.
	 */
	const TWEEN_MAX_STEP_MS = 50;

	useTask(
		(delta) => {
			if (!tween) return stopTween();
			tween.elapsed += Math.min(delta * 1000, TWEEN_MAX_STEP_MS);
			const t = Math.min(1, tween.elapsed / CAMERA_TWEEN_MS);
			apply(interpolatePose(tween.from, tween.to, easeInOutCubic(t)));
			if (t >= 1) stopTween();
		},
		{ running: () => tweening }
	);

	/** near enough straight down that P means "back to the seat" */
	const TOP_DOWN_POLAR = 0.2;

	function runPreset({ preset, focus }: CameraRequest) {
		const from = currentPose();
		if (!from) return;
		if (preset === 'seat') return moveTo(presetPose(CAMERA_SEAT_POLAR));
		if (preset === 'toggle-top') {
			const isTop = angleOf(from).polar < TOP_DOWN_POLAR;
			return moveTo(presetPose(isTop ? CAMERA_SEAT_POLAR : CAMERA_TOP_POLAR));
		}
		const pose = focusPose(focus ?? get(lastMoved));
		if (pose) moveTo(pose);
	}

	// C / P / Z, the table wheel and double-click all land here
	$effect(() => {
		const request = $cameraRequest;
		if (request.n === 0) return;
		untrack(() => runPreset(request));
	});

	// Seat onto the seat view as soon as the camera exists, and again whenever
	// the seat changes (players arrive in the store after the camera mounts, and
	// /setup's "view from seat" switches seats) — a cut, not a tween: nobody has
	// a view to keep yet.
	$effect(() => {
		void seat;
		if (!camera || !controls) return;
		untrack(() => moveTo(presetPose(CAMERA_SEAT_POLAR), true));
	});

	// Fit once on join, once the table has stopped filling in: the snapshot lands
	// in pieces (the default map overlay first), so fitting on the first content
	// would frame a table that is still arriving. Skipped if the player has
	// already touched the camera — and never again after, since refitting under
	// a player mid-game would yank the view away.
	const JOIN_FIT_QUIET_MS = 350;
	let joinFitted = false;
	let userMoved = false;
	$effect(() => {
		if (joinFitted || !camera || !controls) return;
		if (!contentBounds($gameStore)) return;
		const timer = setTimeout(() => {
			joinFitted = true;
			if (!userMoved) moveTo(presetPose(CAMERA_SEAT_POLAR), true);
		}, JOIN_FIT_QUIET_MS);
		return () => clearTimeout(timer);
	});
	// any manual orbit, pan or zoom (OrbitControls' `start` fires for each, the
	// wheel included) marks the camera as the player's and cancels a preset move
	$effect(() => {
		if (!controls) return;
		const mark = () => {
			userMoved = true;
			stopTween();
		};
		controls.addEventListener('start', mark);
		return () => controls?.removeEventListener('start', mark);
	});

	/**
	 * Double-click a card, deck or piece: focus it. The hover stores already know
	 * what is under the pointer — the same resolution the keys use.
	 *
	 * On threlte's wrapper `dom`, not the <canvas>: interactivity listens there
	 * and takes pointer capture on it, so that is where the clicks land. And
	 * `dblclick` arrives after the second release — a focus requested on the
	 * press would be cancelled at once by the orbit `start` the press also is.
	 *
	 * On bare felt — nothing on the table or in the hand under the pointer — it
	 * pings that spot for everyone instead (tableplace-198).
	 */
	$effect(() => {
		const onDoubleClick = (event: MouseEvent) => {
			const targets = pointerTargets();
			const target = targets.find(
				(t) => t.kind === 'card' || t.kind === 'deck' || t.kind === 'piece'
			);
			if (target && 'id' in target)
				return requestCameraPreset('focus', {
					kind: target.kind as CameraFocus['kind'],
					id: target.id
				});
			// over the hand's own HUD, or a DOM pane stacked on the canvas: not the
			// felt. The pointer capture interactivity takes retargets the click to
			// `dom` itself, so that counts as the canvas.
			if (targets.some((t) => t.kind === 'hand-card')) return;
			if (event.target !== dom && !(event.target instanceof HTMLCanvasElement)) return;
			if (!camera) return;
			const point = feltPointAt(camera, dom.getBoundingClientRect(), event.clientX, event.clientY);
			if (point) ping(point.x, point.z);
		};
		dom.addEventListener('dblclick', onDoubleClick);
		return () => dom.removeEventListener('dblclick', onDoubleClick);
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
			if (isPanKey(event.code)) {
				userMoved = true;
				stopTween();
				held.add(event.code);
			}
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

<!-- near/far bound tightly to the orbit range (min 1 / max 72, a wide fit up to 150): depth precision
     is proportional to near/far ratio, and card faces are only 0.02 apart. At the
     farthest fit the depth step is ~z²/(near·2²⁴) ≈ 0.003, still under 0.02. -->
<T.PerspectiveCamera
	makeDefault
	bind:ref={camera}
	position={INITIAL.position}
	fov={CAMERA_FOV_DEG}
	near={0.5}
	far={200}
>
	<!-- While the radial wheel is up the same button is still down: the flick that
	     picks a wedge would otherwise pan (right) or rotate (left) the camera
	     underneath it. Disabling the controls outright is safe mid-gesture —
	     three's pointerup cleanup does not check `enabled`, so the press ends
	     cleanly and the next one behaves normally. A right drag that never
	     held still still orbits (pans, on the classic mapping). -->
	<OrbitControls
		bind:ref={controls}
		onchange={() => broadcastPose()}
		enabled={!$isRadialOpen}
		mouseButtons={$classicMouse ? CLASSIC_MOUSE_BUTTONS : MOUSE_BUTTONS}
		enableRotate={!isDragging}
		enableDamping
		maxPolarAngle={Math.PI / 2 - 0.1}
		target={INITIAL.target}
		minDistance={CAMERA_MIN_DISTANCE}
		maxDistance={reach}
	/>
</T.PerspectiveCamera>
