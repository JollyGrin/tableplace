import { describe, expect, it } from 'vitest';
import { searchView, SEARCH_PAGE_SIZE } from '../view';

const cards = Array.from({ length: 100 }, (_, i) => ({
	id: `c${i}`,
	faceImageUrl: '',
	name: `Card ${100 - i}`
}));

describe('searchView', () => {
	it('pages a 100-card deck', () => {
		const view = searchView(cards, false);
		expect(view.cards).toHaveLength(SEARCH_PAGE_SIZE);
		expect(view.pages).toBe(Math.ceil(100 / SEARCH_PAGE_SIZE));
		expect(searchView(cards, false, '', 99).page).toBe(view.pages - 1);
	});

	it('lists a face-down deck by name, hiding pile order', () => {
		expect(searchView(cards, false).cards[0]!.name).toBe('Card 1');
	});

	it('keeps a face-up pile in pile order, top first', () => {
		expect(searchView(cards, true).cards[0]!.id).toBe('c0');
	});

	it('filters by name', () => {
		const view = searchView(cards, false, 'card 42');
		expect(view.cards.map((c) => c.name)).toEqual(['Card 42']);
		expect(view.total).toBe(100);
	});
});
