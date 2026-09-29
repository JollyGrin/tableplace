import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createJournal, SETTLE_MS, type Journal } from '../journal';
import { entryText, type JournalEntry } from '../entry';
import { inverseOf, stillAsLeft } from '../diff';

/* eslint-disable @typescript-eslint/no-explicit-any -- a loose in-memory table */
type State = Record<string, Record<string, any>>;

/** the store's merge: `null` deletes, records recurse, anything else replaces */
function merge(target: any, patch: any): any {
	if (patch === null) return undefined;
	if (typeof patch !== 'object' || Array.isArray(patch) || typeof target !== 'object' || !target)
		return structuredClone(patch);
	const out = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		const next = merge(out[key], value);
		if (next === undefined) delete out[key];
		else out[key] = next;
	}
	return out;
}

function table(initial: State) {
	let state: State = structuredClone(initial);
	const sent: JournalEntry[] = [];
	const notes: string[] = [];
	let dragging = false;
	// eslint-disable-next-line prefer-const -- assigned once, but `write` closes over it first
	let journal!: Journal;
	/** a write by this client, the way gameStore.updateState makes one */
	const write = (patch: object) => {
		journal.record(patch, state);
		state = merge(state, patch);
	};
	journal = createJournal({
		getState: () => state,
		apply: write,
		send: (entry) => sent.push(entry),
		myId: () => 'alice',
		isDragging: () => dragging,
		notify: (message) => notes.push(message)
	});
	return {
		journal,
		write,
		/** a peer's write: lands silently, and the journal hears who made it */
		peer: (patch: object, from = 'bob') => {
			state = merge(state, patch);
			journal.remotePatch(patch, from);
		},
		settle: () => vi.advanceTimersByTime(SETTLE_MS + 10),
		setDragging: (value: boolean) => (dragging = value),
		state: () => state,
		sent,
		notes,
		lines: () => get(journal.log).map(entryText)
	};
}

const PIECE = 'piece:alice:a';
const CARD = 'card:alice:ace';

