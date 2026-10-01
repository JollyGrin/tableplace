import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import PlayerHud from '../PlayerHud.svelte';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import type { GameDTO } from '$lib/store/game/types';

const card = {
	position: [0, 0, 0] as [number, number, number],
	rotation: [0, 0, 0] as [number, number, number],
	faceImageUrl: 'face.png'
};

const state: Partial<GameDTO> = {
	players: {
		me: { id: 'me', seat: 0, joinTimestamp: 10, tray: { 'card:me:main-1': card }, metadata: {} },
		them: {
			id: 'them',
			seat: 1,
			joinTimestamp: 20,
			tray: { 'card:them:secret-ace': card, 'card:them:secret-king': card },
			metadata: {}
		},
		seat2: {
			id: 'seat2',
			seat: 2,
			joinTimestamp: 0,
			tray: { 'card:seat2:dealt-1': card, 'card:seat2:dealt-2': card, 'card:seat2:dealt-3': card },
			metadata: {}
		}
	},
	decks: {
		'deck:them:main': {
			id: 'deck:them:main',
			cards: [{ id: 'card:them:main-1', faceImageUrl: 'face.png' }]
		}
	},
	cards: {}
};

describe('PlayerHud', () => {
	beforeEach(() => {
		cleanup();
		localStorage.clear();
		localStorage.setItem('myPlayerId', 'me');
		gameStore.set(state);
	});

	it('lists every player, marks me, and shows open seats', () => {
		render(PlayerHud);
		expect(screen.getByText('me')).toBeTruthy();
		expect(screen.getByText('them')).toBeTruthy();
		expect(screen.getByText('you')).toBeTruthy();
		expect(screen.getByText('Seat 2 — open')).toBeTruthy();
	});

	it('shows a hand count on open-seat rows too', () => {
		const { container } = render(PlayerHud);
		const openRow = container.querySelector('[data-open-seat="true"]');
		expect(openRow?.textContent).toContain('hand 3');
		expect(openRow?.textContent).toContain('click to sit here');
	});

	it('shows counts only — never another player’s card ids', () => {
		const { container } = render(PlayerHud);
		expect(container.textContent).toContain('hand 2');
		expect(container.textContent).toContain('main');
		expect(container.textContent).not.toContain('secret-ace');
		expect(container.textContent).not.toContain('secret-king');
		expect(container.querySelectorAll('img').length).toBe(0);
	});

	it('updates live when a card moves from a deck into a tray', async () => {
		const { container } = render(PlayerHud);
		expect(container.textContent).toContain('main 1');

		gameStore.set({
			...state,
			players: {
				...state.players,
				them: { ...state.players!.them, tray: { ...state.players!.them.tray, extra: card } }
			},
			decks: { 'deck:them:main': { id: 'deck:them:main', cards: [] } }
		} as Partial<GameDTO>);
		await Promise.resolve();

		expect(container.textContent).toContain('hand 3');
		expect(container.textContent).toContain('main 0');
	});

	it('claims an open seat when its row is clicked', async () => {
		gameStore.updateState({
			decks: {
				'deck:seat2:main': {
					id: 'deck:seat2:main',
					cards: [{ id: 'card:seat2:main-1', faceImageUrl: 'face.png' }]
				}
			}
		});
		render(PlayerHud);
		await fireEvent.click(screen.getByRole('button', { name: /seat 2 — open/i }));

		const state = get(gameStore);
		expect(state.players?.seat2).toBeUndefined();
		expect(state.players?.me?.seat).toBe(2);
		expect(Object.keys(state.decks ?? {})).toContain('deck:me:main');
	});

	it('collapses to a summary and persists the choice', async () => {
		const { container, unmount } = render(PlayerHud);
		await fireEvent.click(screen.getByRole('button', { name: /players/i }));

		expect(container.textContent).toContain('2 players · 1 open');
		expect(container.textContent).not.toContain('Seat 2 — open');
		expect(localStorage.getItem('hud:players:collapsed')).toBe('true');

		// a reload re-reads the flag and starts collapsed
		unmount();
		const reloaded = render(PlayerHud);
		expect(reloaded.container.textContent).not.toContain('Seat 2 — open');
	});

	it('renders every dot as offline when no presence patch ever arrived', () => {
		const { container } = render(PlayerHud);
		// fixture state has no `connected` anywhere — offline-unknown, never green
		const dots = container.querySelectorAll('[data-connected]');
		expect(dots.length).toBe(2); // me + them; open seats get no dot
		dots.forEach((dot) => expect(dot.getAttribute('data-connected')).toBe('false'));
	});

	it('flips a dot live when a presence patch lands', async () => {
		const { container } = render(PlayerHud);
		const dotFor = (id: string) =>
			container
				.querySelector(`[title="${id}"]`)
				?.parentElement?.querySelector('[data-connected]')
				?.getAttribute('data-connected');

		gameStore.set({
			...state,
			players: { ...state.players, them: { ...state.players!.them, connected: true } }
		} as Partial<GameDTO>);
		await Promise.resolve();
		expect(dotFor('them')).toBe('true');
		expect(dotFor('me')).toBe('false');

		gameStore.set({
			...state,
			players: { ...state.players, them: { ...state.players!.them, connected: false } }
		} as Partial<GameDTO>);
		await Promise.resolve();
		expect(dotFor('them')).toBe('false');
	});

	it('never renders a presence-only ghost row', async () => {
		const { container } = render(PlayerHud);
		gameStore.set({
			...state,
			players: { ...state.players, ghost: { connected: true } }
		} as Partial<GameDTO>);
		await Promise.resolve();
		expect(container.textContent).not.toContain('ghost');
		expect(container.textContent).toContain('2 players · 1 open');
	});

	it('reveals a peer once their join re-publish lands', async () => {
		const { container } = render(PlayerHud);
		// what a peer's client holds before the re-publish: seat/tray/presence
		// patches only — the join row itself was dropped pre-connect
		gameStore.set({
			players: {
				me: state.players!.me,
				peer: { seat: 1, tray: {}, connected: true }
			}
		} as Partial<GameDTO>);
		await Promise.resolve();
		expect(container.textContent).not.toContain('peer');

		// the re-publish arrives as an ordinary update merge patch
		gameStore.updateStateSilently({ players: { peer: { id: 'peer', joinTimestamp: 123 } } });
		await Promise.resolve();
		expect(container.textContent).toContain('peer');
		// the presence that arrived before the row completed still shows
		const dot = container
			.querySelector('[title="peer"]')
			?.parentElement?.querySelector('[data-connected]');
		expect(dot?.getAttribute('data-connected')).toBe('true');
	});

	it('lets pointer events through everywhere but the HUD box', () => {
		const { container } = render(PlayerHud);
		const wrapper = container.querySelector('div');
		expect(wrapper?.className).toContain('pointer-events-none');
		expect(wrapper?.firstElementChild?.className).toContain('pointer-events-auto');
	});
});
