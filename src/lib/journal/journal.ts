/**
 * The action journal (tableplace-201): a shared log of what just happened at
 * the table, and undo for your own last action.
 *
 * Recording. Every patch this client makes passes `record` first, with the
 * state it is about to land on. Patches are gathered into one *action*:
 * - a verb from the registry opens a labelled action, and everything it
 *   writes in the next moment belongs to it (a draw touches the deck, the
 *   hand and the card);
 * - anything else — a drag, a click on a counter — opens an unlabelled one,
 *   which keeps taking patches for the same entities and is read afterwards
 *   for what it was (`entry.ts`);
 * - an action ends once its entities go quiet for `SETTLE_MS` (never while
 *   something is still in the hand of the pointer), so a drag is one move and
 *   a burst of clicks on one counter is one change.
 *
 * Each ended action becomes one `JournalEntry`, sent once over the relay's
 * ephemeral tier (`type:'journal'`) — never merged into lobby state, never
 * replayed to a joiner — and one line in the local log.
 *
 * Undo. An action remembers its entities before and after. Undo writes the
 * patch that puts them back, but only while nobody else has touched them
 * since and they are still exactly as the action left them; otherwise it says
 * why not and changes nothing. Undo is logged like any other action.
 */

import { writable, type Readable } from 'svelte/store';
import {
	clone,
	entityAt,
	inversePatch,
	keyString,
	stillAsLeft,
	touchedEntities,
	type EntityKey
} from './diff';
import {
	collapse,
	continues,
	countOf,
	LOGGED_WITHOUT_CHANGE,
	lockedAfter,
	readChanges,
	targetOf,
	phrase,
	targetsText,
	UNDO_BARRIER_VERBS,
	type Change,
	type JournalEntry
} from './entry';

/** quiet time that ends an action */
export const SETTLE_MS = 700;
/** how long after a verb runs its writes still count as that verb's */
export const LABEL_WINDOW_MS = 250;
/** lines the log keeps */
export const LOG_LIMIT = 50;
/** undoable actions kept per player */
export const UNDO_DEPTH = 20;

/** collections whose entities belong to the table (a peer's touch on one blocks undo) */
const TABLE_COLLECTIONS = new Set(['cards', 'decks', 'pieces', 'overlays']);

export type JournalDeps = {
	getState: () => unknown;
	/** write a patch as this client (it syncs like any other local write) */
	apply: (patch: Record<string, unknown>) => void;
	/** put an entry on the wire */
	send: (entry: JournalEntry) => void;
	myId: () => string | null | undefined;
	/** is something in the hand of the pointer right now */
	isDragging: () => boolean;
	/** tell the player something (why an undo was refused) */
	notify: (message: string) => void;
	now?: () => number;
};

type Action = {
	label: string | null;
	/** what the verb was aimed at, for a verb that changes nothing (search) */
	aimedAt: EntityKey[];
	labelledAt: number;
	keys: EntityKey[];
	before: Map<string, unknown>;
	/** the journal's clock when it opened — a peer's later touch blocks undo */
	seq: number;
	timer: ReturnType<typeof setTimeout> | null;
};

type Undoable = {
	entry: JournalEntry;
	keys: EntityKey[];
	inverse: Record<string, unknown>;
	after: Record<string, Record<string, unknown>>;
	seq: number;
};

export type Journal = {
	/** every line, oldest first; a counter run is one line */
	log: Readable<JournalEntry[]>;
	/** a local patch, before it lands on `before` */
	record: (patch: unknown, before: unknown) => void;
	/** a registry verb is about to run, aimed at these entities */
	verb: (verbId: string, aimedAt?: EntityKey[]) => void;
	/** a peer's patch landed */
	remotePatch: (patch: unknown, from: string) => void;
	/** a peer's entry arrived */
	receive: (entry: unknown, from: string) => void;
	/** end the open action now */
	flush: () => void;
	/** take back my last action; returns whether it did */
	undo: () => boolean;
	dispose: () => void;
};

