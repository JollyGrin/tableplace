import type { CardInDeck } from '$lib/store/game/types';

/** cards per drawer page: a 100-card deck is three pages, never one long grid */
export const SEARCH_PAGE_SIZE = 40;

export type SearchView = {
	cards: CardInDeck[];
	/** cards in the deck, before the filter */
	total: number;
	/** the page shown, clamped to what exists */
	page: number;
	pages: number;
};

/**
 * What the drawer shows. A face-down deck is listed by name, not in pile
 * order — searching must not teach you where each card sits. A face-up pile's
 * order is public already, so it lists top first (the top is `cards[0]`).
 */
export function searchView(
	cards: readonly CardInDeck[],
	faceUp: boolean,
	filter = '',
	page = 0
): SearchView {
	const ordered = faceUp
		? [...cards]
		: [...cards].sort(
				(a, b) =>
					(a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }) ||
					a.id.localeCompare(b.id)
			);
	const needle = filter.trim().toLowerCase();
	const matched = needle
		? ordered.filter((card) => (card.name ?? '').toLowerCase().includes(needle))
		: ordered;
	const pages = Math.max(1, Math.ceil(matched.length / SEARCH_PAGE_SIZE));
	const shown = Math.min(Math.max(0, page), pages - 1);
	return {
		cards: matched.slice(shown * SEARCH_PAGE_SIZE, (shown + 1) * SEARCH_PAGE_SIZE),
		total: cards.length,
		page: shown,
		pages
	};
}
