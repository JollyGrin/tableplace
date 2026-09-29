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
import { get } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { isWebSocketConnected } from '$lib/websocket/connection';
import { clearIntentLog, intentLog, type IntentEvent } from '$lib/store/game/intents';
import { clearIntentRefusals, intentRefusals, type Refusal } from '$lib/gate';
import {
	installStubValidator,
	isStubValidatorInstalled,
	removeStubValidator
} from './stub-validator';
import type { GameDTO } from '$lib/store/game/types';

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
	/** the raycast the shared interactivity context runs, minus the dispatch */
	hits: (screen: ScreenPoint) => string[];
	/** what is being dragged / hovered right now — distinguishes "never lifted" from "lifted and snapped back" */
	drag: () => {
		isDragging: string | null;
		isHovered: string | null;
		isBagHovered: string | null;
		isDeckHovered: string | null;
	};
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
	/**
	 * Every named action this client has seen — its own and its peers' — oldest
	 * first (tableplace-169). Two clients in one lobby must agree on this list
	 * exactly, which is the only way to prove the verb survived the wire rather
	 * than only the patch it caused.
	 */
	intents: () => IntentEvent[];
	/** forget the log, so a spec can bracket one gesture and compare just that */
	clearIntents: () => void;
	/**
	 * The dev-only stub validator (tableplace-171) — "you may only act on
	 * entities your own seat owns". Default OFF, because the gate's headline
	 * property is that a table with none registered behaves exactly as it did
	 * before the gate existed; the harness proves that by running the same
	 * gesture with it off and on and comparing what left over the wire.
	 */
	enableStubValidator: () => void;
	disableStubValidator: () => void;
	stubValidatorEnabled: () => boolean;
	/**
	 * Every refusal the referee has voiced on this client, oldest first, with the
	 * validator's own reason — the machine-readable half of the toast.
	 */
	refusals: () => Refusal[];
	clearRefusals: () => void;
	/** what an entity is actually made of — null if it never mounted at all */
	describe: (id: string) => EntityShape | null;
	/**
	 * The entity's floating label badge (LabelBadge.svelte), or null while none
	 * is mounted — which is itself the assertion for hover-only labels. `scale`
	 * is the live pulse spring, so a spec can watch a counter's value-change
	 * kick (jumps toward 1.6) and settle back to 1.
	 */
	badge: (id: string) => { scale: number } | null;
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
};

/**
 * Enough of an entity's rendered form to tell "did not mount", "mounted
 * untextured" and "mounted correctly" apart. `renders white` in #102 was the
 * first of those, so `meshes: 0` and `null` are the interesting answers.
 */
export type EntityShape = {
	meshes: number;
	/** one entry per material, in traversal order */
	materials: { type: string; color: string; hasMap: boolean }[];
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

	const project = (world: [number, number, number]): ScreenPoint | null => {
		const camera = handles.camera();
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
		hits,
		drag: () => {
			const { isDragging, isHovered, isBagHovered, isDeckHovered } = get(dragStore);
			return { isDragging, isHovered, isBagHovered, isDeckHovered };
		},
		connected: () => isWebSocketConnected(),
		intents: () => intentLog(),
		clearIntents: () => clearIntentLog(),
		enableStubValidator: () => installStubValidator(),
		disableStubValidator: () => removeStubValidator(),
		stubValidatorEnabled: () => isStubValidatorInstalled(),
		refusals: () => intentRefusals(),
		clearRefusals: () => clearIntentRefusals(),
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
						hasMap: !!standard.map
					});
				}
			});
			return shape;
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
		stall: setStall
	};
}

export function removeTestBridge(): void {
	setStall(null);
	delete window.__tableplace;
}
