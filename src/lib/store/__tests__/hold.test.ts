/**
 * Held-by (tableplace-199): a card, deck or piece in someone's hand says so,
 * and nobody else can grab it.
 *
 * What these pin: the hold rides the carry patch and the landing patch — never
 * a message of its own, checked through the real throttle; another player's
 * live hold refuses a drag (the lead) and stays behind (a group member); a
 * disconnected holder's hold reads as released; every way a drag ends lets go;
 * nothing written to or read from a scenario carries a hold; and the journal
 * never takes hold churn for an action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const sent: { value: Record<string, Record<string, Record<string, unknown>>> }[] = [];
vi.mock('$lib/websocket/connection', () => ({
	sendMessage: (message: never) => {
		sent.push(message);
		return true;
	}
}));
vi.mock('$lib/utils/transforms/websocket', () => ({
	createWsMetaData: () => ({ playerId: 'me', timestamp: Date.now(), type: 'update' })
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('svelte-french-toast', () => ({
	default: Object.assign(toast, { error: vi.fn(), success: vi.fn() })
}));

import { wsWrapperUpdateGameState } from '$lib/websocket/storeIntegration';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { carryPatch, dragActions, dragStart, dragStore } from '$lib/store/dragStore.svelte';
import { clearSelection, setSelection } from '$lib/store/selection';
import { cancelActiveDrag, commitActiveDrag } from '$lib/drop/commit';
import { heldByOther, releaseHoldsPatch, withoutHolds } from '$lib/store/hold';
import { parseScenarioFile, serializeScenarioFile } from '$lib/scenario/file';
import { saveScenario } from '$lib/scenario/scenario';
import { createJournal, SETTLE_MS } from '$lib/journal/journal';
import type { JournalEntry } from '$lib/journal/entry';
import type { GameDTO } from '$lib/store/game/types';

const CARD = 'card:me:a';
const PIECE = 'piece:me:t';
const DECK = 'deck:me:main';
const THEIRS = 'piece:other:t';

const player = (id: string, seat: 0 | 1, connected?: boolean) => ({
	id,
	seat,
	joinTimestamp: 1,
	tray: {},
	metadata: {},
	...(connected === undefined ? {} : { connected })
});

function seed(extra: Partial<GameDTO> = {}) {
	gameStore.set({
		players: { me: player('me', 0, true), other: player('other', 1, true) },
		cards: { [CARD]: { position: [0, 0.3, 0], rotation: [0, 0, 0], faceImageUrl: 'f.png' } },
		decks: {
			[DECK]: {
				id: DECK,
				position: [8, 0.4, 0],
				rotation: [0, 0, 0],
				cards: [{ id: 'c0', faceImageUrl: 'f.png' }]
			}
		},
		pieces: {
			[PIECE]: { position: [3, 0.3, 0], rotation: [0, 0, 0], kind: 'token', name: 'T' },
			[THEIRS]: { position: [5, 0.3, 0], rotation: [0, 0, 0], kind: 'token', name: 'U' }
		},
		...extra
	} as GameDTO);
}

const state = () => get(gameStore)!;
/** what `other` writes while carrying `id` — the relay lands it on us */
const otherHolds = (id: string) =>
	gameStore.updateStateSilently({
		pieces: { [id]: { heldBy: 'other' } }
	} as never);

/** release the current drag with the pointer over (x, z) */
function releaseAt(x: number, z: number) {
	dragStore.update((s) => ({ ...s, intersectionPoint: { x, z } as never }));
	commitActiveDrag();
}

beforeEach(() => {
	localStorage.setItem('myPlayerId', 'me');
	sent.length = 0;
	toast.mockClear();
	dragActions.reset();
	clearSelection();
	seed();
});

afterEach(() => vi.useRealTimers());

describe('the carry patch', () => {
	it('stamps every carried entity with the carrier, in the same patch as its position', () => {
		setSelection([PIECE, CARD]);
		dragStart(PIECE, 0.3, [3, 0.3, 0]);
		const patch = carryPatch(get(dragStore), 1, 1) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		expect(patch.pieces[PIECE]).toMatchObject({ heldBy: 'me', position: expect.any(Array) });
		expect(patch.cards[CARD]).toMatchObject({ heldBy: 'me', position: expect.any(Array) });
	});

	it('costs no message of its own: a whole drag sends what it sent before holds existed', () => {
		vi.useFakeTimers();
		const update = wsWrapperUpdateGameState((patch: never) => gameStore.updateStateSilently(patch));
		dragStart(PIECE, 0.3, [3, 0.3, 0]);
		for (let tick = 0; tick < 120; tick++) {
			update(carryPatch(get(dragStore), 3 + tick * 0.02, 0));
			vi.advanceTimersByTime(1000 / 60);
		}
		// the release goes through the same wrapper the real store is wrapped in
		const original = gameStore.updateState;
		gameStore.updateState = update as typeof gameStore.updateState;
		try {
			releaseAt(6, 1);
		} finally {
			gameStore.updateState = original;
		}
		vi.advanceTimersByTime(500);

		// 2 s at 5 Hz: one leading send, one per 200 ms window after it
		expect(sent.length).toBeLessThanOrEqual(2 * 5 + 1);
		const writes = sent.map((message) => message.value.pieces?.[PIECE]);
		// every message is a move: the hold rides them and never travels alone
		expect(writes.every((write) => Array.isArray(write?.position))).toBe(true);
		expect(writes[0]).toMatchObject({ heldBy: 'me' });
		expect(writes.at(-1)).toMatchObject({ heldBy: null });
		expect(state().pieces?.[PIECE]?.heldBy).toBeUndefined();
	});
});

