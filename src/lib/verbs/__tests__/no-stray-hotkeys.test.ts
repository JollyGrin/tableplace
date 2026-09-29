/**
 * The table routes bind no key of their own: every hotkey is a verb in the
 * registry and reaches the page through `verbs/keyboard.ts`. A handler that
 * matches a key in a route is a second, drifting copy — exactly what #113 was.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = ['src/routes/play/+page.svelte', 'src/routes/setup/+page.svelte'];

// `e.key ===`, `event.code === 'KeyF'`, `.key == "x"`, a /Digit…/ regex on a code
const STRAY_KEY_MATCH = [
	/\b\w+\.(key|code|keyCode|which)\s*===?/,
	/\/\^?Digit/,
	/['"]Key[A-Z]['"]/
];

describe.each(ROUTES)('%s', (route) => {
	const source = readFileSync(resolve(process.cwd(), route), 'utf8');

	it('matches no key itself', () => {
		for (const pattern of STRAY_KEY_MATCH) expect(source).not.toMatch(pattern);
	});

	it('binds the window keys to the registry dispatcher and nothing else', () => {
		const bindings = [...source.matchAll(/on:?(keydown|keyup)(\|\w+)*=\{(\w+)\}/g)].map(
			(m) => m[3]
		);
		expect(bindings).toEqual(['handleVerbKeyDown', 'handleVerbKeyUp']);
	});
});
