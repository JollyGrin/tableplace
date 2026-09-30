/**
 * The dev-only handle the headless render harness (`e2e/`) drives the table
 * through.
 *
 * It exists because the class of failure #102 was reported for — a die or a bag
 * that poisons the shared raycast and freezes every pointer interaction on the
 * table — is invisible to jsdom: nothing there runs three.js geometry or a
 * raycast. Catching it needs a real GPU-less browser, real pointer events at
 * real pixels, and therefore a way to ask the live scene *where on screen* a
 * given entity is. That is all this is.
 *
 * Everything here is a read of live state or a call into `gameActions`, i.e.
 * exactly what the HUD panes already do — the harness spawns pieces the same
 * way a player does and then clicks them with a real mouse. Nothing in the app
 * reads this object.
 *
 * `import.meta.env.DEV` is a compile-time constant, so `installTestBridge` is
 * only ever called from a dev build (see `TestBridge.svelte`).
 */

import * as THREE from 'three';
import { soundStats } from '$lib/sound';
import { framesAreStalling } from '$lib/utils/frame-stall.svelte';
import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { selectedIds } from '$lib/store/selection';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { isWebSocketConnected } from '$lib/websocket/connection';
import { snapGuideDimMaterial } from '$lib/drop/snap-guide-dim';
import type { GameDTO, OverlayDTO } from '$lib/store/game/types';
import { resolveTextureImage, sheetRefCache } from '$lib/packs';
import { preview as previewStore } from '$lib/HUDPreview/previewStore';
import { huds } from './hud-registry';
import { activePings, pingArrows, ping as sendPing } from '$lib/ping';
import { remotePointersEnabled } from '$lib/pointers/settings';
import { remoteCameraStore } from '$lib/store/remoteCameraStore.svelte';
import { ensureSeatPlaceholder, type SeatIndex } from '$lib/scenario/scenario';

export type ScreenPoint = { x: number; y: number };

