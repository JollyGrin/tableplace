/**
 * A counter used to move by 2 per click (tableplace-84). Threlte's
 * interactivity() dedupes raw hits by *leaf* mesh, then bubbles each hit up to
 * the ancestors that own handlers — so a counter's `<T.Group>` is queued once
 * per child mesh the ray pierced (disc, image circle, and the Billboard'd
 * troika <Text>, whose raycast covers the whole text block). Clicking on the
 * number therefore ran the handler twice off one native event.
 *
 * The harness below mirrors that: several hits resolving to the same
 * eventObject, one shared native event, near → far, breaking out as soon as a
 * handler calls stopPropagation() — same shape as single-hit-dispatch.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IntersectionEvent } from '@threlte/extras';
import { createCounterInput } from '../utils/counter-input';

type Handlers = ReturnType<typeof createCounterInput>;
type EventName = keyof Handlers;

/** one entry per (hit, eventObject) pair, in the order Threlte would queue them */
type Hit = { label: string; handlers: Handlers };

/**
 * Replica of the dispatch loop in
 * @threlte/extras/interactivity/setupInteractivity: visit the queued hits near
 * → far and stop as soon as a handler stops propagation.
 */
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
		(hit.handlers[name] as (e: IntersectionEvent<MouseEvent>) => void)(event);
	}

	return { dispatched, stopped };
}

function counter(increment: (id: string, delta: number) => void, id = 'piece:seat0:counter-0') {
	return createCounterInput({
		id: () => id,
		isCounter: () => true,
		wasDrag: () => false,
		increment
	});
}

/** the three raycastable children of a counter, near → far from a top-down camera */
function counterHits(handlers: Handlers): Hit[] {
	return [
		{ label: 'text', handlers },
		{ label: 'image-circle', handlers },
		{ label: 'disc', handlers }
	];
}

function mouseEvent(type: string, init: MouseEventInit = {}) {
	return new MouseEvent(type, init);
}

describe('counter input', () => {
	it('increments once when one click hits three of the counter’s child meshes', () => {
		const increment = vi.fn();
		const handlers = counter(increment);

		const { dispatched } = dispatch('onclick', counterHits(handlers), mouseEvent('click'));

		expect(increment).toHaveBeenCalledTimes(1);
		expect(increment).toHaveBeenCalledWith('piece:seat0:counter-0', -1);
		// the duplicates never even ran: the first claim broke the loop
		expect(dispatched).toEqual(['text']);
	});

	it('still increments once if every duplicate entry reaches the handler', () => {
		const increment = vi.fn();
		const handlers = counter(increment);
		const native = mouseEvent('click');

		// stopPropagation defeated (a nested interactive child, a future extra
		// mesh, a handler that runs later): the per-event guard has to hold.
		for (let i = 0; i < 3; i++) {
			handlers.onclick({
				delta: 0,
				nativeEvent: native,
				stopPropagation: () => {},
				stopImmediatePropagation: () => {}
			} as unknown as IntersectionEvent<MouseEvent>);
		}

		expect(increment).toHaveBeenCalledTimes(1);
	});

	it('heals once on shift-click; right-click is the radial wheel, not a heal', () => {
		const increment = vi.fn();
		const handlers = counter(increment);

		dispatch('onclick', counterHits(handlers), mouseEvent('click', { shiftKey: true }));
		expect(increment).toHaveBeenCalledTimes(1);
		expect(increment).toHaveBeenLastCalledWith('piece:seat0:counter-0', 1);
		expect('oncontextmenu' in handlers).toBe(false);
	});

	it('moves one step per wheel notch, not one per child mesh', () => {
		const increment = vi.fn();
		const handlers = counter(increment);

		const notch = new WheelEvent('wheel', { deltaY: 100 });
		dispatch('onwheel', counterHits(handlers), notch);

		expect(increment).toHaveBeenCalledTimes(1);
		expect(increment).toHaveBeenCalledWith('piece:seat0:counter-0', -1);

		// a second, distinct notch is a new native event and must go through
		dispatch('onwheel', counterHits(handlers), new WheelEvent('wheel', { deltaY: -100 }));
		expect(increment).toHaveBeenCalledTimes(2);
		expect(increment).toHaveBeenLastCalledWith('piece:seat0:counter-0', 1);
	});

	it('sub-notch wheel deltas still accumulate to exactly one step', () => {
		const increment = vi.fn();
		const handlers = counter(increment);

		for (let i = 0; i < 4; i++) {
			dispatch('onwheel', counterHits(handlers), new WheelEvent('wheel', { deltaY: 25 }));
		}

		expect(increment).toHaveBeenCalledTimes(1);
	});

	it('a counter under another counter is left alone — only the topmost moves', () => {
		const increment = vi.fn();
		const top = counter(increment, 'piece:seat0:counter-top');
		const bottom = counter(increment, 'piece:seat0:counter-bottom');

		// top counter's disc + text, then the counter beneath it
		dispatch(
			'onclick',
			[...counterHits(top), { label: 'bottom-disc', handlers: bottom }],
			mouseEvent('click')
		);

		expect(increment).toHaveBeenCalledTimes(1);
		expect(increment).toHaveBeenCalledWith('piece:seat0:counter-top', -1);
	});

	it('a drag release claims the event without changing the value', () => {
		const increment = vi.fn();
		const handlers = counter(increment);

		// delta above the click threshold: the pointer travelled, so this was a
		// drag — but it must still be claimed, or the duplicate entry applies it
		const { dispatched } = dispatch('onclick', counterHits(handlers), mouseEvent('click'), 20);

		expect(increment).not.toHaveBeenCalled();
		expect(dispatched).toEqual(['text']);
	});

	it('a token ignores counter input entirely, so hits below still see it', () => {
		const increment = vi.fn();
		const token = createCounterInput({
			id: () => 'piece:seat0:token-0',
			isCounter: () => false,
			wasDrag: () => false,
			increment
		});

		const { dispatched, stopped } = dispatch(
			'onclick',
			[{ label: 'token-disc', handlers: token }],
			mouseEvent('click')
		);

		expect(increment).not.toHaveBeenCalled();
		expect(stopped).toBe(false);
		expect(dispatched).toEqual(['token-disc']);
	});
});