describe("another player's hold", () => {
	it('refuses a drag of the entity they hold, and says who has it', () => {
		otherHolds(THEIRS);
		expect(dragStart(THEIRS, 0.3, [5, 0.3, 0])).toBe(false);
		expect(get(dragStore).isDragging).toBeNull();
		expect(toast).toHaveBeenCalledWith(expect.stringContaining('other'), expect.anything());
	});

	it('leaves a held member behind when the rest of a selection is dragged', () => {
		otherHolds(THEIRS);
		setSelection([PIECE, THEIRS, CARD]);
		expect(dragStart(PIECE, 0.3, [3, 0.3, 0])).toBe(true);
		expect(get(dragStore).group?.map((member) => member.id)).toEqual([CARD]);
	});

	it('reads as released once the holder disconnects', () => {
		otherHolds(THEIRS);
		gameStore.updateStateSilently({ players: { other: { connected: false } } });
		expect(heldByOther(state(), THEIRS)).toBeNull();
		expect(dragStart(THEIRS, 0.3, [5, 0.3, 0])).toBe(true);
		// and the next carry simply takes it over
		const patch = carryPatch(get(dragStore), 5, 1) as Record<string, Record<string, unknown>>;
		expect(patch.pieces[THEIRS]).toMatchObject({ heldBy: 'me' });
	});

	it('reads as released when the holder is not at the table at all', () => {
		gameStore.updateStateSilently({ pieces: { [THEIRS]: { heldBy: 'ghost' } } } as never);
		expect(heldByOther(state(), THEIRS)).toBeNull();
	});

	it('never refuses its own holder', () => {
		gameStore.updateStateSilently({ pieces: { [PIECE]: { heldBy: 'me' } } } as never);
		expect(heldByOther(state(), PIECE)).toBeNull();
		expect(dragStart(PIECE, 0.3, [3, 0.3, 0])).toBe(true);
	});
});

describe('every way a drag ends lets go', () => {
	const carry = (id: string, origin: [number, number, number]) => {
		dragStart(id, 0.3, origin);
		gameStore.updateState(carryPatch(get(dragStore), origin[0] + 1, 1)!);
	};

	it('a drop on the table', () => {
		carry(PIECE, [3, 0.3, 0]);
		expect(state().pieces?.[PIECE]?.heldBy).toBe('me');
		releaseAt(4, 1);
		expect(state().pieces?.[PIECE]?.heldBy).toBeUndefined();
	});

	it('a group drop', () => {
		setSelection([PIECE, CARD]);
		carry(PIECE, [3, 0.3, 0]);
		expect(state().cards?.[CARD]?.heldBy).toBe('me');
		releaseAt(4, 1);
		expect(state().pieces?.[PIECE]?.heldBy).toBeUndefined();
		expect(state().cards?.[CARD]?.heldBy).toBeUndefined();
	});

	it('Esc, for one entity and for a group', () => {
		carry(CARD, [0, 0.3, 0]);
		cancelActiveDrag();
		expect(state().cards?.[CARD]).toMatchObject({ position: [0, 0.3, 0] });
		expect(state().cards?.[CARD]?.heldBy).toBeUndefined();

		setSelection([PIECE, CARD]);
		carry(PIECE, [3, 0.3, 0]);
		cancelActiveDrag();
		expect(state().pieces?.[PIECE]?.heldBy).toBeUndefined();
		expect(state().cards?.[CARD]?.heldBy).toBeUndefined();
	});

	it('into a hand, and onto a pile: the card carries no hold in', () => {
		carry(CARD, [0, 0.3, 0]);
		dragStore.update((s) => ({ ...s, isTrayHovered: true }));
		releaseAt(0, 0);
		expect(state().players?.me?.tray?.[CARD]).toBeDefined();
		expect(state().players?.me?.tray?.[CARD]).not.toHaveProperty('heldBy');

		seed();
		carry(CARD, [0, 0.3, 0]);
		dragStore.update((s) => ({ ...s, isTrayHovered: false, isDeckHovered: DECK }));
		releaseAt(8, 0);
		const top = state().decks?.[DECK]?.cards?.at(-1);
		expect(top?.id).toBe(CARD);
		expect(top).not.toHaveProperty('heldBy');
	});
});

