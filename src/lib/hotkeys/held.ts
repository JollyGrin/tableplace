import toast from 'svelte-french-toast';

/**
 * Held-by (tableplace-199): say why a grab did nothing — another player has
 * the thing in hand. One toast id, so grabbing at it over and over replaces
 * the note instead of stacking a column of them.
 */
export function toastHeld(holder: string) {
	toast(`${holder} is holding that`, { id: 'held-refusal', icon: '✋', duration: 1800 });
}