export type TestBridge = {
	/** set last, so the harness can poll one flag and know the scene is live */
	ready: boolean;
	actions: typeof gameActions;
	state: () => Partial<GameDTO> | undefined;
	/** world → CSS pixels within the canvas, or null when it projects off-screen */
	project: (world: [number, number, number]) => ScreenPoint | null;
	/** where a card / deck / piece currently draws, by store id */
	locate: (id: string) => ScreenPoint | null;
	/**
	 * Where a card in MY hand draws, in the same CSS pixels as `locate`. The
	 * tray is its own HUD scene with its own orthographic camera, so the table
	 * camera `locate` projects through can never see it.
	 */
	locateInHand: (id: string) => ScreenPoint | null;
	/**
	 * Every card of MY hand as it draws right now, left to right on screen:
	 * its id and its drawn box in CSS pixels (tableplace-195) — what a spec
	 * reads the fan's order and its fit inside the viewport off.
	 */
	handCards: () => {
		id: string;
		left: number;
		right: number;
		top: number;
		bottom: number;
	}[];
	/**
	 * The zoomed preview as it is on screen right now, or null while closed.
	 * `face` is the unresolved ref the preview chose, `url` what it resolves
	 * to, and `shown` the image the preview mesh's texture actually holds —
	 * null until it has loaded. `shown === url` is "it is drawing that face".
	 * `at` is the centre of the zoomed art on screen, for a pixel check.
	 * `geometry` is the art mesh's geometry type — `PlaneGeometry` for a card
	 * and for a square token's uncropped face, `CircleGeometry` for a disc —
	 * and `bounds` its extent on screen, so a spec can sample its corners.
	 */
	preview: () => {
		id: string;
		face: string;
		url: string;
		caption: string;
		shown: string | null;
		at: ScreenPoint | null;
		geometry: string | null;
		bounds: { left: number; right: number; top: number; bottom: number } | null;
	} | null;
	/** the raycast the shared interactivity context runs, minus the dispatch */
	hits: (screen: ScreenPoint) => string[];
	/** what is being dragged / hovered right now — distinguishes "never lifted" from "lifted and snapped back" */
	drag: () => {
		isDragging: string | null;
		isHovered: string | null;
		isBagHovered: string | null;
		isDeckHovered: string | null;
		noSnap: boolean;
	};
	/** the box selection, live members only, in the order they were added (tableplace-202) */
	selected: () => string[];
	/**
	 * Where the table camera is right now. A pan — dragged with the right button
	 * or held on W/A/S/D — moves the eye, so this is what a spec measures a pan
	 * with. Read off the live camera rather than a store: nothing broadcasts the
	 * pose locally, and the throttled presence stream is not a clock a spec can
	 * wait on.
	 */
	camera: () => { position: number[]; direction: number[] } | null;
	/**
	 * Is the lobby socket still open? The relay *disconnects* a client that
	 * sustains more than ~7 messages a second, so this is how a spec proves a
	 * held-key camera pan still rides the throttled presence stream instead of
	 * streaming a pose per frame.
	 */
	connected: () => boolean;
	/** what an entity is actually made of — null if it never mounted at all */
	describe: (id: string) => EntityShape | null;
	/**
	 * Where an entity's group actually draws right now (tableplace-203): its
	 * world height, and how far it leans off level in degrees — the angle
	 * between its own up axis and the world's, flips ignored. What the weight
	 * spec measures the lean and the landing bounce with; the store never sees
	 * either.
	 */
	pose: (id: string) => { y: number; leanDeg: number } | null;
	/**
	 * Whether the app is treating the frame loop as stalled right now (see
	 * utils/frame-stall.svelte.ts) — when every spring snaps and weight is off.
	 */
	stalling: () => boolean;
	/** table sounds (tableplace-204): how many of each actually started, and whether audio is armed */
	sounds: () => Record<string, number | boolean>;
	/**
	 * The yaw an entity is DRAWN at right now — its named group's, clockwise
	 * seen from above, in degrees within [0, 360). What a rotation spec waits
	 * on: the store says what was asked for, this says what the renderer shows.
	 */
	yaw: (id: string) => number | null;
	/**
	 * The entity's floating label badge (LabelBadge.svelte), or null while none
	 * is mounted — which is itself the assertion for hover-only labels.
	 */
	badge: (id: string) => { scale: number } | null;
	/**
	 * Held-by marks as they are drawn right now (tableplace-199): which entity
	 * wears one, whose it is, and its colour. Empty when nobody else is
	 * carrying anything — a client never draws its own.
	 */
	heldMarks: () => { id: string; holder: string; color: string }[];
	/**
	 * A counter's printed dial face (CounterDial.svelte), or null when none is
	 * drawn: what the canvas last printed, how many times it has been drawn (a
	 * redraw only ever follows a change to name/value/min/max), its live pulse
	 * `scale`, and the world yaw its text faces (0 reads from seat 0).
	 */
	dial: (id: string) => {
		name: string;
		value: number;
		maxValue: number | null;
		minValue: number;
		/** how full the rim arc is drawn, 0…1; null when there is no arc */
		fraction: number | null;
		redraws: number;
		scale: number;
		facing: number;
	} | null;
	/**
	 * The lift-time snap guides as they are drawn right now (tableplace-188),
	 * read off the rendered objects rather than a store: `rings`/`cells` are
	 * the instance counts on screen (0 while hidden), `opacity` the ring
	 * material's live fade, `target` the snap id the filled mark sits on and
	 * `targetAt` where it sits, and `dim` the shared overlay-dim opacity.
	 * `reach`/`reachIds` are the bright rings a piece with `reach` lights
	 * (tableplace-190).
	 */
	snapGuides: () => SnapGuideShape;
	/**
	 * Inject artificial main-thread stalls — the long frame gaps a shared CI
	 * runner, a slow GPU or a backgrounded window produce, made deterministic.
	 *
	 * `{ ms: 400, everyMs: 250 }` holds the thread for 400ms, frees it for
	 * 250ms, repeats; `null` stops it. A busy-wait, not a sleep: what breaks a
	 * drag is the main thread being *unavailable* — frames stop arriving, the
	 * springs that draw every entity fall behind the store, and pointer events
	 * queue up to land against a scene that no longer matches what is on screen
	 * (see `frame-stall.svelte.ts`). Nothing short of occupying the thread
	 * reproduces that; `emulateCPUThrottling` does not, because it never
	 * touches the GPU process, which is what a SwiftShader runner actually
	 * starves (#157).
	 *
	 * Scheduled on a timer rather than per animation frame on purpose: the page
	 * this has to reproduce a stall on may already be down to 3 fps, and
	 * "every Nth frame" would then inject three stalls a second by accident of
	 * the load rather than by the spec's intent.
	 *
	 * Returns the number of stalls injected since the last call, so a spec can
	 * assert the injection really happened rather than trusting that it did.
	 */
	stall: (options: { ms: number; everyMs?: number } | null) => number;
	/**
	 * Every image texture the table scene draws — card and deck faces, map
	 * overlays, piece art — with the anisotropy it filters at, and `target`,
	 * the anisotropy new textures are built with (tableplace-155). Keyed by
	 * image src, so a spec can find the overlay or card it placed.
	 */
	textures: () => { target: number; maps: { src: string; anisotropy: number }[] };
	/**
	 * Put a map overlay on the table. No action spawns one outside a pack, and
	 * a spec should not need a pack to test how a board draws.
	 */
	addOverlay: (overlay: OverlayDTO) => string;
	/**
	 * Put a seat's placeholder player on the table, as applying a scenario
	 * does (tableplace-262) — what an invite's `?seat=` claims, along with
	 * every `…:seat<n>:…` entity.
	 */
	seedSeat: (seat: SeatIndex) => void;
	/**
	 * Every ping this page has drawn since the bridge went up (tableplace-198),
	 * oldest first — kept after the ripple fades, since a spec polls slower
	 * than a ping lives. `color` is the ring material's drawn colour (null if
	 * no ring ever mounted), `rings` the most ring meshes seen visible at once,
	 * and `arrow` whether an edge arrow was ever put up for it.
	 */
	pings: () => PingShape[];
	/** ping a table point as this player, through the same rate limit a double-click hits */
	ping: (x: number, z: number) => boolean;
	/**
	 * Other players' pointers as this page draws them right now
	 * (tableplace-197): where each cursor is (mid-glide), the table point it
	 * is gliding to, whether it is up, its opacity and its drawn colour.
	 */
	remotePointers: () => RemotePointerShape[];
	/** the Settings "Remote pointers" toggle — tweakpane cannot be driven synthetically */
	setRemotePointers: (on: boolean) => void;
};

