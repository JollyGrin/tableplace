/**
 * What a journal entry says (tableplace-201): who did which verb to what.
 *
 * An entry is built from a verb id — the registry's (`verbs/registry.ts`)
 * when a verb ran, or read off the change itself when a pointer did it (a
 * drag, a click on a counter) — and the names of the entities involved.
 *
 * Hidden information never reaches an entry. A card is named only when it
 * lies face up on the table after the action; one that is face down, or that
 * went into a hand or a pile, is "a card", and carries no id either (card ids
 * can spell the face).
 */

import { isRecord, type EntityKey } from './diff';

export type JournalTargetKind = 'card' | 'deck' | 'piece';

export type JournalTarget = {
	kind: JournalTargetKind;
	/** null for a hidden card */
	id: string | null;
	/** null: hidden, or nothing to call it */
	name: string | null;
};

/** the ephemeral `type:'journal'` relay message's value — never in `GameDTO` */
export type JournalEntry = {
	/** `<actor>:<n>` — unique per sender */
	id: string;
	actor: string;
	/** a verb id (see VERB_TEXT) */
	verb: string;
	targets: JournalTarget[];
	/** a counter: its value before and after */
	count?: { before: number; after: number };
	/** a toggle (lock): which way it went */
	on?: boolean;
	/** `undo` only: the verb that was taken back */
	undoOf?: string;
	at: number;
};

const COLLECTION_KIND: Record<string, JournalTargetKind> = {
	cards: 'card',
	decks: 'deck',
	pieces: 'piece'
};

export type Change = { key: EntityKey; before: unknown; after: unknown };

// read loosely: one reader for the card, deck and piece shapes alike
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entity = Record<string, any>;
const asEntity = (value: unknown): Entity | undefined => (isRecord(value) ? value : undefined);

const faceDown = (card: Entity | undefined) => card?.rotation?.[0] === 180;

function differs(before: Entity | undefined, after: Entity | undefined, field: string): boolean {
	return JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]);
}

/**
 * Verbs whose result is chance: taking one back and doing it again is a
 * re-roll, so undo stops at them.
 */
export const UNDO_BARRIER_VERBS: ReadonlySet<string> = new Set(['roll', 'shuffle', 'take-out']);

/** verbs worth a line even when they changed nothing in the shared state */
export const LOGGED_WITHOUT_CHANGE: ReadonlySet<string> = new Set(['search']);

/**
 * The verb one entity's change reads as, most telling first — or null when
 * nothing a player would call an action happened to it.
 */
function verbOf(change: Change, handGrew: boolean): { verb: string; rank: number } | null {
	const [collection] = change.key;
	const before = asEntity(change.before);
	const after = asEntity(change.after);
	const kind = COLLECTION_KIND[collection];
	if (!kind) return null;

	if (kind === 'card') {
		if (!before && after) return { verb: 'play', rank: 6 };
		if (before && !after) return handGrew ? { verb: 'take', rank: 6 } : { verb: 'move', rank: 9 };
	}
	if (!before || !after) return null; // created or removed: seeding, not a move

	if (kind === 'piece') {
		if (differs(before, after, 'rollSeq')) return { verb: 'roll', rank: 0 };
		if (differs(before, after, 'value'))
			return {
				verb: (after.value ?? 0) >= (before.value ?? 0) ? 'count-up' : 'count-down',
				rank: 1
			};
		if (differs(before, after, 'state'))
			return {
				verb: (after.state ?? 0) >= (before.state ?? 0) ? 'state-next' : 'state-prev',
				rank: 2
			};
		if (differs(before, after, 'items')) return { verb: 'take-out', rank: 2 };
	}
	if (kind === 'deck') {
		if (differs(before, after, 'shuffledAt')) return { verb: 'shuffle', rank: 0 };
		if (differs(before, after, 'isFaceUp')) return { verb: 'flip', rank: 4 };
		if ((after.cards?.length ?? 0) < (before.cards?.length ?? 0) && handGrew)
			return { verb: 'draw', rank: 6 };
	}
	if (differs(before, after, 'locked')) return { verb: 'lock', rank: 3 };
	if (kind === 'card' && faceDown(before) !== faceDown(after)) return { verb: 'flip', rank: 4 };
	if (differs(before, after, 'rotation'))
		return { verb: kind === 'card' ? 'tap' : 'rotate-cw', rank: 5 };
	if (differs(before, after, 'position')) return { verb: 'move', rank: 9 };
	if (kind === 'deck' && differs(before, after, 'cards')) return { verb: 'move', rank: 9 };
	return null;
}

function trayCount(player: unknown): number {
	const tray = asEntity(player)?.tray;
	return isRecord(tray) ? Object.values(tray).filter(Boolean).length : 0;
}

/**
 * The verb a set of changes reads as, and the entities it was done to. `label`
 * is the registry verb that started it, when one did; the targets are then
 * every table entity that changed.
 */
export function readChanges(
	changes: readonly Change[],
	label?: string | null
): { verb: string; changed: Change[] } | null {
	const handGrew = changes.some(
		({ key, before, after }) => key[0] === 'players' && trayCount(after) > trayCount(before)
	);
	const read = changes
		.map((change) => ({ change, verb: verbOf(change, handGrew) }))
		.filter((r): r is { change: Change; verb: { verb: string; rank: number } } => !!r.verb);
	if (label) {
		const changed = changes.filter(({ key, before, after }) => {
			if (!COLLECTION_KIND[key[0]]) return false;
			return JSON.stringify(before) !== JSON.stringify(after);
		});
		return { verb: label, changed };
	}
	if (!read.length) return null;
	const best = Math.min(...read.map((r) => r.verb.rank));
	const verb = read.find((r) => r.verb.rank === best)!.verb.verb;
	return { verb, changed: read.filter((r) => r.verb.verb === verb).map((r) => r.change) };
}

