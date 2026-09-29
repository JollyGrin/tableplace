/**
 * Ping (tableplace-198): point at a spot on the table for everyone.
 *
 * One ping is one ephemeral relay message (`type: 'ping'`, value `{ x, z }`),
 * exactly like `camera` and `journal`: relayed to the other players, never
 * merged into lobby state, never in a sync snapshot. Nothing here streams — a
 * ping is sent once per gesture, and the sender is limited to
 * `PING_RATE.count` per `PING_RATE.windowMs` so a burst of double-clicks can
 * never spend the relay's message budget.
 *
 * Pure: the clock, the wire and the drawing are injected (see `index.ts` for
 * the live wiring), so the rate limit and the wire validation are testable.
 */

import { TABLE_HALF_X, TABLE_HALF_Z } from '$lib/utils/constants-table';

/** how long a ripple (and its edge arrow) stays up */
export const PING_LIFETIME_MS = 1200;

/** at most `count` pings from this client in any `windowMs` */
export const PING_RATE = { count: 2, windowMs: 1000 } as const;

/** what goes on the wire: a point on the table plane */
export type PingValue = { x: number; z: number };

/** a ping being drawn on this client */
export type ActivePing = PingValue & {
	/** unique on this client, for keyed rendering */
	key: number;
	/** who pinged — their seat colour paints it */
	playerId: string;
	/** local clock time it arrived, in ms */
	at: number;
};

/**
 * A peer's ping value, or null when it is not one. The point is clamped to
 * the felt: a ping is a spot on the table, and a malformed or hostile value
 * must not put a ripple (or an arrow) somewhere nobody can look.
 */
export function parsePing(value: unknown): PingValue | null {
	if (!value || typeof value !== 'object') return null;
	const { x, z } = value as Record<string, unknown>;
	if (typeof x !== 'number' || typeof z !== 'number') return null;
	if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
	return { x: clamp(x, TABLE_HALF_X), z: clamp(z, TABLE_HALF_Z) };
}

function clamp(value: number, half: number) {
	return Math.max(-half, Math.min(half, value));
}

/**
 * The client-side limiter: `true` when a ping may go now (and records it),
 * `false` when this client has already sent its share of the window.
 */
export function createRateLimit(
	now: () => number,
	{ count, windowMs }: { count: number; windowMs: number } = PING_RATE
) {
	const sent: number[] = [];
	return () => {
		const t = now();
		while (sent.length && t - sent[0]! >= windowMs) sent.shift();
		if (sent.length >= count) return false;
		sent.push(t);
		return true;
	};
}

export type PingerDeps = {
	now: () => number;
	/** put a ping on the wire; absent until the lobby socket is up */
	send: (value: PingValue) => void;
	/** who this client is */
	myId: () => string | null | undefined;
	/** a ping to draw, whoever sent it */
	show: (ping: ActivePing) => void;
	/** the ping sound, if sound is on (see `sound.ts`) */
	sound?: () => void;
};

export function createPinger(deps: PingerDeps) {
	const allow = createRateLimit(deps.now);
	let key = 0;

	function show(playerId: string, value: PingValue) {
		deps.show({ ...value, key: ++key, playerId, at: deps.now() });
		deps.sound?.();
	}

	return {
		/**
		 * Ping a table point from this client. Returns false when it was
		 * refused — rate-limited, or no player to send it as.
		 */
		ping(x: number, z: number): boolean {
			const me = deps.myId();
			const value = parsePing({ x, z });
			if (!me || !value || !allow()) return false;
			show(me, value);
			deps.send(value);
			return true;
		},
		/** a peer's ping arrived over the relay */
		receive(value: unknown, playerId: string) {
			const ping = parsePing(value);
			if (ping && playerId) show(playerId, ping);
		}
	};
}