export type RemotePointerShape = {
	playerId: string;
	x: number;
	z: number;
	target: [number, number] | null;
	visible: boolean;
	opacity: number;
	color: string | null;
	/** ms since the store last saw this pointer move; null while it has none */
	idleMs: number | null;
};

export type PingShape = {
	playerId: string;
	x: number;
	z: number;
	color: string | null;
	rings: number;
	arrow: boolean;
};

export type SnapGuideShape = {
	/** rings drawn at the ordinary brightness — out of reach, or no reach set */
	rings: number;
	/** rings drawn bright: the points within the lifted piece's reach (tableplace-190) */
	reach: number;
	/** ids of the points in the bright set, sorted; [] while none is shown */
	reachIds: string[];
	cells: number;
	opacity: number;
	target: string | null;
	targetAt: [number, number, number] | null;
	dim: number;
	/** how many draw objects the guides use — the instancing claim, checkable */
	objects: number;
};

/**
 * Enough of an entity's rendered form to tell "did not mount", "mounted
 * untextured" and "mounted correctly" apart. `renders white` in #102 was the
 * first of those, so `meshes: 0` and `null` are the interesting answers.
 */
export type EntityShape = {
	meshes: number;
	/** one entry per material, in traversal order */
	materials: { type: string; color: string; hasMap: boolean; roughness: number | null }[];
	/**
	 * World-space bounding-box dimensions [x, y, z] of the rendered object.
	 * What tells a landscape card (footprint wider than deep) from a portrait
	 * one — the store cannot: orientation is render-only by design.
	 */
	size: [number, number, number];
};

declare global {
	interface Window {
		__tableplace?: TestBridge;
	}
}

type SceneHandles = {
	camera: () => THREE.Camera | undefined;
	canvas: () => HTMLCanvasElement | undefined;
	scene: () => THREE.Scene | undefined;
	/**
	 * Extra readiness the mounting component wants `ready` to wait for —
	 * TestBridge.svelte holds it false until the scene's environment lighting
	 * has applied and rendered once (the recompile storm; see its comment).
	 */
	isReady?: () => boolean;
};

/**
 * Walk an entity's rendered meshes, skipping its floating label badge
 * (LabelBadge.svelte tags its group `userData.badge`). The badge billboards
 * ABOVE the body — folding it into the bounding box drags the box centre off
 * the body, and a pointer aimed there grabs whatever happens to be behind the
 * label instead of the entity it belongs to. A player aims at the body; so
 * does everything here.
 */
