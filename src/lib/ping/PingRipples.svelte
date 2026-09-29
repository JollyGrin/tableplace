<!--
	Pings on the felt (tableplace-198): each one a pair of rings in the pinger's
	seat colour, spreading and fading for PING_LIFETIME_MS, and — for a ping
	this camera cannot see — an arrow on the edge of the view pointing at it.

	Render-only. Everything animates imperatively from one task that runs only
	while a ping is up; no $state is written per frame. A ping's clock starts
	on the first frame that draws it, and the task retires it once it has
	played — so a client whose renderer is stalled still shows the whole ripple
	late, rather than losing it to a timer that ran out between two frames. The arrows are DOM
	(PingArrows.svelte), so this layer, which owns the camera, publishes where
	they go through the `pingArrows` store.
-->
<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core';
	import * as THREE from 'three';
	import { activePings, pingArrows, pingColor, retirePings } from '$lib/ping';
	import { PING_LIFETIME_MS, type ActivePing } from './ping';
	import { edgeArrow } from './edge';
	import { TABLE_TOP_Y } from '$lib/utils/constants-table';

	const { camera, dom } = useThrelte();

	/** two rings per ping, the second a beat behind the first */
	const RING_DELAY_MS = 220;
	const RING_SPREAD = 3.4;

	const ringGeometry = new THREE.RingGeometry(0.8, 1, 48);
	$effect(() => () => ringGeometry.dispose());

	/** the meshes each ping draws with, by key — filled as they mount */
	const rings = new Map<number, (THREE.Mesh | undefined)[]>();

	const pings = $derived($activePings);

	const projected = new THREE.Vector3();

	function ringsOf(key: number) {
		let pair = rings.get(key);
		if (!pair) rings.set(key, (pair = []));
		return pair;
	}

	/** when each ping was first drawn, by key */
	const startedAt = new Map<number, number>();

	/** draw one ping's rings; false once it has played out */
	function animate(ping: ActivePing, now: number): boolean {
		let start = startedAt.get(ping.key);
		if (start === undefined) startedAt.set(ping.key, (start = now));
		if (now - start >= PING_LIFETIME_MS) return false;
		const pair = rings.get(ping.key) ?? [];
		pair.forEach((mesh, i) => {
			if (!mesh) return;
			const age = now - start - i * RING_DELAY_MS;
			const u = Math.min(1, Math.max(0, age) / (PING_LIFETIME_MS - RING_DELAY_MS));
			// the first ring shows on the very first frame, however late that frame is
			mesh.visible = age >= 0 && u < 1;
			mesh.scale.setScalar(1 + u * RING_SPREAD);
			(mesh.material as THREE.MeshBasicMaterial).opacity = 1 - u;
		});
		return true;
	}

	useTask(
		() => {
			const now = performance.now();
			const rect = dom.getBoundingClientRect();
			const arrows = [];
			const done: number[] = [];
			for (const ping of pings) {
				if (!animate(ping, now)) {
					done.push(ping.key);
					continue;
				}
				projected.set(ping.x, TABLE_TOP_Y, ping.z).project(camera.current);
				const arrow = edgeArrow(projected, rect);
				if (arrow)
					arrows.push({
						...arrow,
						x: arrow.x + rect.left,
						y: arrow.y + rect.top,
						key: ping.key,
						color: pingColor(ping.playerId)
					});
			}
			pingArrows.set(arrows);
			retirePings(done);
		},
		{ running: () => pings.length > 0 }
	);

	// the last ping gone: take its arrow down and forget its meshes
	$effect(() => {
		const live = new Set(pings.map((ping) => ping.key));
		for (const key of rings.keys()) if (!live.has(key)) rings.delete(key);
		for (const key of startedAt.keys()) if (!live.has(key)) startedAt.delete(key);
		if (!live.size) pingArrows.set([]);
	});
</script>

{#each pings as ping (ping.key)}
	{@const color = pingColor(ping.playerId)}
	{#each [0, 1] as i (i)}
		<T.Mesh
			oncreate={(mesh) => {
				ringsOf(ping.key)[i] = mesh;
			}}
			geometry={ringGeometry}
			rotation.x={-Math.PI / 2}
			position={[ping.x, TABLE_TOP_Y + 0.03, ping.z]}
			renderOrder={10}
			visible={false}
			userData={{ ping: ping.key, playerId: ping.playerId, color }}
		>
			<T.MeshBasicMaterial
				{color}
				transparent
				opacity={0}
				depthWrite={false}
				depthTest={false}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
	{/each}
{/each}
