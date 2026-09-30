import { carriedIds, type DragState } from '$lib/store/dragStore.svelte';
import { modelSurfaceYAt } from '$lib/models/surface';
import { resolveDrop, type DropTarget } from '$lib/utils/transforms/drop';
import { withoutEntities } from '$lib/utils/transforms/group-drop';
import type { GameDTO } from '$lib/store/game/types';

/**
 * Where the entity in the pointer's hand will land — what the drop indicator
 * draws and the hint bar names, resolved with the same options the commit
 * uses (drop/commit.ts).
 *
 * A group drag previews its lead only, and exactly as the group commit
 * resolves it: first, against the table without the rest of the group, and
 * never onto a deck, bag or the hand (see utils/transforms/group-drop.ts).
 */
export function previewDrop(
	state: Partial<GameDTO> | undefined | null,
	drag: Pick<
		DragState,
		| 'isDragging'
		| 'intersectionPoint'
		| 'isDeckHovered'
		| 'isBagHovered'
		| 'isTrayHovered'
		| 'noSnap'
		| 'group'
	>,
	hand: boolean,
	/** the dragged piece's image aspect — see `DropOptions.faceAspect` */
	faceAspect = 1
): DropTarget | null {
	const id = drag.isDragging;
	if (!id) return null;
	if (drag.group?.length) {
		const carried = carriedIds(drag);
		return resolveDrop(
			withoutEntities(state, carried.slice(1)),
			id,
			drag.intersectionPoint,
			{},
			{ noSnap: drag.noSnap, hand, surfaceYAt: modelSurfaceYAt(carried), faceAspect }
		);
	}
	return resolveDrop(
		state,
		id,
		drag.intersectionPoint,
		{ deckId: drag.isDeckHovered, bagId: drag.isBagHovered, tray: drag.isTrayHovered },
		{ noSnap: drag.noSnap, hand, surfaceYAt: modelSurfaceYAt(id), faceAspect }
	);
}