function eachBodyMesh(node: THREE.Object3D, visit: (mesh: THREE.Mesh) => void): void {
	if (node.userData.badge) return;
	const mesh = node as THREE.Mesh;
	if (mesh.isMesh) visit(mesh);
	for (const child of node.children) eachBodyMesh(child, visit);
}

function bodyBox(object: THREE.Object3D): THREE.Box3 {
	object.updateWorldMatrix(true, true);
	const box = new THREE.Box3();
	const meshBox = new THREE.Box3();
	eachBodyMesh(object, (mesh) => {
		mesh.geometry.computeBoundingBox();
		if (!mesh.geometry.boundingBox) return;
		meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
		box.union(meshBox);
	});
	return box;
}

/**
 * Where an entity actually *draws*, not where the store says it is.
 *
 * The two differ enough to matter: a die sits a shape-dependent distance above
 * the piece group's origin, a deck's height grows with its card count, and the
 * table camera is only near-vertical — so projecting the store position and
 * clicking there misses the mesh at the edges of the table and lands on felt.
 * The centre of the rendered bounding box is what a player aims at.
 */
function renderedCentre(scene: THREE.Scene, id: string): THREE.Vector3 | null {
	const object = scene.getObjectByName(id);
	if (!object) return null;
	const box = bodyBox(object);
	if (box.isEmpty()) return object.getWorldPosition(new THREE.Vector3());
	return box.getCenter(new THREE.Vector3());
}

/**
 * The stall injector's whole state. Module-level rather than per-install so a
 * bridge that remounts (an effect re-run) cannot leave a second busy-waiting
 * timer running behind the first.
 */
let stallOptions: { ms: number; everyMs: number } | null = null;
let stallCount = 0;
let stallLoop: ReturnType<typeof setTimeout> | null = null;

function setStall(options: { ms: number; everyMs?: number } | null): number {
	const injected = stallCount;
	stallCount = 0;
	stallOptions = options ? { ms: options.ms, everyMs: Math.max(0, options.everyMs ?? 0) } : null;
	if (stallLoop) clearTimeout(stallLoop);
	stallLoop = null;
	if (!stallOptions) return injected;

	const tick = () => {
		const current = stallOptions;
		if (!current) return;
		stallCount++;
		// deliberately a spin, not a sleep: only occupying the thread stops the
		// frames and queues the pointer events behind it, which is the condition
		// under test
		const until = performance.now() + current.ms;
		while (performance.now() < until) {
			/* hold the main thread */
		}
		stallLoop = setTimeout(tick, current.everyMs);
	};
	stallLoop = setTimeout(tick, stallOptions.everyMs);
	return injected;
}

