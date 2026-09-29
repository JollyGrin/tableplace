import { writable } from 'svelte/store';

/**
 * Single shared hover owner across all tray cards. Expanded cards overlap
 * their neighbors, so per-card enter/leave flags could leave two cards
 * expanded at once — the latest pointerenter claims hover, collapsing the rest.
 *
 * A module store rather than TrayCard-local state because the zoomed preview
 * (HUDPreview) reads it too: a hand card is previewable like a table card.
 */
export const hoveredTrayCard = writable<string | null>(null);