/** a table entity as the log may name it — see the header for the card rule */
export function targetOf(change: Change): JournalTarget | null {
	const kind = COLLECTION_KIND[change.key[0]];
	if (!kind) return null;
	const after = asEntity(change.after);
	const before = asEntity(change.before);
	if (kind === 'card') {
		// face up on the table afterwards is public to everyone at the table;
		// anything else — face down, or gone into a hand or a pile — is not
		if (!after || faceDown(after)) return { kind, id: null, name: null };
		const name = typeof after.name === 'string' && after.name ? after.name : null;
		return { kind, id: change.key[1], name };
	}
	const entity = after ?? before;
	const name = typeof entity?.name === 'string' && entity.name ? entity.name : null;
	return { kind, id: change.key[1], name };
}

export function countOf(changes: readonly Change[]): JournalEntry['count'] {
	if (changes.length !== 1) return undefined;
	const [{ before, after }] = changes;
	const from = asEntity(before)?.value;
	const to = asEntity(after)?.value;
	return typeof from === 'number' && typeof to === 'number'
		? { before: from, after: to }
		: undefined;
}

export function lockedAfter(changes: readonly Change[]): boolean | undefined {
	const after = asEntity(changes[0]?.after);
	return after ? !!after.locked : undefined;
}

// ---- how a line reads ----

/**
 * Past tense, by verb id; `{}` is where the targets go (after the verb when
 * absent). An unknown verb falls back to its id.
 */
export const VERB_TEXT: Readonly<Record<string, string>> = {
	move: 'moved',
	flip: 'flipped',
	'flip-selection': 'flipped',
	tap: 'turned',
	'tap-reverse': 'turned',
	'rotate-cw': 'turned',
	'rotate-ccw': 'turned',
	'rotate-selection-cw': 'turned',
	'rotate-selection-ccw': 'turned',
	raise: 'nudged',
	lower: 'nudged',
	draw: 'drew from {}',
	'draw-table': 'drew from {}',
	take: 'took {} into their hand',
	play: 'played',
	shuffle: 'shuffled',
	search: 'searched',
	'count-up': 'set',
	'count-down': 'set',
	'count-reset': 'reset',
	'state-next': 'changed',
	'state-prev': 'changed',
	lock: 'locked',
	'lock-selection': 'locked',
	group: 'grouped',
	'group-selection': 'grouped',
	ungroup: 'ungrouped',
	roll: 'rolled',
	'take-out': 'took from {}',
	'snap-toggle': 'changed snapping on',
	remove: 'removed',
	undo: 'undid'
};

export function verbText(verb: string, on?: boolean): string {
	if ((verb === 'lock' || verb === 'lock-selection') && on === false) return 'unlocked';
	return VERB_TEXT[verb] ?? verb;
}

const NOUN: Record<JournalTargetKind, [string, string]> = {
	card: ['a card', 'cards'],
	deck: ['a deck', 'decks'],
	piece: ['a piece', 'pieces']
};

/** "Goblin, a deck and 2 cards" */
export function targetsText(targets: readonly JournalTarget[]): string {
	const named = targets.filter((t) => t.name).map((t) => t.name!);
	const unnamed: string[] = [];
	for (const kind of ['card', 'deck', 'piece'] as const) {
		const n = targets.filter((t) => t.kind === kind && !t.name).length;
		if (n === 1) unnamed.push(NOUN[kind][0]);
		else if (n > 1) unnamed.push(`${n} ${NOUN[kind][1]}`);
	}
	const parts = [...new Set(named), ...unnamed];
	if (parts.length <= 1) return parts[0] ?? '';
	return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function phrase(verb: string, what: string, on?: boolean): string {
	const text = verbText(verb, on);
	if (text.includes('{}')) return text.replace('{}', what || 'something').trim();
	return [text, what].filter(Boolean).join(' ');
}

/** the line without its actor: "moved Goblin", "set Health 3 → 5", "undid flipped a card" */
export function entryText(
	entry: Pick<JournalEntry, 'verb' | 'targets' | 'count' | 'on' | 'undoOf'>
) {
	const what = targetsText(entry.targets);
	if (entry.verb === 'undo') return `undid: ${phrase(entry.undoOf ?? '', what)}`;
	const count = entry.count ? ` ${entry.count.before} → ${entry.count.after}` : '';
	return phrase(entry.verb, what, entry.on) + count;
}

/** how long a run of changes to one counter keeps folding into one line */
export const COLLAPSE_MS = 4000;

/**
 * Does `next` continue `previous` — the same player stepping the same counter
 * again within a few seconds? The log then shows one line, first value to
 * last.
 */
export function continues(previous: JournalEntry | undefined, next: JournalEntry): boolean {
	return (
		!!previous?.count &&
		!!next.count &&
		previous.actor === next.actor &&
		previous.targets.length === 1 &&
		next.targets.length === 1 &&
		previous.targets[0].id !== null &&
		previous.targets[0].id === next.targets[0].id &&
		next.at - previous.at <= COLLAPSE_MS
	);
}

/** fold `next` into `previous` (see `continues`) */
export function collapse(previous: JournalEntry, next: JournalEntry): JournalEntry {
	return {
		...next,
		id: previous.id,
		verb: next.count!.after >= previous.count!.before ? 'count-up' : 'count-down',
		count: { before: previous.count!.before, after: next.count!.after }
	};
}