export function installTestBridge(handles: SceneHandles): void {
	const raycaster = new THREE.Raycaster();

	const project = (
		world: [number, number, number],
		camera = handles.camera()
	): ScreenPoint | null => {
		const canvas = handles.canvas();
		if (!camera || !canvas) return null;
		const ndc = new THREE.Vector3(...world).project(camera);
		if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
		const rect = canvas.getBoundingClientRect();
		return {
			x: rect.left + ((ndc.x + 1) / 2) * rect.width,
			y: rect.top + ((1 - ndc.y) / 2) * rect.height
		};
	};

	/**
	 * The same intersection the interactivity context does, reported as the ids
	 * of whatever was hit — nearest first, deduplicated. Leaf meshes are
	 * anonymous, so each hit is attributed to its nearest named ancestor, which
	 * is the entity group.
	 *
	 * A raycast that throws here throws for the real dispatch loop too, which is
	 * the point: the harness can name the broken entity rather than only observe
	 * that nothing responds.
	 */
	const hits = (screen: ScreenPoint): string[] => {
		const camera = handles.camera();
		const canvas = handles.canvas();
		const scene = handles.scene();
		if (!camera || !canvas || !scene) return [];
		const rect = canvas.getBoundingClientRect();
		raycaster.setFromCamera(
			new THREE.Vector2(
				((screen.x - rect.left) / rect.width) * 2 - 1,
				-(((screen.y - rect.top) / rect.height) * 2 - 1)
			),
			camera
		);
		const named = (object: THREE.Object3D): string => {
			for (let node: THREE.Object3D | null = object; node; node = node.parent) {
				if (node.name) return node.name;
			}
			return object.type;
		};
		return [
			...new Set(raycaster.intersectObjects(scene.children, true).map((h) => named(h.object)))
		];
	};

	watchPings(handles.scene);
	window.__tableplace = {
		get ready() {
			return handles.isReady?.() ?? true;
		},
		actions: gameActions,
		state: () => get(gameStore),
		project,
		locate: (id) => {
			const scene = handles.scene();
			const centre = scene ? renderedCentre(scene, id) : null;
			return centre ? project([centre.x, centre.y, centre.z]) : null;
		},
		locateInHand: (id) => {
			const tray = huds.get('tray');
			const scene = tray?.scene();
			const camera = tray?.camera();
			const centre = scene && camera ? renderedCentre(scene, id) : null;
			return centre ? project([centre.x, centre.y, centre.z], camera) : null;
		},
		handCards: () => {
			const tray = huds.get('tray');
			const scene = tray?.scene();
			const camera = tray?.camera();
			const me = gameActions.getMyId();
			const ids = Object.keys((me && get(gameStore)?.players?.[me]?.tray) ?? {});
			if (!scene || !camera) return [];
			return ids
				.flatMap((id) => {
					const object = scene.getObjectByName(id);
					if (!object) return [];
					const box = bodyBox(object);
					if (box.isEmpty()) return [];
					const corners = [box.min, box.max].flatMap((a) =>
						[box.min, box.max].map((b) => project([a.x, b.y, box.min.z], camera))
					);
					if (corners.some((c) => !c)) return [];
					const xs = corners.map((c) => c!.x);
					const ys = corners.map((c) => c!.y);
					return [
						{
							id,
							left: Math.min(...xs),
							right: Math.max(...xs),
							top: Math.min(...ys),
							bottom: Math.max(...ys)
						}
					];
				})
				.sort((a, b) => a.left + a.right - (b.left + b.right));
		},
		preview: () => {
			const target = get(previewStore);
			if (!target) return null;
			let shown: string | null = null;
			let art: THREE.Mesh | null = null;
			const hud = huds.get('preview');
			const camera = hud?.camera();
			const group = hud?.scene()?.getObjectByName('hud-preview');
			const centre = group?.getWorldPosition(new THREE.Vector3());
			group?.traverse((node) => {
				const mesh = node as THREE.Mesh;
				if (shown || !mesh.isMesh) return;
				// ImageMaterial (cards) keeps its texture in a uniform; PieceFace
				// (discs) is a plain MeshBasicMaterial map
				const material = mesh.material as THREE.ShaderMaterial & THREE.MeshBasicMaterial;
				const texture: THREE.Texture | null = material.uniforms?.map?.value ?? material.map ?? null;
				const image = texture?.image as { src?: string } | undefined;
				if (image?.src) {
					shown = image.src;
					art = mesh;
				}
			});
			// Box3 only refreshes the mesh's own matrix; its HUD ancestors (the group
			// that places the art on screen) have to be brought up to date first
			(art as THREE.Mesh | null)?.updateWorldMatrix(true, false);
			const box = art ? new THREE.Box3().setFromObject(art) : null;
			const low = box && camera ? project([box.min.x, box.min.y, box.min.z], camera) : null;
			const high = box && camera ? project([box.max.x, box.max.y, box.max.z], camera) : null;
			return {
				id: target.id,
				face: target.face,
				url: resolveTextureImage(target.face, get(sheetRefCache)),
				caption: target.caption,
				shown,
				at: centre && camera ? project([centre.x, centre.y, centre.z], camera) : null,
				geometry: (art as THREE.Mesh | null)?.geometry.type ?? null,
				bounds:
					low && high
						? {
								left: Math.min(low.x, high.x),
								right: Math.max(low.x, high.x),
								top: Math.min(low.y, high.y),
								bottom: Math.max(low.y, high.y)
							}
						: null
			};
		},
		hits,
		drag: () => {
			const { isDragging, isHovered, isBagHovered, isDeckHovered, noSnap } = get(dragStore);
			return { isDragging, isHovered, isBagHovered, isDeckHovered, noSnap: !!noSnap };
		},
		selected: () => get(selectedIds),
		connected: () => isWebSocketConnected(),
		snapGuides: () => {
			const shape: SnapGuideShape = {
				rings: 0,
				reach: 0,
				reachIds: [],
				cells: 0,
				opacity: 0,
				target: null,
				targetAt: null,
				dim: snapGuideDimMaterial.visible ? snapGuideDimMaterial.opacity : 0,
				objects: 0
			};
			handles.scene()?.traverse((object) => {
				const role = object.userData.snapGuide as
					| 'rings'
					| 'reach'
					| 'cells'
					| 'target'
					| undefined;
				if (!role) return;
				shape.objects++;
				const mesh = object as THREE.Mesh;
				const material = mesh.material as THREE.Material;
				const shown = mesh.visible && material.visible && material.opacity > 0;
				if (role === 'reach') {
					shape.reach = shown ? (mesh as THREE.InstancedMesh).count : 0;
					shape.reachIds = shown ? [...(object.userData.snapGuideReach ?? [])] : [];
				} else if (role === 'rings' || role === 'cells') {
					const count = shown ? (mesh as THREE.InstancedMesh).count : 0;
					shape[role] = count;
					if (role === 'rings') shape.opacity = shown ? material.opacity : 0;
				} else if (role === 'target' && shown && object.userData.snapGuideTarget) {
					shape.target = object.userData.snapGuideTarget;
					shape.targetAt = object.getWorldPosition(new THREE.Vector3()).toArray();
				}
			});
			return shape;
		},
		camera: () => {
			const camera = handles.camera();
			if (!camera) return null;
			return {
				position: camera.position.toArray(),
				direction: camera.getWorldDirection(new THREE.Vector3()).toArray()
			};
		},
		describe: (id) => {
			const object = handles.scene()?.getObjectByName(id);
			if (!object) return null;
			// body only, like locate: the badge is a readout riding along, and its
			// meshes/materials would pollute every "did the body mount right" check
			const box = bodyBox(object);
			const size = box.isEmpty()
				? ([0, 0, 0] as [number, number, number])
				: (box.getSize(new THREE.Vector3()).toArray() as [number, number, number]);
			const shape: EntityShape = { meshes: 0, materials: [], size };
			eachBodyMesh(object, (mesh) => {
				shape.meshes++;
				for (const material of [mesh.material].flat()) {
					const standard = material as THREE.MeshStandardMaterial;
					shape.materials.push({
						type: material.type,
						color: standard.color ? `#${standard.color.getHexString()}` : '',
						hasMap: !!standard.map,
						roughness: standard.roughness ?? null
					});
				}
			});
			return shape;
		},
		pose: (id) => {
			const object = handles.scene()?.getObjectByName(id);
			if (!object) return null;
			const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
				object.getWorldQuaternion(new THREE.Quaternion())
			);
			return {
				y: object.getWorldPosition(new THREE.Vector3()).y,
				leanDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(up.y))))
			};
		},
		stalling: () => framesAreStalling(),
		sounds: () => soundStats(),
		yaw: (id) => {
			const object = handles.scene()?.getObjectByName(id);
			if (!object) return null;
			const degrees = -object.rotation.y / THREE.MathUtils.DEG2RAD;
			return Math.round((((degrees % 360) + 360) % 360) * 1000) / 1000;
		},
		heldMarks: () => {
			const marks: { id: string; holder: string; color: string }[] = [];
			handles.scene()?.traverse((node) => {
				if (node.userData.heldMark) marks.push({ ...node.userData.heldMark });
			});
			return marks;
		},
		badge: (id) => {
			const object = handles.scene()?.getObjectByName(id);
			if (!object) return null;
			// found by userData, not by name: naming the badge group would steal
			// the raycast attribution `hits()` resolves by nearest named ancestor
			let group: THREE.Object3D | null = null;
			object.traverse((node) => {
				if (!group && node.userData.badge) group = node;
			});
			return group ? { scale: (group as THREE.Object3D).scale.x } : null;
		},
		dial: (id) => {
			const object = handles.scene()?.getObjectByName(id);
			let mesh: THREE.Object3D | null = null;
			object?.traverse((node) => {
				if (!mesh && node.userData.dial) mesh = node;
			});
			const face = mesh as THREE.Object3D | null;
			if (!face?.parent) return null;
			// where the text's baseline points: the viewer it reads for
			const down = new THREE.Vector3(0, 0, 1).applyQuaternion(
				face.parent.getWorldQuaternion(new THREE.Quaternion())
			);
			return {
				...(face.userData.dial as {
					name: string;
					value: number;
					maxValue: number | null;
					minValue: number;
					fraction: number | null;
					redraws: number;
				}),
				scale: face.parent.scale.x,
				facing: Math.atan2(down.x, down.z)
			};
		},
		stall: setStall,
		textures: () => {
			const maps = new Map<string, number>();
			handles.scene()?.traverse((node) => {
				const mesh = node as THREE.Mesh;
				if (!mesh.isMesh) return;
				for (const material of [mesh.material].flat()) {
					// ImageMaterial keeps its texture in a uniform, like preview() reads
					const shader = material as THREE.ShaderMaterial & THREE.MeshBasicMaterial;
					const texture: THREE.Texture | null = shader.uniforms?.map?.value ?? shader.map ?? null;
					const src = (texture?.image as { src?: string } | undefined)?.src;
					if (texture && src) maps.set(src, texture.anisotropy);
				}
			});
			return {
				target: THREE.Texture.DEFAULT_ANISOTROPY,
				maps: [...maps].map(([src, anisotropy]) => ({ src, anisotropy }))
			};
		},
		addOverlay: (overlay) => {
			gameStore.updateState({ overlays: { [overlay.id]: overlay } });
			return overlay.id;
		},
		seedSeat: (seat) => ensureSeatPlaceholder(seat),
		pings: () => {
			// sample what is drawn right now before answering
			samplePings(handles.scene());
			return [...seenPings.values()].map((p) => ({ ...p }));
		},
		ping: (x, z) => sendPing(x, z),
		remotePointers: () => {
			const out: RemotePointerShape[] = [];
			const cams = get(remoteCameraStore);
			handles.scene()?.traverse((object) => {
				const playerId = object.userData?.remotePointer as string | undefined;
				if (!playerId) return;
				let color: string | null = null;
				object.traverse((child) => {
					const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
					if (!color && child instanceof THREE.Mesh && material?.color)
						color = `#${material.color.getHexString()}`;
				});
				out.push({
					playerId,
					x: object.position.x,
					z: object.position.z,
					target: (object.userData.target as [number, number] | undefined) ?? null,
					visible: object.visible,
					opacity: (object.userData.opacity as number | undefined) ?? 0,
					color,
					idleMs: cams[playerId]?.c ? Date.now() - cams[playerId].pointerAt : null
				});
			});
			return out;
		},
		setRemotePointers: (on) => remotePointersEnabled.set(on)
	};
}

