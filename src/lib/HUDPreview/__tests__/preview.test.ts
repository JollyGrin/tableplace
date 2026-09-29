import { describe, expect, it } from 'vitest';
import { isPreviewOpen, PEEK_CAPTION, previewTarget, type PreviewHover } from '../preview';
import type { GameDTO } from '$lib/store/game/types';

const none: PreviewHover = { trayCard: null, card: null, deck: null, piece: null };

const game = {
	cards: {
		'card:p1:up': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			faceImageUrl: 'https://x/up.png',
			backImageUrl: 'https://x/back.png',
			name: 'Up card'
		},
		'card:p1:down': {
			position: [0, 0, 0],
			rotation: [180, 0, 0],
			faceImageUrl: 'https://x/hidden.png',
			backImageUrl: 'https://x/back.png',
			name: 'Hidden card'
		},
		'card:p1:placed': {
			position: [0, 0, 0],
			rotation: [180, 0, 0],
			faceImageUrl: 'https://x/placed.png',
			backImageUrl: 'https://x/back.png',
			name: 'Placed card',
			placedBy: 'p1'
		},
		'card:p1:placed-nameless': {
			position: [0, 0, 0],
			rotation: [180, 0, 0],
			faceImageUrl: 'https://x/nameless.png',
			placedBy: 'p1'
		},
		'card:p1:placed-up': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			faceImageUrl: 'https://x/placed-up.png',
			name: 'Placed up',
			placedBy: 'p1'
		},
		'card:p1:wide': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			faceImageUrl: 'https://x/wide.png',
			orientation: 'landscape'
		}
	},
	decks: {
		'deck:p1:down': {
			id: 'deck:p1:down',
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			deckBackImageUrl: 'https://x/deckback.png',
			cards: [
				{ id: 'a', faceImageUrl: 'https://x/a.png', name: 'A' },
				{ id: 'b', faceImageUrl: 'https://x/b.png', name: 'B' }
			]
		},
		'deck:p1:up': {
			id: 'deck:p1:up',
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			isFaceUp: true,
			cards: [
				{ id: 'c', faceImageUrl: 'https://x/c.png', name: 'C' },
				{ id: 'd', faceImageUrl: 'https://x/d.png', name: 'D' }
			]
		},
		'deck:p1:one': {
			id: 'deck:p1:one',
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			cards: [{ id: 'e', faceImageUrl: 'https://x/e.png' }]
		}
	},
	pieces: {
		'piece:p1:token': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			kind: 'token',
			name: 'Marker',
			imageUrl: 'https://x/token.png'
		},
		'piece:p1:states': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			kind: 'token',
			name: 'Tile',
			state: 1,
			states: [
				{ face: 'https://x/s0.png', name: 'Front' },
				{ face: 'https://x/s1.png', name: 'Back' }
			]
		},
		'piece:p1:plain': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			kind: 'pawn',
			name: 'Pawn'
		},
		'piece:p1:die': {
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			kind: 'die',
			name: 'd6',
			imageUrl: 'https://x/die.png'
		}
	},
	players: {
		p1: {
			id: 'p1',
			seat: 0,
			joinTimestamp: 0,
			metadata: {},
			tray: {
				'card:p1:hand': {
					faceImageUrl: 'https://x/hand.png',
					rotation: [180, 0, 0],
					name: 'Hand card'
				}
			}
		}
	}
} as unknown as Partial<GameDTO>;

describe('isPreviewOpen', () => {
	it('opens on Space or Alt', () => {
		expect(isPreviewOpen({ isDragging: null, isPreview: true })).toBe(true);
		expect(isPreviewOpen({ isDragging: null, noSnap: true })).toBe(true);
		expect(isPreviewOpen({ isDragging: null })).toBe(false);
	});

	it('never opens while dragging — Alt then only means no-snap', () => {
		expect(isPreviewOpen({ isDragging: 'card:p1:up', isPreview: true, noSnap: true })).toBe(false);
	});
});

