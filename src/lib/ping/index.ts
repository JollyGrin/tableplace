/**
 * The table's pings, wired to the live stores (see `ping.ts`).
 *
 * Inert until `installPing` — /play installs it once the lobby socket is up;
 * /setup and /create never do, so a double-click there pings nobody.
 */

import { get, writable } from 'svelte/store';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { playerColor } from '$lib/hud/players';
import type { VerbTarget } from '$lib/verbs/types';
import { createPinger, PING_STALE_MS, type ActivePing, type PingValue } from './ping';
import { playPingSound } from './sound';
import type { EdgeArrow } from './edge';

/** the pings being drawn right now, oldest first */
export const activePings = writable<ActivePing[]>([]);

/**
 * The edge arrows for the pings outside the view, written by the ripple layer
 * (it owns the camera) and read by the DOM overlay. Keyed like `activePings`.
 */
export const pingArrows = writable<(EdgeArrow & { key: number; color: string })[]>([]);

let send: ((value: PingValue) => void) | null = null;

const pinger = createPinger({
	now: () => performance.now(),
	send: (value) => send?.(value),
	myId: () => gameActions.getMyId(),
	show: (ping) => {
		activePings.update((pings) => [...pings, ping]);
		setTimeout(() => retirePings([ping.key]), PING_STALE_MS);
	},
	sound: playPingSound
});

/** take pings off the table (the ripple layer, once each has played) */
export function retirePings(keys: readonly number[]) {
	if (!keys.length) return;
	activePings.update((pings) => pings.filter((p) => !keys.includes(p.key)));
}

/** start pinging; `publish` puts one ping on the wire */
export function installPing(publish: (value: PingValue) => void) {
	send = publish;
}

/** ping a table point from this client — false if refused (rate limit, not installed) */
export function ping(x: number, z: number): boolean {
	if (!send) return false;
	return pinger.ping(x, z);
}

/** a peer's ping arrived over the relay */
export function receivePing(value: unknown, playerId: string) {
	pinger.receive(value, playerId);
}

/** the colour a player's pings are drawn in: their seat's */
export function pingColor(playerId: string): string {
	return playerColor(playerId, get(gameStore)?.players?.[playerId]?.seat);
}

/**
 * Where the felt was last pressed, on the table plane. The table's wheel opens
 * from a right-press on the felt (Table.svelte notes it here), and its Ping
 * wedge pings that spot — not wherever the pointer drifted to while flicking.
 */
let feltPress: PingValue | null = null;

export function noteFeltPress(x: number, z: number) {
	feltPress = { x, z };
}

/** the point the radial's Ping wedge means for a target */
export function pingPointFor(target: VerbTarget): PingValue | null {
	if (target.kind === 'table') return feltPress;
	if (target.kind !== 'card' && target.kind !== 'deck' && target.kind !== 'piece') return null;
	const state = get(gameStore);
	const collection =
		target.kind === 'card' ? state?.cards : target.kind === 'deck' ? state?.decks : state?.pieces;
	const position = collection?.[target.id]?.position;
	return position ? { x: position[0], z: position[2] } : null;
}

/** the Ping verb: ping what the target is, or where the felt was pressed */
export function pingTarget(target: VerbTarget) {
	const point = pingPointFor(target);
	if (point) ping(point.x, point.z);
}
