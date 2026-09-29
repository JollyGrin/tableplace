/**
 * The first-run checklist (tableplace-206): a handful of things to try on a
 * new table, each ticking itself off when the player does it.
 *
 * Every item that is a verb reads its key or gesture from the verb registry,
 * so the strip can never teach a key the table does not answer to — rebind a
 * verb and its item follows, drop a verb and its item goes. The two pointer
 * controls that are not verbs (moving a thing, the wheel) are the only keys
 * written here.
 *
 * Nothing names a game: each item is a verb any table has.
 */

import { TABLE_BASICS, VERB_SOURCES } from '$lib/verbs/registry';
import type { VerbDef } from '$lib/verbs/types';

/** one line of the strip, ready to draw */
export type ChecklistItem = { id: string; text: string; key: string };

type ItemDef = {
	id: string;
	text: string;
	/** registry verbs whose keys it teaches, printed `Q / E` */
	verbs?: readonly string[];
	/** print the verb's pointer gesture rather than its key */
	gesture?: boolean;
	/** a pointer control that is not a verb: its key, or a `TABLE_BASICS` action to read it from */
	pointer?: { key: string } | { basics: string };
	/**
	 * Journal verbs (journal/entry.ts) that tick it when this player's own
	 * line says so. Items with none are ticked by what the page shows instead
	 * (see `index.ts`): a card carried out of the hand, a preview, the wheel,
	 * a ping.
	 */
	ticks: readonly string[];
};

export const CHECKLIST: readonly ItemDef[] = [
	{ id: 'move', text: 'Move something', pointer: { key: 'drag' }, ticks: ['move'] },
	{
		id: 'draw',
		text: 'Draw from a deck',
		verbs: ['draw'],
		gesture: true,
		ticks: ['draw', 'draw-table']
	},
	{
		id: 'play',
		text: 'Play a card from your hand',
		verbs: ['hand-play'],
		gesture: true,
		// not the journal's `play`: that is any card appearing on the table, a
		// draw straight to the felt included — the hand's own carry ticks it
		ticks: []
	},
	{ id: 'flip', text: 'Flip a card', verbs: ['flip'], ticks: ['flip', 'flip-selection'] },
	{
		id: 'turn',
		text: 'Turn something',
		verbs: ['turn-ccw', 'turn-cw'],
		ticks: [
			'turn-cw',
			'turn-ccw',
			'rotate-cw',
			'rotate-ccw',
			'rotate-selection-cw',
			'rotate-selection-ccw'
		]
	},
	{ id: 'preview', text: 'Look closer', verbs: ['preview'], ticks: [] },
	{ id: 'menu', text: 'Open the action wheel', pointer: { basics: 'Actions' }, ticks: [] },
	{ id: 'ping', text: 'Ping a spot', verbs: ['ping'], gesture: true, ticks: [] },
	{ id: 'undo', text: 'Undo', verbs: ['undo'], ticks: ['undo'] }
];

function keyOf(item: ItemDef, defs: readonly VerbDef[]): string | null {
	if (item.pointer) {
		if ('key' in item.pointer) return item.pointer.key;
		const action = item.pointer.basics;
		return TABLE_BASICS.find((row) => row.action === action)?.key ?? null;
	}
	const keys = (item.verbs ?? []).map((id) => {
		const def = defs.find((d) => d.id === id);
		return (item.gesture ? def?.gesture : def?.hotkey?.label) ?? null;
	});
	if (!keys.length || keys.some((key) => key === null)) return null;
	return [...new Set(keys)].join(' / ');
}

/**
 * The strip's items, keys read from the registry. An item whose verb is not
 * in the registry (or has lost its key) is left out rather than printed with
 * a key that does nothing.
 */
export function checklistItems(
	sources: readonly (readonly VerbDef[])[] = VERB_SOURCES
): ChecklistItem[] {
	const defs = sources.flat();
	return CHECKLIST.flatMap((item) => {
		const key = keyOf(item, defs);
		return key === null ? [] : [{ id: item.id, text: item.text, key }];
	});
}

/** the item a journal verb ticks, or null */
export function itemForJournalVerb(verb: string): string | null {
	return CHECKLIST.find((item) => item.ticks.includes(verb))?.id ?? null;
}

// ---- what this browser remembers ------------------------------------------

export type CoachMemory = { dismissed: boolean; done: string[] };

export const COACH_KEY = 'coach:v1';

/** a stored value, or the fresh state for anything unreadable */
export function parseCoachMemory(raw: string | null | undefined): CoachMemory {
	try {
		const value = JSON.parse(raw ?? '');
		return {
			dismissed: value?.dismissed === true,
			done: Array.isArray(value?.done)
				? value.done.filter((id: unknown): id is string => typeof id === 'string')
				: []
		};
	} catch {
		return { dismissed: false, done: [] };
	}
}

/** `memory` with `id` ticked — the same object when it already was */
export function tick(memory: CoachMemory, id: string): CoachMemory {
	return memory.done.includes(id) ? memory : { ...memory, done: [...memory.done, id] };
}