/**
 * What the ping probe has seen, by ping key. Sampled from the stores as pings
 * arrive, and from the scene every animation frame while one is up — a ripple
 * lives 1.2s, far shorter than a spec's poll.
 */
const seenPings = new Map<number, PingShape>();
let stopPingWatch: (() => void) | null = null;

function samplePings(scene: THREE.Scene | undefined) {
	const visible = new Map<number, number>();
	scene?.traverse((object) => {
		const key = object.userData?.ping as number | undefined;
		const seen = key === undefined ? undefined : seenPings.get(key);
		if (!seen || !(object instanceof THREE.Mesh)) return;
		const material = object.material as THREE.MeshBasicMaterial;
		seen.color = `#${material.color.getHexString()}`;
		if (object.visible) visible.set(key!, (visible.get(key!) ?? 0) + 1);
	});
	for (const [key, count] of visible) {
		const seen = seenPings.get(key)!;
		seen.rings = Math.max(seen.rings, count);
	}
}

function watchPings(scene: () => THREE.Scene | undefined) {
	stopPingWatch?.();
	let frame = 0;
	const tick = () => {
		samplePings(scene());
		frame = get(activePings).length ? requestAnimationFrame(tick) : 0;
	};
	const unsubPings = activePings.subscribe((pings) => {
		for (const p of pings)
			if (!seenPings.has(p.key))
				seenPings.set(p.key, {
					playerId: p.playerId,
					x: p.x,
					z: p.z,
					color: null,
					rings: 0,
					arrow: false
				});
		if (pings.length && !frame) frame = requestAnimationFrame(tick);
	});
	const unsubArrows = pingArrows.subscribe((arrows) => {
		for (const arrow of arrows) {
			const seen = seenPings.get(arrow.key);
			if (seen) seen.arrow = true;
		}
	});
	stopPingWatch = () => {
		unsubPings();
		unsubArrows();
		if (frame) cancelAnimationFrame(frame);
	};
}

export function removeTestBridge(): void {
	setStall(null);
	stopPingWatch?.();
	stopPingWatch = null;
	delete window.__tableplace;
}
