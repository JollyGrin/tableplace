import { derived } from 'svelte/store';
import { dragStore } from '$lib/store/dragStore.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { hoveredPiece } from '$lib/store/pieceUi';
import { hoveredTrayCard } from '$lib/HUDTray/trayHover';
import { isPreviewOpen, previewTarget, type PreviewTarget } from './preview';

/**
 * The preview currently on screen, or null. Recomputed from the hover sources
 * and the store, never written — so a remote flip or a draw from the hovered
 * deck updates the zoom in place, and nothing here can feed back into what it
 * reads.
 */
export const preview = derived(
	[dragStore, gameStore, hoveredTrayCard, hoveredPiece],
	([$drag, $game, $trayCard, $piece]): PreviewTarget | null => {
		if (!isPreviewOpen($drag)) return null;
		return previewTarget($game, gameActions.getMyId(), {
			trayCard: $trayCard,
			card: $drag.isHovered,
			deck: $drag.isDeckHovered,
			piece: $piece
		});
	}
);
