import { afterEach, describe, expect, it } from 'vitest';
import { isDebug, isDeeplinked, showGlobalControls } from '../debug';

const at = (search: string) => window.history.replaceState({}, '', `/play${search}`);

describe('debug url params', () => {
	afterEach(() => at(''));

	it('shows global controls when not deeplinked', () => {
		at('');
		expect(showGlobalControls()).toBe(true);
	});
	it('hides them on a bare ?lobby= link', () => {
		at('?lobby=x');
		expect(isDeeplinked()).toBe(true);
		expect(showGlobalControls()).toBe(false);
	});
	it('?debug restores them; ?debug=0 does not', () => {
		at('?lobby=x&debug');
		expect(isDebug()).toBe(true);
		expect(showGlobalControls()).toBe(true);
		at('?lobby=x&debug=0');
		expect(showGlobalControls()).toBe(false);
	});
});