describe('previewTarget', () => {
	it('shows nothing when nothing is hovered', () => {
		expect(previewTarget(game, 'p1', none)).toBeNull();
	});

	it('shows my hand card face up, with its name, even if it was stored face down', () => {
		expect(previewTarget(game, 'p1', { ...none, trayCard: 'card:p1:hand' })).toMatchObject({
			id: 'card:p1:hand',
			face: 'https://x/hand.png',
			caption: 'Hand card',
			shape: 'card'
		});
	});

	it('only reads MY tray', () => {
		expect(previewTarget(game, 'p2', { ...none, trayCard: 'card:p1:hand' })).toBeNull();
	});

	it('a hovered hand card beats the table under it', () => {
		const target = previewTarget(game, 'p1', {
			...none,
			trayCard: 'card:p1:hand',
			card: 'card:p1:up'
		});
		expect(target?.id).toBe('card:p1:hand');
	});

	it('shows a face-up table card with its name', () => {
		expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:up' })).toMatchObject({
			face: 'https://x/up.png',
			caption: 'Up card'
		});
	});

	it('a face-down table card shows its back and never its name', () => {
		expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:down' })).toMatchObject({
			face: 'https://x/back.png',
			caption: ''
		});
	});

	describe('peek (a face-down card I laid out of my hand)', () => {
		it('shows me its face, captioned that only I see it', () => {
			expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:placed' })).toMatchObject({
				face: 'https://x/placed.png',
				caption: `Placed card · ${PEEK_CAPTION}`
			});
		});

		it('the caption stands alone when the card has no name', () => {
			expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:placed-nameless' })).toMatchObject(
				{ face: 'https://x/nameless.png', caption: PEEK_CAPTION }
			);
		});

		it('shows everyone else its back and never its name', () => {
			expect(previewTarget(game, 'p2', { ...none, card: 'card:p1:placed' })).toMatchObject({
				face: 'https://x/back.png',
				caption: ''
			});
		});

		it('shows nobody the face without knowing who is looking', () => {
			expect(previewTarget(game, undefined, { ...none, card: 'card:p1:placed' })).toMatchObject({
				face: 'https://x/back.png',
				caption: ''
			});
		});

		it('a face-up card needs no peek caption, even with a stale mark', () => {
			expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:placed-up' })).toMatchObject({
				face: 'https://x/placed-up.png',
				caption: 'Placed up'
			});
		});
	});

	it('carries landscape orientation', () => {
		expect(previewTarget(game, 'p1', { ...none, card: 'card:p1:wide' })?.landscape).toBe(true);
	});

	it('a face-down deck shows its back and its count', () => {
		expect(previewTarget(game, 'p1', { ...none, deck: 'deck:p1:down' })).toMatchObject({
			face: 'https://x/deckback.png',
			caption: '2 cards'
		});
		expect(previewTarget(game, 'p1', { ...none, deck: 'deck:p1:one' })).toMatchObject({
			face: 'gen:std52/back',
			caption: '1 card'
		});
	});

	it('a face-up deck shows its top card (cards[0]) and name', () => {
		expect(previewTarget(game, 'p1', { ...none, deck: 'deck:p1:up' })).toMatchObject({
			face: 'https://x/c.png',
			caption: 'C · 2 cards'
		});
	});

	it('a token previews as a disc with its name', () => {
		expect(previewTarget(game, 'p1', { ...none, piece: 'piece:p1:token' })).toMatchObject({
			face: 'https://x/token.png',
			shape: 'disc',
			caption: 'Marker'
		});
	});

	it('a multi-state piece previews its current face and state name', () => {
		expect(previewTarget(game, 'p1', { ...none, piece: 'piece:p1:states' })).toMatchObject({
			face: 'https://x/s1.png',
			caption: 'Tile — Back'
		});
	});

	it('an imageless piece or a die has nothing to preview', () => {
		expect(previewTarget(game, 'p1', { ...none, piece: 'piece:p1:plain' })).toBeNull();
		expect(previewTarget(game, 'p1', { ...none, piece: 'piece:p1:die' })).toBeNull();
	});
});
