/**
 * One click on a bag must draw exactly ONE item — the same hazard counters hit
 * in tableplace-84, and a worse failure here: a double draw empties a pool and
 * there is no undo. A bag group has a pouch, a tie ring, a neck, an optional
 * decal and a Billboard'd count label, so a single ray can queue the group five
 * times.
 *
 * The harness mirrors Threlte's dispatch loop, like counter-input.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IntersectionEvent } from '@threlte/extras';
import { createBagInput } from '../utils/bag-input';

type Handlers = ReturnType<typeof createBagInput>;
type EventName = keyof Handlers;
type Hit = { label: string; handlers: Handlers };

function dispatch(name: EventName, hits: Hit[], nativeEvent: Event, delta = 0) {
	let stopped = false;
	const dispatched: string[] = [];

	for (const hit of hits) {
		if (stopped) break;
		dispatched.push(hit.label);
		const event = {
			delta,
			nativeEvent,
			stopPropagation: () => {
				stopped = true;
			},
			stopImmediatePropagation: () => {}
		} as unknown as IntersectionEvent<MouseEvent>;
		hit.handlers[name](event);
	}

	return { dispatched, stopped };
}

function bagInput(
	draw: (id: string) => void,
	{ id = 'piece:seat0:tile-bag-0', isBag = true, wasDrag = false } = {}
) {
	return createBagInput({ id: () => id, isBag: () => isBag, wasDrag: () => wasDrag, draw });
}

/** the raycastable children of a bag, near → far from a table camera */
function bagHits(handlers: Handlers): Hit[] {
	return [
		{ label: 'count-label', handlers },
		{ label: 'neck', handlers },
		{ label: 'tie', handlers },
		{ label: 'pouch', handlers }
	];
}

describe('bag input', () => {
	it('draws once when one click hits four of the bag’s child meshes', () => {
		const draw = vi.fn();
		const { dispatched } = dispatch('onclick', bagHits(bagInput(draw)), new MouseEvent('click'));

		expect(draw).toHaveBeenCalledTimes(1);
		expect(draw).toHaveBeenCalledWith('piece:seat0:tile-bag-0');
		expect(dispatched).toEqual(['count-label']);
	});

	it('still draws once if every duplicate entry reaches the handler', () => {
		const draw = vi.fn();
		const handlers = bagInput(draw);
		const native = new MouseEvent('click');

		for (let i = 0; i < 4; i++) {
			handlers.onclick({
				delta: 0,
				nativeEvent: native,
				stopPropagation: () => {},
				stopImmediatePropagation: () => {}
			} as unknown as IntersectionEvent<MouseEvent>);
		}

		expect(draw).toHaveBeenCalledTimes(1);
	});

	it('right-click is the radial wheel, not a draw', () => {
		expect('oncontextmenu' in bagInput(vi.fn())).toBe(false);
	});

	it('a drag release claims the event without drawing', () => {
		const draw = vi.fn();
		// the pointer travelled: this press moved the bag, it did not ask for a draw
		const moved = dispatch(
			'onclick',
			bagHits(bagInput(draw, { wasDrag: true })),
			new MouseEvent('click')
		);
		expect(draw).not.toHaveBeenCalled();
		expect(moved.dispatched).toEqual(['count-label']);

		// same for a click whose own travel is over the threshold
		dispatch('onclick', bagHits(bagInput(draw)), new MouseEvent('click'), 20);
		expect(draw).not.toHaveBeenCalled();
	});

	it('a non-bag piece ignores bag input, so hits below still see the event', () => {
		const draw = vi.fn();
		const token = bagInput(draw, { id: 'piece:seat0:token-0', isBag: false });
		const { stopped } = dispatch(
			'onclick',
			[{ label: 'token-disc', handlers: token }],
			new MouseEvent('click')
		);

		expect(draw).not.toHaveBeenCalled();
		expect(stopped).toBe(false);
	});

	it('a bag under another bag is left alone — only the topmost draws', () => {
		const draw = vi.fn();
		const top = bagInput(draw, { id: 'piece:seat0:top-bag-0' });
		const bottom = bagInput(draw, { id: 'piece:seat0:bottom-bag-0' });

		dispatch(
			'onclick',
			[...bagHits(top), { label: 'bottom-pouch', handlers: bottom }],
			new MouseEvent('click')
		);

		expect(draw).toHaveBeenCalledTimes(1);
		expect(draw).toHaveBeenCalledWith('piece:seat0:top-bag-0');
	});
});
