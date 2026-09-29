import { describe, expect, it, vi } from 'vitest';
import { createPinger, createRateLimit, parsePing, PING_RATE } from '../ping';
import { edgeArrow, EDGE_MARGIN_PX } from '../edge';
import { TABLE_HALF_X, TABLE_HALF_Z } from '$lib/utils/constants-table';

describe('parsePing', () => {
	it('reads a table point', () => {
		expect(parsePing({ x: 1.5, z: -2 })).toEqual({ x: 1.5, z: -2 });
	});

	it('refuses anything that is not a finite point', () => {
		for (const value of [null, 3, 'x', {}, { x: 1 }, { x: '1', z: 2 }, { x: NaN, z: 0 }, { x: 0, z: Infinity }])
			expect(parsePing(value)).toBeNull();
	});

	it('clamps a point off the felt back onto it', () => {
		expect(parsePing({ x: 1e6, z: -1e6 })).toEqual({ x: TABLE_HALF_X, z: -TABLE_HALF_Z });
	});
});

describe('createRateLimit', () => {
	it(`allows ${PING_RATE.count} per ${PING_RATE.windowMs}ms, then waits for the window`, () => {
		let t = 0;
		const allow = createRateLimit(() => t);
		expect(allow()).toBe(true);
		t = 100;
		expect(allow()).toBe(true);
		t = 200;
		expect(allow()).toBe(false);
		t = 999;
		expect(allow()).toBe(false);
		t = 1000; // the first has left the window
		expect(allow()).toBe(true);
		expect(allow()).toBe(false);
		t = 1100;
		expect(allow()).toBe(true);
	});

	it('a refused ping does not use up the window', () => {
		let t = 0;
		const allow = createRateLimit(() => t);
		allow();
		allow();
		for (let i = 0; i < 10; i++) allow();
		t = 1000;
		expect(allow()).toBe(true);
	});
});

function pinger(me: string | null = 'me') {
	let t = 0;
	const send = vi.fn();
	const show = vi.fn();
	const sound = vi.fn();
	const p = createPinger({ now: () => t, send, show, sound, myId: () => me });
	return { p, send, show, sound, tick: (ms: number) => (t += ms) };
}

describe('createPinger', () => {
	it('shows its own ping at once, sends one message, and plays the sound hook', () => {
		const { p, send, show, sound } = pinger();
		expect(p.ping(2, 3)).toBe(true);
		expect(send).toHaveBeenCalledExactlyOnceWith({ x: 2, z: 3 });
		expect(show).toHaveBeenCalledWith(expect.objectContaining({ x: 2, z: 3, playerId: 'me' }));
		expect(sound).toHaveBeenCalledOnce();
	});

	it('is rate-limited to two a second: a burst puts two messages on the wire', () => {
		const { p, send, show, tick } = pinger();
		const results = Array.from({ length: 6 }, () => p.ping(0, 0));
		expect(results).toEqual([true, true, false, false, false, false]);
		expect(send).toHaveBeenCalledTimes(2);
		expect(show).toHaveBeenCalledTimes(2);
		tick(1000);
		expect(p.ping(0, 0)).toBe(true);
	});

	it('sends nothing without a player to send as', () => {
		const { p, send, show } = pinger(null);
		expect(p.ping(0, 0)).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(show).not.toHaveBeenCalled();
	});

	it("shows a peer's ping in their name, and ignores a malformed one", () => {
		const { p, send, show } = pinger();
		p.receive({ x: 4, z: 1 }, 'them');
		p.receive({ x: 'nope' }, 'them');
		expect(show).toHaveBeenCalledOnce();
		expect(show).toHaveBeenCalledWith(expect.objectContaining({ x: 4, z: 1, playerId: 'them' }));
		expect(send).not.toHaveBeenCalled();
	});

	it('gives every ping its own key', () => {
		const { p, show } = pinger();
		p.ping(0, 0);
		p.receive({ x: 1, z: 1 }, 'them');
		const keys = show.mock.calls.map(([ping]) => ping.key);
		expect(new Set(keys).size).toBe(2);
	});
});

describe('edgeArrow', () => {
	const view = { width: 1000, height: 600 };

	it('puts up nothing for a point in view', () => {
		expect(edgeArrow({ x: 0.5, y: -0.9, z: 0.5 }, view)).toBeNull();
	});

	it('points right from the right edge for a point off to the right', () => {
		const arrow = edgeArrow({ x: 3, y: 0, z: 0.5 }, view)!;
		expect(arrow.x).toBeCloseTo(view.width - EDGE_MARGIN_PX);
		expect(arrow.y).toBeCloseTo(view.height / 2);
		expect(arrow.angle).toBeCloseTo(0);
	});

	it('points down from the bottom edge for a point below the view', () => {
		const arrow = edgeArrow({ x: 0, y: -4, z: 0.5 }, view)!;
		expect(arrow.y).toBeCloseTo(view.height - EDGE_MARGIN_PX);
		expect(arrow.angle).toBeCloseTo(90);
	});

	it('flips a point behind the camera, so the arrow still points at it', () => {
		// behind the eye, a point up-left projects mirrored: down-right
		const arrow = edgeArrow({ x: 0.2, y: -0.2, z: 1.5 }, view)!;
		expect(arrow.x).toBeLessThan(view.width / 2);
		expect(arrow.y).toBeLessThan(view.height / 2);
	});

	it('stays inside the view', () => {
		for (const [x, y] of [
			[10, 10],
			[-10, 3],
			[0.5, -20],
			[-7, -7]
		]) {
			const arrow = edgeArrow({ x, y, z: 0.5 }, view)!;
			expect(arrow.x).toBeGreaterThanOrEqual(EDGE_MARGIN_PX - 1e-9);
			expect(arrow.x).toBeLessThanOrEqual(view.width - EDGE_MARGIN_PX + 1e-9);
			expect(arrow.y).toBeGreaterThanOrEqual(EDGE_MARGIN_PX - 1e-9);
			expect(arrow.y).toBeLessThanOrEqual(view.height - EDGE_MARGIN_PX + 1e-9);
		}
	});
});
