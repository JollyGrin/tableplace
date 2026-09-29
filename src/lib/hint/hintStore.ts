import { derived } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { hoveredPiece } from '$lib/store/pieceUi';
import { hoveredTrayCard } from '$lib/HUDTray/trayHover';
import { tableFeatures } from '$lib/store/tableFeatures';
import { resolveDrop } from '$lib/utils/transforms/drop';
import { modelSurfaceYAt } from '$lib/models/surface';
import { targetsUnder } from '$lib/verbs/keyboard';
import { hintFor, type Hint } from './hint';

/**
 * The hint bar's line, derived from the hover sources and the store and never
 * written — a store subscription, not an effect, so nothing here can feed
 * back into what it reads. Hover stores update synchronously on the pointer
 * event, so the line is current by the next paint.
 */
export const hint = derived(
	[dragStore, gameStore, hoveredPiece, hoveredTrayCard, tableFeatures],
	([$drag, $game, $piece, $trayCard, $features]): Hint => {
		const dragging = $drag.isDragging;
		// the same resolution, with the same options, as DropIndicator and the
		// commit — so the words say what the landing will actually be
		const drop = dragging
			? resolveDrop(
					$game,
					dragging,
					$drag.intersectionPoint,
					{ deckId: $drag.isDeckHovered, bagId: $drag.isBagHovered, tray: $drag.isTrayHovered },
					{ noSnap: $drag.noSnap, hand: $features.hand, surfaceYAt: modelSurfaceYAt(dragging) }
				)
			: null;
		return hintFor({
			game: $game,
			actor: { playerId: gameActions.getMyId() },
			targets: targetsUnder($drag, $piece, $trayCard),
			dragging,
			dropKind: drop?.kind ?? null
		});
	}
);
