import toast from 'svelte-french-toast';
import { gameActions } from '$lib/store/game/actions';
import type { LockableKind } from '$lib/store/game/actions/lock';

/**
 * What a refused move on a pinned thing says — the drag's toast and the verb
 * registry's `reasonDisabled`. Names the key, because the fix is one press away.
 */
export const LOCKED_REFUSAL = 'Locked — press L to unlock';

/**
 * Toast the refusal. One toast id, so dragging at a pinned board over and
 * over replaces the message instead of stacking a column of them.
 */
export function toastLocked() {
	toast(LOCKED_REFUSAL, { id: 'locked-refusal', icon: '🔒', duration: 1800 });
}

/** `L` (and the wheel's Lock wedge): pin or unpin the entity, and say which */
export function toggleLockOn(kind: LockableKind, id: string) {
	const locked = gameActions.toggleLock(kind, id);
	if (locked === undefined) return;
	toast(locked ? 'Locked in place' : 'Unlocked', {
		id: 'locked-refusal',
		icon: locked ? '🔒' : '🔓',
		duration: 1400
	});
}
