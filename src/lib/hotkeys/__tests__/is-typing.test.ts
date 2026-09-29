/**
 * Table hotkeys are bare letters bound on `svelte:window`, and every route
 * carries a tweakpane full of text fields. Tweakpane does not stop propagation,
 * so without a guard, typing `flag-game` into a scenario name flips a card,
 * groups a pile and resets the camera — and on /play, which is synced, that
 * mutation lands on everyone's table (see #112).
 *
 * The source-level half is the part that regresses: `isTyping` existing is no
 * use if a handler forgets to call it, and the failure is silent — the hotkey
 * simply also fires.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTyping } from '../is-typing';

describe('isTyping', () => {
	it('is true for the fields tweakpane renders', () => {
		for (const tag of ['input', 'textarea', 'select']) {
			expect(isTyping(document.createElement(tag)), tag).toBe(true);
		}
	});

	// jsdom does not implement `isContentEditable` (it stays undefined however
	// the attribute is set), so the browser's behaviour has to be stubbed in
	it('is true for a contenteditable host', () => {
		const div = document.createElement('div');
		Object.defineProperty(div, 'isContentEditable', { value: true });
		expect(isTyping(div)).toBe(true);
	});

	it('is false for the canvas, plain elements and a null target', () => {
		expect(isTyping(document.createElement('canvas'))).toBe(false);
		expect(isTyping(document.createElement('button'))).toBe(false);
		expect(isTyping(null)).toBe(false);
	});
});

/**
 * Where each table route's key handlers live. /play and /setup bind the verb
 * registry's dispatcher (tableplace-183), so the guard is checked there, once;
 * /create still carries its own.
 */
const HANDLERS = [
	{
		name: '/create',
		file: 'src/routes/create/+page.svelte',
		fns: ['handleKeyDown', 'handleKeyUp'],
		indent: '\t'
	},
	{
		name: 'the verb dispatcher (/play, /setup)',
		file: 'src/lib/verbs/keyboard.ts',
		fns: ['handleVerbKeyDown', 'handleVerbKeyUp'],
		indent: ''
	}
];

function body(source: string, fn: string, indent: string) {
	const start = source.indexOf(`function ${fn}(event: KeyboardEvent) {`);
	expect(start, fn).toBeGreaterThan(-1);
	const end = source.indexOf(`\n${indent}}`, start);
	return source.slice(start, end);
}

describe('route keyboard handlers', () => {
	for (const { name, file, fns, indent } of HANDLERS) {
		const source = readFileSync(join(process.cwd(), file), 'utf8');

		it(`${name} imports the shared helper rather than defining its own`, () => {
			expect(source).toContain("from '$lib/hotkeys/is-typing'");
			expect(source).not.toMatch(/function isTyping\b/);
		});

		// keyup matters too: Space's preview HUD is a latch, so a guarded press
		// with an unguarded release would leave the HUD stuck on
		for (const fn of fns) {
			it(`${name} ${fn} bails out before reading the key`, () => {
				const source_ = body(source, fn, indent);
				const guard = source_.indexOf('isTyping(event.target)');
				expect(guard, 'no isTyping guard').toBeGreaterThan(-1);
				const firstUse = source_.search(/event\.code|verbForKey\(event|verbsFor\(/);
				if (firstUse > -1) expect(guard).toBeLessThan(firstUse);
			});
		}
	}

	it('/play and /setup bind that dispatcher', () => {
		for (const route of ['play', 'setup']) {
			const page = readFileSync(join(process.cwd(), 'src/routes', route, '+page.svelte'), 'utf8');
			expect(page).toContain("from '$lib/verbs/keyboard'");
		}
	});
});
