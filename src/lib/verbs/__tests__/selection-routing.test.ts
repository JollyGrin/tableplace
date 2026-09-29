/**
 * Where a key goes while something is selected (tableplace-202): to the
 * selection when the pointer is on a member or on nothing, and to the thing
 * under the pointer when that thing is not selected.
 */
import { describe, expect, it } from 'vitest';
import { targetsUnder } from '../keyboard';

const idle = { isDeckHovered: null, isHovered: null, isDragging: null };
const kinds = (targets: ReturnType<typeof targetsUnder>) => targets.map((t) => t.kind);

describe('targetsUnder with a selection', () => {
	it('pointer on nothing: the selection, then the table', () => {
		expect(kinds(targetsUnder(idle, null, null, ['card:me:a']))).toEqual(['selection', 'table']);
	});

	it('pointer on a selected card: the selection first, the card after it', () => {
		const targets = targetsUnder({ ...idle, isHovered: 'card:me:a' }, null, null, [
			'card:me:a',
			'piece:me:t'
		]);
		expect(kinds(targets)).toEqual(['selection', 'card', 'table']);
		expect(targets[0]).toEqual({ kind: 'selection', ids: ['card:me:a', 'piece:me:t'] });
	});

	it('pointer on something not selected: that thing keeps its keys', () => {
		expect(
			kinds(targetsUnder({ ...idle, isHovered: 'card:me:b' }, null, null, ['card:me:a']))
		).toEqual(['card', 'table']);
		expect(kinds(targetsUnder(idle, 'piece:me:u', null, ['card:me:a']))).toEqual([
			'piece',
			'table'
		]);
	});

	it('nothing selected: exactly the old routing', () => {
		expect(kinds(targetsUnder({ ...idle, isHovered: 'card:me:a' }, null, null, []))).toEqual([
			'card',
			'table'
		]);
	});
});
