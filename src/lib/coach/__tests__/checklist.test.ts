/**
 * The first-run checklist (tableplace-206): its keys come from the verb
 * registry, a journal line ticks the item its verb teaches, what a browser
 * remembers survives junk, and a scenario's `coach: false` reaches the table.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseScenarioFile } from '$lib/scenario/file';
import { composeScenario } from '$lib/compose/scenario';
import { tableAllowsCoach, validCoach } from '../table';

vi.mock('svelte-french-toast', () => ({
	default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}));

const { checklistItems, itemForJournalVerb, parseCoachMemory, tick, CHECKLIST } = await import(
	'../checklist'
);
const { BUILTIN_VERBS } = await import('$lib/verbs/registry');

const keyOf = (id: string) => checklistItems().find((item) => item.id === id)?.key;

describe('the checklist items', () => {
	it('are about eight, each printed with the key the registry binds', () => {
		const items = checklistItems();
		expect(items.length).toBeGreaterThanOrEqual(7);
		expect(items.length).toBeLessThanOrEqual(10);
		expect(keyOf('flip')).toBe('F');
		expect(keyOf('turn')).toBe('Q / E');
		expect(keyOf('draw')).toBe('click');
		expect(keyOf('play')).toBe('drag out');
		expect(keyOf('ping')).toBe('double-click felt');
		expect(keyOf('undo')).toBe('Ctrl/⌘ + Z');
		expect(keyOf('preview')).toBe('hold Space or Alt');
		expect(keyOf('menu')).toBe('right-click');
	});

	it('follow a rebound key, and drop an item whose verb is gone', () => {
		const rebound = BUILTIN_VERBS.filter((def) => def.id !== 'undo').map((def) =>
			def.id === 'flip' ? { ...def, hotkey: { codes: ['KeyV'], label: 'V' } } : def
		);
		const items = checklistItems([rebound]);
		expect(items.find((item) => item.id === 'flip')?.key).toBe('V');
		expect(items.some((item) => item.id === 'undo')).toBe(false);
	});

	it('tick from the journal verbs that do them', () => {
		expect(itemForJournalVerb('flip')).toBe('flip');
		expect(itemForJournalVerb('flip-selection')).toBe('flip');
		expect(itemForJournalVerb('turn-cw')).toBe('turn');
		expect(itemForJournalVerb('move')).toBe('move');
		expect(itemForJournalVerb('undo')).toBe('undo');
		expect(itemForJournalVerb('shuffle')).toBeNull();
		// any new card on the felt reads as `play`, a draw to the table included
		expect(itemForJournalVerb('play')).toBeNull();
	});

	it('have unique ids', () => {
		const ids = CHECKLIST.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('what this browser remembers', () => {
	it('reads back what it wrote, and anything unreadable as a fresh start', () => {
		expect(parseCoachMemory(JSON.stringify({ dismissed: true, done: ['flip', 3] }))).toEqual({
			dismissed: true,
			done: ['flip']
		});
		for (const junk of [null, '', '{', '"x"', '[]'])
			expect(parseCoachMemory(junk)).toEqual({ dismissed: false, done: [] });
	});

	it('ticks once: a second tick is the same object, so a store sees no change', () => {
		const fresh = { dismissed: false, done: [] };
		const once = tick(fresh, 'flip');
		expect(once.done).toEqual(['flip']);
		expect(tick(once, 'flip')).toBe(once);
	});
});

describe('scenario coach', () => {
	const file = (extra: Record<string, unknown>) =>
		JSON.stringify({ tbps: 1, name: 'Board', state: {}, ...extra });

	it('parses, and composes into the synced table settings', () => {
		const scenario = parseScenarioFile(file({ coach: false }));
		expect(scenario.coach).toBe(false);
		expect(composeScenario(scenario, new Map()).table).toEqual({ coach: false });
	});

	it('is absent unless authored', () => {
		const scenario = parseScenarioFile(file({}));
		expect('coach' in scenario).toBe(false);
		expect(composeScenario(scenario, new Map()).table).toBeUndefined();
	});

	it('refuses anything but true or false', () => {
		expect(() => parseScenarioFile(file({ coach: 'no' }))).toThrow(/coach/);
		expect(() => parseScenarioFile(file({ coach: 0 }))).toThrow(/coach/);
	});

	it('hides the strip only on an explicit false', () => {
		expect(tableAllowsCoach(undefined)).toBe(true);
		expect(tableAllowsCoach({ table: {} })).toBe(true);
		expect(tableAllowsCoach({ table: { coach: true } })).toBe(true);
		expect(tableAllowsCoach({ table: { coach: false } })).toBe(false);
		expect(validCoach('false')).toBeUndefined();
	});
});