describe('holds and files', () => {
	const held = (): Partial<GameDTO> => ({
		cards: { [CARD]: { position: [0, 0.3, 0], faceImageUrl: 'f.png', heldBy: 'me' } },
		decks: { [DECK]: { id: DECK, cards: [], heldBy: 'other' } },
		pieces: { [PIECE]: { kind: 'token', name: 'T', heldBy: 'other' } },
		players: {
			seat0: { tray: { 'card:seat0:x': { faceImageUrl: 'f.png', heldBy: 'me' } } }
		}
	});

	it('withoutHolds strips every hold, and leaves a hold-free state as it is', () => {
		const text = JSON.stringify(withoutHolds(held()));
		expect(text).not.toContain('heldBy');
		expect(text).toContain('f.png');
		const clean = { cards: { [CARD]: { faceImageUrl: 'f.png' } } };
		expect(withoutHolds(clean)).toBe(clean);
	});

	it('a saved scenario carries no hold, even saved mid-drag', () => {
		gameStore.set({ players: {}, ...held() } as GameDTO);
		const scenario = saveScenario('mid-drag');
		expect(JSON.stringify(scenario)).not.toContain('heldBy');
	});

	it('an exported file carries none, and an imported one has any stripped', () => {
		const scenario = { name: 'x', createdAt: 1, state: held() };
		expect(serializeScenarioFile(scenario)).not.toContain('heldBy');
		const smuggled = JSON.stringify({ tbps: 1, name: 'x', createdAt: 1, state: held() });
		expect(JSON.stringify(parseScenarioFile(smuggled))).not.toContain('heldBy');
	});

	it('releaseHoldsPatch lets go of exactly this player’s holds', () => {
		expect(releaseHoldsPatch(held(), 'me')).toEqual({ cards: { [CARD]: { heldBy: null } } });
		expect(releaseHoldsPatch(held(), 'nobody')).toBeNull();
	});
});

describe('the journal and holds', () => {
	function journalOn(initial: Record<string, Record<string, unknown>>) {
		let table = structuredClone(initial);
		const entries: JournalEntry[] = [];
		let dragging = false;
		const merge = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(patch)) {
				if (value === null) delete target[key];
				else if (typeof value === 'object' && !Array.isArray(value))
					merge((target[key] ??= {}) as Record<string, unknown>, value as Record<string, unknown>);
				else target[key] = value;
			}
		};
		// eslint-disable-next-line prefer-const -- `write` closes over it first
		let journal!: ReturnType<typeof createJournal>;
		const write = (patch: Record<string, unknown>) => {
			journal.record(patch, structuredClone(table));
			merge(table, patch);
		};
		journal = createJournal({
			getState: () => table,
			apply: write,
			send: (entry) => entries.push(entry),
			myId: () => 'me',
			isDragging: () => dragging,
			notify: () => {}
		});
		return {
			journal,
			write,
			entries,
			drag: (on: boolean) => (dragging = on),
			state: () => table,
			reset: (next: typeof initial) => (table = structuredClone(next))
		};
	}

	it('a drag is one move, and its undo puts the position back without a hold', () => {
		vi.useFakeTimers();
		const t = journalOn({ pieces: { [PIECE]: { position: [0, 0, 0], name: 'T', kind: 'token' } } });
		t.drag(true);
		t.write({ pieces: { [PIECE]: { position: [1, 1, 0], heldBy: 'me' } } });
		t.write({ pieces: { [PIECE]: { position: [2, 1, 0], heldBy: 'me' } } });
		t.drag(false);
		t.write({ pieces: { [PIECE]: { position: [2, 0, 0], heldBy: null } } });
		vi.advanceTimersByTime(SETTLE_MS + 10);
		expect(t.entries.map((entry) => entry.verb)).toEqual(['move']);
		t.journal.undo();
		expect(t.state().pieces[PIECE]).toMatchObject({ position: [0, 0, 0] });
		expect(t.state().pieces[PIECE]).not.toHaveProperty('heldBy');
	});

	it('a write that only takes or lets go of a hold is no action and no touch', () => {
		vi.useFakeTimers();
		const t = journalOn({ pieces: { [PIECE]: { position: [0, 0, 0], name: 'T', kind: 'token' } } });
		t.write({ pieces: { [PIECE]: { position: [3, 0, 0] } } });
		vi.advanceTimersByTime(SETTLE_MS + 10);
		t.write({ pieces: { [PIECE]: { heldBy: null } } });
		t.journal.remotePatch({ pieces: { [PIECE]: { heldBy: 'other' } } }, 'other');
		vi.advanceTimersByTime(SETTLE_MS + 10);
		expect(t.entries.map((entry) => entry.verb)).toEqual(['move']);
		// the peer's hold alone did not touch it: the move can still be undone
		expect(t.journal.undo()).toBe(true);
	});
});