const start = (): State => ({
	pieces: {
		[PIECE]: { kind: 'token', name: 'Marker', position: [0, 0, 0], rotation: [0, 0, 0] },
		'piece:alice:hp': { kind: 'counter', name: 'Tally', value: 10, position: [2, 0, 0] },
		'piece:alice:d6': { kind: 'die', name: 'Die', value: 1, rollSeq: 0, position: [4, 0, 0] }
	},
	cards: {
		[CARD]: { name: 'Ace', position: [1, 0, 1], rotation: [0, 0, 0], faceImageUrl: 'x' }
	},
	decks: {
		'deck:alice:main': {
			id: 'deck:alice:main',
			position: [5, 0, 5],
			rotation: [0, 0, 0],
			cards: [{ name: 'Two' }, { name: 'Three' }]
		}
	},
	players: { alice: { id: 'alice', seat: 0, tray: {} } }
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('recording', () => {
	it('a drag streamed as many patches is one move, however long it is held', () => {
		const t = table(start());
		t.setDragging(true);
		for (let x = 1; x <= 5; x++) {
			t.write({ pieces: { [PIECE]: { position: [x, 0, 0] } } });
			vi.advanceTimersByTime(SETTLE_MS * 2); // held still mid-drag
		}
		expect(t.sent).toHaveLength(0);
		t.setDragging(false);
		t.settle();
		expect(t.sent).toHaveLength(1);
		expect(t.lines()).toEqual(['moved Marker']);
	});

	it('a group drag is one entry, not one per member, and one undo puts them all back', () => {
		const t = table(start());
		const original = structuredClone(t.state());
		t.setDragging(true);
		for (let x = 1; x <= 3; x++) {
			// members may be written together or one by one: either way one action
			t.write({ pieces: { [PIECE]: { position: [x, 0, 0] } } });
			t.write({ cards: { [CARD]: { position: [x + 1, 0, 1] } } });
		}
		t.setDragging(false);
		t.settle();
		expect(t.sent).toHaveLength(1);
		expect(t.lines()).toEqual(['moved Marker and Ace']);
		t.journal.undo();
		expect(t.state()).toEqual(original);
	});

	it('each Q/E press is its own "turned" entry, even in quick succession', () => {
		const t = table(start());
		for (const yaw of [45, 90]) {
			t.journal.verb('turn-cw', [['pieces', PIECE]]);
			t.write({ pieces: { [PIECE]: { rotation: [0, yaw, 0] } } });
			vi.advanceTimersByTime(100);
		}
		t.settle();
		expect(t.lines()).toEqual(['turned Marker', 'turned Marker']);
		t.journal.undo();
		expect(t.state().pieces[PIECE].rotation).toEqual([0, 45, 0]);
	});

	it('a selection verb is one entry for all its members', () => {
		const t = table(start());
		t.journal.verb('flip-selection', [
			['cards', CARD],
			['pieces', PIECE]
		]);
		t.write({ cards: { [CARD]: { rotation: [180, 0, 0] } } });
		t.write({ pieces: { [PIECE]: { rotation: [180, 0, 0] } } });
		t.settle();
		expect(t.sent).toHaveLength(1);
		expect(t.lines()).toEqual(['flipped Marker and a card']);
	});

	it('an unrelated write ends the open action and starts its own', () => {
		const t = table(start());
		t.write({ pieces: { [PIECE]: { position: [1, 0, 0] } } });
		t.write({ cards: { [CARD]: { rotation: [180, 0, 0] } } });
		t.settle();
		expect(t.sent.map((e) => e.verb)).toEqual(['move', 'flip']);
	});

	it('a registry verb names everything its run writes', () => {
		const t = table(start());
		t.journal.verb('draw', [['decks', 'deck:alice:main']]);
		t.write({ decks: { 'deck:alice:main': { cards: [{ name: 'Three' }] } } });
		t.write({ players: { alice: { tray: { 'card:alice:two': { name: 'Two' } } } } });
		t.settle();
		expect(t.sent).toHaveLength(1);
		expect(t.lines()).toEqual(['drew from a deck']);
	});

	it('a verb that writes nothing is only logged when it is worth a line', () => {
		const t = table(start());
		t.journal.verb('focus', []);
		t.settle();
		t.journal.verb('search', [['decks', 'deck:alice:main']]);
		t.settle();
		expect(t.lines()).toEqual(['searched a deck']);
	});

	it('writes that are not a player action (seeding, presence) log nothing', () => {
		const t = table(start());
		t.write({ players: { alice: { joinTimestamp: 1 } } });
		t.write({ pieces: { 'piece:alice:new': { kind: 'token', name: 'New', position: [0, 0, 0] } } });
		t.settle();
		expect(t.sent).toEqual([]);
	});
});

describe('hidden information', () => {
	it('never names a card that ends face down', () => {
		const t = table(start());
		t.write({ cards: { [CARD]: { rotation: [180, 0, 0] } } });
		t.settle();
		expect(t.sent[0].targets).toEqual([{ kind: 'card', id: null, name: null }]);
		expect(t.lines()).toEqual(['flipped a card']);
		expect(JSON.stringify(t.sent)).not.toMatch(/Ace|ace/);
	});

	it('never names a card going into a hand', () => {
		const t = table(start());
		t.write({
			cards: { [CARD]: null },
			players: { alice: { tray: { [CARD]: { name: 'Ace', faceImageUrl: 'x' } } } }
		});
		t.settle();
		expect(t.lines()).toEqual(['took a card into their hand']);
		expect(JSON.stringify(t.sent)).not.toMatch(/Ace|ace/);
	});

	it('names a card that lies face up on the table', () => {
		const t = table(start());
		t.write({ cards: { [CARD]: { position: [3, 0, 3] } } });
		t.settle();
		expect(t.lines()).toEqual(['moved Ace']);
	});
});

describe('counters', () => {
	it('a burst of steps is one line and one undo, first value to last', () => {
		const t = table(start());
		for (const value of [11, 12, 13]) {
			t.write({ pieces: { 'piece:alice:hp': { value } } });
			vi.advanceTimersByTime(200);
		}
		t.settle();
		// a pause, then more of the same counter: still one line
		t.write({ pieces: { 'piece:alice:hp': { value: 14 } } });
		t.settle();
		expect(t.lines()).toEqual(['set Tally 10 → 14']);

		expect(t.journal.undo()).toBe(true);
		expect(t.state().pieces['piece:alice:hp'].value).toBe(10);
		expect(t.lines().at(-1)).toBe('undid: set Tally');
	});

	it('collapses a peer counter run in the log as well', () => {
		const t = table(start());
		const line = (after: number, at: number): JournalEntry => ({
			id: `bob:${after}`,
			actor: 'bob',
			verb: 'count-down',
			targets: [{ kind: 'piece', id: 'piece:bob:hp', name: 'Tally' }],
			count: { before: after + 1, after },
			at
		});
		t.journal.receive(line(9, 1000), 'bob');
		t.journal.receive(line(8, 2000), 'bob');
		t.journal.receive(line(7, 3000), 'bob');
		expect(t.lines()).toEqual(['set Tally 10 → 7']);
	});
});

describe('undo', () => {
	it('restores position, rotation, face and counter value', () => {
		const t = table(start());
		const original = structuredClone(t.state());
		const actions = [
			{ pieces: { [PIECE]: { position: [3, 0, 3] } } },
			{ pieces: { [PIECE]: { rotation: [0, 90, 0] } } },
			{ cards: { [CARD]: { rotation: [180, 0, 0] } } },
			{ pieces: { 'piece:alice:hp': { value: 7 } } }
		];
		for (const patch of actions) {
			t.write(patch);
			t.settle();
		}
		for (let i = 0; i < actions.length; i++) expect(t.journal.undo()).toBe(true);
		expect(t.state()).toEqual(original);
		expect(t.sent.filter((e) => e.verb === 'undo').map((e) => e.undoOf)).toEqual([
			'count-down',
			'flip',
			'rotate-cw',
			'move'
		]);
	});

	it('takes back a card played from the hand', () => {
		const t = table({
			...start(),
			cards: {},
			players: { alice: { id: 'alice', seat: 0, tray: { [CARD]: { name: 'Ace' } } } }
		});
		const original = structuredClone(t.state());
		t.write({
			players: { alice: { tray: { [CARD]: null } } },
			cards: { [CARD]: { name: 'Ace', position: [0, 0, 0], rotation: [0, 0, 0] } }
		});
		t.settle();
		expect(t.lines()).toEqual(['played Ace']);
		t.journal.undo();
		expect(t.state()).toEqual(original);
	});

	it('is refused, with the reason, once another player touched the target', () => {
		const t = table(start());
		t.write({ pieces: { [PIECE]: { position: [3, 0, 3] } } });
		t.settle();
		t.peer({ pieces: { [PIECE]: { position: [6, 0, 6] } } });

		expect(t.journal.undo()).toBe(false);
		expect(t.notes.at(-1)).toMatch(/bob has touched it since you moved Marker/);
		expect(t.state().pieces[PIECE].position).toEqual([6, 0, 6]);
		expect(t.sent.map((e) => e.verb)).toEqual(['move']);
	});

	it("is not blocked by a peer's touch on something else", () => {
		const t = table(start());
		t.write({ pieces: { [PIECE]: { position: [3, 0, 3] } } });
		t.settle();
		t.peer({ cards: { [CARD]: { position: [9, 0, 9] } } });
		expect(t.journal.undo()).toBe(true);
		expect(t.state().pieces[PIECE].position).toEqual([0, 0, 0]);
	});

	it('refuses when nothing of yours is left, and stops at a roll', () => {
		const t = table(start());
		expect(t.journal.undo()).toBe(false);
		expect(t.notes.at(-1)).toBe('Nothing of yours to undo');

		t.write({ pieces: { [PIECE]: { position: [3, 0, 3] } } });
		t.settle();
		t.write({ pieces: { 'piece:alice:d6': { value: 5, rollSeq: 1 } } });
		t.settle();
		expect(t.journal.undo()).toBe(false);
		expect(t.notes.at(-1)).toMatch(/rolled Die can't be taken back/);
		expect(t.state().pieces[PIECE].position).toEqual([3, 0, 3]);
	});

	it('ends an action still settling, so a fast Ctrl+Z takes back the drop just made', () => {
		const t = table(start());
		t.write({ pieces: { [PIECE]: { position: [3, 0, 3] } } });
		expect(t.journal.undo()).toBe(true);
		expect(t.state().pieces[PIECE].position).toEqual([0, 0, 0]);
	});

	it('refuses mid-drag', () => {
		const t = table(start());
		t.setDragging(true);
		expect(t.journal.undo()).toBe(false);
		expect(t.notes.at(-1)).toBe('Put it down first');
	});
});

describe('the wire', () => {
	it('drops a malformed peer entry and never logs its own echo', () => {
		const t = table(start());
		t.journal.receive({ verb: 'move' }, 'bob');
		t.journal.receive({ id: 'alice:1', actor: 'alice', verb: 'move', targets: [], at: 1 }, 'alice');
		expect(t.lines()).toEqual([]);
	});

	it('takes the actor from the relay, not from the payload', () => {
		const t = table(start());
		t.journal.receive({ id: 'x:1', actor: 'alice', verb: 'move', targets: [], at: 1 }, 'bob');
		expect(get(t.journal.log)[0].actor).toBe('bob');
	});
});

describe('diff', () => {
	it('inverts only what changed, deleting what was added', () => {
		expect(inverseOf({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3, d: 4 } })).toEqual({
			b: { c: 2, d: null }
		});
		expect(inverseOf(undefined, { a: 1 })).toBeNull();
		expect(inverseOf({ a: [1, 2] }, { a: [2, 1] })).toEqual({ a: [1, 2] });
	});

	it('stillAsLeft compares only the paths the undo would write', () => {
		const inverse = { pieces: { p: { position: [0, 0, 0] } } };
		const left = { pieces: { p: { position: [1, 0, 0] } } };
		expect(stillAsLeft(inverse, left, { pieces: { p: { position: [1, 0, 0], value: 9 } } })).toBe(
			true
		);
		expect(stillAsLeft(inverse, left, { pieces: { p: { position: [2, 0, 0] } } })).toBe(false);
	});
});