export function createJournal(deps: JournalDeps): Journal {
	const now = deps.now ?? Date.now;
	const log = writable<JournalEntry[]>([]);
	let open: Action | null = null;
	let stack: Undoable[] = [];
	/** why undo stops here, once an action that can't be taken back happened */
	let barrier: string | null = null;
	let seq = 0;
	let sent = 0;
	let applyingUndo = false;
	const touchedBy = new Map<string, { seq: number; by: string }>();

	function addLine(entry: JournalEntry) {
		log.update((lines) => {
			const last = lines.at(-1);
			const next = continues(last, entry)
				? [...lines.slice(0, -1), collapse(last!, entry)]
				: [...lines, entry];
			return next.slice(-LOG_LIMIT);
		});
	}

	function schedule(action: Action) {
		if (action.timer) clearTimeout(action.timer);
		action.timer = setTimeout(() => {
			action.timer = null;
			// a drag is one action, however long it is held still
			if (deps.isDragging()) schedule(action);
			else if (open === action) end();
		}, SETTLE_MS);
	}

	function begin(label: string | null, aimedAt: EntityKey[] = []): Action {
		const action: Action = {
			label,
			aimedAt,
			labelledAt: now(),
			keys: [],
			before: new Map(),
			seq: ++seq,
			timer: null
		};
		open = action;
		schedule(action);
		return action;
	}

	function end() {
		const action = open;
		open = null;
		if (!action) return;
		if (action.timer) clearTimeout(action.timer);
		const actor = deps.myId();
		if (!actor) return;

		const state = deps.getState();
		const after = new Map<string, unknown>();
		const changes: Change[] = action.keys.map((key) => {
			const now = clone(entityAt(state, key));
			after.set(keyString(key), now);
			return { key, before: action.before.get(keyString(key)), after: now };
		});
		const read = readChanges(changes, action.label);
		if (!read) return;
		if (!read.changed.length)
			read.changed = action.aimedAt.map((key) => {
				const entity = entityAt(state, key);
				return { key, before: entity, after: entity };
			});
		const inverse = inversePatch(action.keys, action.before, after);
		if (!inverse && !LOGGED_WITHOUT_CHANGE.has(read.verb)) return;

		const entry: JournalEntry = {
			id: `${actor}:${++sent}`,
			actor,
			verb: read.verb,
			targets: read.changed.map(targetOf).filter((t) => t !== null),
			at: now()
		};
		const count = countOf(read.changed);
		if (count) entry.count = count;
		if (read.verb === 'lock' || read.verb === 'lock-selection') {
			const on = lockedAfter(read.changed);
			if (on !== undefined) entry.on = on;
		}

		if (UNDO_BARRIER_VERBS.has(read.verb)) {
			stack = [];
			barrier = phrase(read.verb, targetsText(entry.targets), entry.on);
		} else if (inverse) {
			const leftAs: Undoable['after'] = {};
			for (const key of action.keys) (leftAs[key[0]] ??= {})[key[1]] = after.get(keyString(key));
			const undoable: Undoable = {
				entry,
				keys: action.keys,
				inverse,
				after: leftAs,
				seq: action.seq
			};
			const top = stack.at(-1);
			// a run on one counter is one line, so it is one undo too
			if (top && continues(top.entry, entry) && !touchedSince(top)) {
				const merged = inversePatch(action.keys, beforeOf(top), after);
				stack[stack.length - 1] = {
					...undoable,
					entry: collapse(top.entry, entry),
					inverse: merged ?? inverse,
					seq: top.seq
				};
			} else {
				stack = [...stack, undoable].slice(-UNDO_DEPTH);
			}
			barrier = null;
		}

		deps.send(entry);
		addLine(entry);
	}

	/** the `before` snapshots an undoable restores, recovered from its inverse */
	function beforeOf(undoable: Undoable): Map<string, unknown> {
		const state = structuredClone(undoable.after) as Record<string, Record<string, unknown>>;
		for (const [collection, entities] of Object.entries(undoable.inverse))
			for (const [id, patch] of Object.entries(entities as Record<string, unknown>))
				(state[collection] ??= {})[id] = applyPatch(state[collection][id], patch);
		const before = new Map<string, unknown>();
		for (const key of undoable.keys) before.set(keyString(key), entityAt(state, key));
		return before;
	}

	function touchedSince(undoable: Undoable): { by: string } | null {
		for (const key of undoable.keys) {
			const touch = touchedBy.get(keyString(key));
			if (touch && touch.seq > undoable.seq) return touch;
		}
		return null;
	}

	return {
		log: { subscribe: log.subscribe },

		record(patch, before) {
			if (applyingUndo) return;
			const keys = touchedEntities(patch);
			if (!keys.length) return;
			if (open) {
				const inWindow = !!open.label && now() - open.labelledAt <= LABEL_WINDOW_MS;
				const known = keys.every((key) => open!.before.has(keyString(key)));
				// an unrelated write starts a new action (while nothing is carried)
				if (!inWindow && !known && !deps.isDragging()) end();
			}
			const action = open ?? begin(null);
			for (const key of keys) {
				const id = keyString(key);
				if (action.before.has(id)) continue;
				action.before.set(id, clone(entityAt(before, key)));
				action.keys.push(key);
			}
			schedule(action);
		},

		verb(verbId, aimedAt = []) {
			// a key pressed mid-drag belongs to the drag
			if (deps.isDragging() && open) return;
			end();
			begin(verbId, aimedAt);
		},

		remotePatch(patch, from) {
			for (const key of touchedEntities(patch)) {
				if (!TABLE_COLLECTIONS.has(key[0])) continue;
				touchedBy.set(keyString(key), { seq: ++seq, by: from });
			}
		},

		receive(entry, from) {
			if (!isEntry(entry) || from === deps.myId()) return;
			addLine({ ...entry, actor: from });
		},

		flush: end,

		undo() {
			if (deps.isDragging()) {
				deps.notify('Put it down first');
				return false;
			}
			end();
			const last = stack.at(-1);
			if (!last) {
				deps.notify(
					barrier ? `Nothing to undo — ${barrier} can't be taken back` : 'Nothing of yours to undo'
				);
				return false;
			}
			const what = phrase(last.entry.verb, targetsText(last.entry.targets), last.entry.on);
			const touch = touchedSince(last);
			if (touch) {
				deps.notify(`Can't undo — ${touch.by} has touched it since you ${what}`);
				return false;
			}
			if (!stillAsLeft(last.inverse, last.after, deps.getState())) {
				deps.notify(`Can't undo — it has changed since you ${what}`);
				return false;
			}

			stack = stack.slice(0, -1);
			const state = deps.getState();
			const leftAs = last.keys.map((key) => ({ key, before: entityAt(state, key) }));
			applyingUndo = true;
			try {
				deps.apply(last.inverse);
			} finally {
				applyingUndo = false;
			}
			const restored = deps.getState();
			const changes: Change[] = leftAs.map(({ key, before }) => ({
				key,
				before,
				after: entityAt(restored, key)
			}));
			const actor = deps.myId() ?? last.entry.actor;
			const entry: JournalEntry = {
				id: `${actor}:${++sent}`,
				actor,
				verb: 'undo',
				undoOf: last.entry.verb,
				targets: changes.map(targetOf).filter((t) => t !== null),
				at: now()
			};
			deps.send(entry);
			addLine(entry);
			return true;
		},

		dispose() {
			if (open?.timer) clearTimeout(open.timer);
			open = null;
		}
	};
}

/** the store's merge, for rebuilding a snapshot from a patch */
function applyPatch(target: unknown, patch: unknown): unknown {
	if (patch === null) return undefined;
	if (
		typeof patch !== 'object' ||
		Array.isArray(patch) ||
		typeof target !== 'object' ||
		target === null ||
		Array.isArray(target)
	)
		return clone(patch);
	const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const next = applyPatch(out[key], value);
		if (next === undefined) delete out[key];
		else out[key] = next;
	}
	return out;
}

/** a peer's entry is data off the wire: check its shape before it is drawn */
function isEntry(value: unknown): value is JournalEntry {
	const entry = value as JournalEntry | null;
	return (
		!!entry &&
		typeof entry === 'object' &&
		typeof entry.id === 'string' &&
		typeof entry.verb === 'string' &&
		typeof entry.at === 'number' &&
		Array.isArray(entry.targets) &&
		entry.targets.every(
			(t) =>
				!!t &&
				(t.kind === 'card' || t.kind === 'deck' || t.kind === 'piece') &&
				(t.name === null || typeof t.name === 'string')
		)
	);
}
