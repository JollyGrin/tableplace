/**
 * Playing a card out of the hand (tableplace-195).
 *
 * A press on a hand card is only a press until the pointer leaves the hand
 * upward; then the card goes onto the table and into an ordinary table drag
 * (dragStore), face-down by default — or face-up, with the table's
 * `handPlayFace` saying so. Shift plays the other face, and the carried card
 * itself turns over as Shift goes down and up, so what you carry is what
 * lands. The face is settled again from the release's own Shift, before the
 * drop commits.
 */

import { get, writable } from 'svelte/store';
import * as THREE from 'three';
import { dragStart, dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { CARD_BACK_DEFAULT } from '$lib/packs';
import { CARD_DRAG_Y } from '$lib/utils/constants-cards';
import { degrees } from '$lib/utils/constants-rotation';
import { handCardBack, handPlayFace, playFace } from '$lib/utils/hand';
import type { GameDTO, HandPlayFace } from '$lib/store/game/types';
import { getTableCamera } from './drawFlight';

/** the card being played out of the hand, while it is carried; null otherwise */
export const handPlay = writable<{ id: string; face: HandPlayFace } | null>(null);

// the play is over once the drag is: dropped, put back, or taken back in hand
dragStore.subscribe((drag) => {
	const play = get(handPlay);
	if (play && drag.isDragging !== play.id) handPlay.set(null);
});

/** the rotation a card lands with, face up or down, squared to `seat` */
function playRotation(face: HandPlayFace, seat: number): [number, number, number] {
	// 180 on x = face-down (the flipCard convention)
	return [face === 'down' ? 180 : 0, 0, -(degrees[seat] ?? 0) / THREE.MathUtils.DEG2RAD];
}

/** where a screen point meets the table plane, through the table camera */
function tablePointAt(clientX: number, clientY: number, canvas: HTMLElement) {
	const camera = getTableCamera();
	if (!camera) return null;
	const rect = canvas.getBoundingClientRect();
	const ndc = new THREE.Vector2(
		((clientX - rect.left) / rect.width) * 2 - 1,
		-((clientY - rect.top) / rect.height) * 2 + 1
	);
	const raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(ndc, camera);
	const hit = raycaster.ray.intersectPlane(
		new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
		new THREE.Vector3()
	);
	return hit ? { x: hit.x, z: hit.z } : null;
}

/**
 * Put hand card `id` on the table under the pointer and pick it up. One
 * patch: the hand shrinks and the table grows together, so nobody ever sees
 * the card in both places or in neither.
 */
export function playFromHand(
	id: string,
	shift: boolean,
	at: { clientX: number; clientY: number; canvas: HTMLElement }
) {
	const me = gameActions.getMyId();
	const game = get(gameStore);
	const card = me ? game?.players?.[me]?.tray?.[id] : undefined;
	if (!me || !card) return;
	const face = playFace(handPlayFace(game), shift);
	const point = tablePointAt(at.clientX, at.clientY, at.canvas);
	const { x = 0, z = 0 } = point ?? get(dragStore).intersectionPoint ?? {};
	const loose: Partial<GameDTO['cards'][string]> = { ...card };
	delete loose.handOrder;
	gameStore.updateState({
		players: { [me]: { tray: { [id]: null } } },
		cards: {
			[id]: {
				...loose,
				position: [x, CARD_DRAG_Y, z],
				rotation: playRotation(face, gameActions.getMySeat()),
				// face-down, my own preview may still peek at it (tableplace-193)
				...(face === 'down' ? { placedBy: me } : {}),
				faceImageUrl: card.faceImageUrl ?? '',
				backImageUrl: handCardBack(game, me, card) ?? CARD_BACK_DEFAULT
			}
		}
	} as Partial<GameDTO>);
	dragStart(id, CARD_DRAG_Y);
	handPlay.set({ id, face });
}

/**
 * Shift went down or up while a hand card is carried: turn it to the face it
 * would now land on. Nothing is sent when the face already agrees, so a held
 * Shift's key repeat and every pointer move cost nothing.
 */
export function settlePlayFace(shift: boolean) {
	const play = get(handPlay);
	if (!play) return;
	const game = get(gameStore);
	const face = playFace(handPlayFace(game), shift);
	if (face === play.face) return;
	const card = game?.cards?.[play.id];
	const me = gameActions.getMyId();
	if (!card || !me) return;
	const [, yaw = 0, roll = 0] = card.rotation ?? [];
	gameStore.updateState({
		cards: {
			[play.id]: {
				rotation: [face === 'down' ? 180 : 0, yaw, roll],
				placedBy: face === 'down' ? me : null
			}
		}
	} as unknown as Partial<GameDTO>);
	handPlay.set({ ...play, face });
}
