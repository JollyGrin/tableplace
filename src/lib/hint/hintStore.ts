import { derived } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { hoveredPiece } from '$lib/store/pieceUi';
import { hoveredTrayCard } from '$lib/HUDTray/trayHover';
import { tableFeatures } from '$lib/store/tableFeatures';
import { previewDrop } from '$lib/drop/preview';
import { targetsUnder } from '$lib/verbs/keyboard';
import { selectedIds } from '$lib/store/selection';
import { classicMouse } from '$lib/store/mouseMode';
import { handGesture } from '$lib/HUDTray/handGesture';
import { handPlay } from '$lib/HUDTray/handPlay';
import { handPlayFace } from '$lib/utils/hand';
import { hintFor, type Hint } from './hint';

/**
 * The hint bar's line, derived from the hover sources and the store and never
 * written — a store subscription, not an effect, so nothing here can feed
 * back into what it reads. Hover stores update synchronously on the pointer
 * event, so the line is current by the next paint.
 */
export const hint = derived(
	[
		dragStore,
		gameStore,
		hoveredPiece,
		hoveredTrayCard,
		tableFeatures,
		selectedIds,
		classicMouse,
		handPlay,
		handGesture
	],
	([$drag, $game, $piece, $trayCard, $features, $selected, $classic, $play, $gesture]): Hint => {
		const dragging = $drag.isDragging;
		// the same resolution, with the same options, as DropIndicator and the
		// commit — so the words say what the landing will actually be
		const drop = dragging ? previewDrop($game, $drag, $features.hand) : null;
		return hintFor({
			game: $game,
			actor: { playerId: gameActions.getMyId() },
			targets: targetsUnder($drag, $piece, $trayCard, $selected),
			dragging,
			carrying: ($drag.group?.length ?? 0) + (dragging ? 1 : 0),
			classicMouse: $classic,
			dropKind: drop?.kind ?? null,
			handPlay: $play ? { face: $play.face, defaultFace: handPlayFace($game) } : null,
			reordering: $gesture?.id ?? null
		});
	}
);
