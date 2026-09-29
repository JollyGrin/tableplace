import { CARD_HEIGHT } from './constants-cards';
import {
	CAMERA_DEFAULT_HEIGHT,
	CAMERA_FIT_PADDING,
	CAMERA_FOV_DEG,
	CAMERA_MAX_DISTANCE
} from './constants-camera';
import { PIECE_DEFAULT_RADIUS } from './constants-pieces';
import type { GameDTO } from '$lib/store/game/types';

/** xz extent on the felt */
export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/**
 * xz bounding box of everything on the table — cards, decks, pieces, overlays —
 * by footprint. Undefined on an empty table. A card is bounded by its circumscribed
 * circle (its diagonal is the worst case whatever the yaw), so the box never clips
 * a tapped or landscape card.
 */
export function contentBounds(state: Partial<GameDTO> | undefined): Bounds | undefined {
	if (!state) return undefined;
	let b: Bounds | undefined;
	const add = (x: unknown, z: unknown, rx: number, rz = rx) => {
		if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) return;
		b ??= { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
		b.minX = Math.min(b.minX, x - rx);
		b.maxX = Math.max(b.maxX, x + rx);
		b.minZ = Math.min(b.minZ, z - rz);
		b.maxZ = Math.max(b.maxZ, z + rz);
	};
	const cardRadius = CARD_HEIGHT / 2;
	for (const c of Object.values(state.cards ?? {}))
		add(c?.position?.[0], c?.position?.[2], cardRadius);
	for (const d of Object.values(state.decks ?? {}))
		add(d?.position?.[0], d?.position?.[2], cardRadius);
	for (const p of Object.values(state.pieces ?? {})) {
		add(p?.position?.[0], p?.position?.[2], p?.radius ?? PIECE_DEFAULT_RADIUS);
	}
	for (const o of Object.values(state.overlays ?? {})) {
		const h = (o?.scale ?? 12) / 2;
		add(o?.position?.[0], o?.position?.[2], h * (o?.ratio ?? 1), h);
	}
	return b;
}

export type CameraFit = { x: number; z: number; distance: number };

/**
 * Where a straight-down camera must sit to frame `bounds` at `aspect`
 * (generalises `distanceToFrameFelt` to a box). `turned` swaps the box's axes
 * for seats 2/3, whose screen-x runs along world z. The distance never drops
 * below today's default height — a lone deck is not worth a close-up — and never
 * exceeds the orbit's max.
 */
export function fitCamera(bounds: Bounds, aspect: number, turned = false): CameraFit {
	const pad = CAMERA_FIT_PADDING;
	const x = (bounds.minX + bounds.maxX) / 2;
	const z = (bounds.minZ + bounds.maxZ) / 2;
	const halfW = ((bounds.maxX - bounds.minX) / 2) * pad;
	const halfH = ((bounds.maxZ - bounds.minZ) / 2) * pad;
	const [sx, sz] = turned ? [halfH, halfW] : [halfW, halfH];
	const halfTan = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
	const needed = Math.max(sx / (aspect * halfTan), sz / halfTan);
	return { x, z, distance: Math.min(CAMERA_MAX_DISTANCE, Math.max(CAMERA_DEFAULT_HEIGHT, needed)) };
}
