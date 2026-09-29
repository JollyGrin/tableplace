import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { soundsForPatch } from '../classify';
import { armSound, playSound, resetSoundForTests, soundEnabled, soundStats } from '../engine';

const state = {
	cards: { c: { position: [0, 0.1, 0], rotation: [0, 0, 0] } },
	decks: { d: { position: [0, 0.1, 0], shuffledAt: 1 } },
	pieces: {
		n: { kind: 'counter', value: 1, position: [0, 0.1, 0] },
		die: { kind: 'die', value: 1, rollSeq: 1, position: [0, 0.1, 0] }
	}
};

describe('soundsForPatch', () => {
	it('hears lift, drop and slide from heights and distance', () => {
		expect(soundsForPatch({ cards: { c: { position: [0, 2, 0] } } }, state)).toEqual(['lift']);
		const held = { cards: { c: { position: [0, 2, 0] } } };
		expect(soundsForPatch({ cards: { c: { position: [3, 0.1, 0] } } }, held)).toEqual(['drop']);
		expect(soundsForPatch({ cards: { c: { position: [3, 0.1, 0] } } }, state)).toEqual(['slide']);
	});
	it('is silent for a carried entity streaming across the table', () => {
		const held = { cards: { c: { position: [0, 2, 0] } } };
		expect(soundsForPatch({ cards: { c: { position: [3, 2, 0] } } }, held)).toEqual([]);
	});
	it('hears flip, shuffle, counter tick and dice', () => {
		expect(soundsForPatch({ cards: { c: { rotation: [180, 0, 0] } } }, state)).toEqual(['flip']);
		expect(soundsForPatch({ decks: { d: { shuffledAt: 2 } } }, state)).toEqual(['shuffle']);
		expect(soundsForPatch({ pieces: { n: { value: 2 } } }, state)).toEqual(['tick']);
		expect(soundsForPatch({ pieces: { die: { value: 4, rollSeq: 2 } } }, state)).toEqual(['dice']);
	});
	it('ignores spawns, deletions and bulk patches', () => {
		expect(soundsForPatch({ cards: { x: { position: [0, 2, 0] } } }, state)).toEqual([]);
		expect(soundsForPatch({ cards: { c: null } }, state)).toEqual([]);
		const many = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [`k${i}`, { position: [0, 2, 0] }])
		);
		const known = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [`k${i}`, { position: [0, 0.1, 0] }])
		);
		expect(soundsForPatch({ cards: many }, { cards: known })).toEqual([]);
	});
});

/** the least AudioContext the engine touches, counting what it schedules */
function fakeAudio(state: 'running' | 'suspended' = 'running') {
	const node = (): Record<string, unknown> => {
		const n: Record<string, unknown> = {
			gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
			frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
			Q: { value: 1 },
			connect: (to: unknown) => to ?? n,
			disconnect() {},
			start() {},
			stop() {}
		};
		return n;
	};
	return class {
		state = state;
		sampleRate = 8000;
		currentTime = 0;
		destination = node();
		created = 0;
		constructor() {
			(globalThis as { __ctx?: unknown }).__ctx = this;
		}
		resume = () => Promise.resolve();
		createGain = node;
		createOscillator = node;
		createBiquadFilter = node;
		createBufferSource = node;
		createBuffer = () => ({ getChannelData: () => new Float32Array(4000) });
	};
}

describe('engine gates', () => {
	beforeEach(() => {
		resetSoundForTests();
		soundEnabled.set(true);
		vi.stubGlobal('AudioContext', fakeAudio());
	});

	it('plays nothing before a user gesture, then plays once one arrives', () => {
		const target = new EventTarget() as unknown as Window;
		armSound(target);
		expect(playSound('drop')).toBe(false);
		expect(soundStats().gestured).toBe(false);
		target.dispatchEvent(new Event('pointerdown'));
		expect(playSound('drop')).toBe(true);
		expect(soundStats().drop).toBe(1);
	});

	it('plays nothing while muted, and remembers the switch', () => {
		const target = new EventTarget() as unknown as Window;
		armSound(target);
		target.dispatchEvent(new Event('keydown'));
		soundEnabled.set(false);
		expect(playSound('flip')).toBe(false);
		expect(globalThis.localStorage?.getItem('sound:v1')).toBe('off');
		soundEnabled.set(true);
		expect(get(soundEnabled)).toBe(true);
		expect(playSound('flip')).toBe(true);
	});

	it('rate-limits a burst of the same sound', () => {
		const target = new EventTarget() as unknown as Window;
		armSound(target);
		target.dispatchEvent(new Event('pointerdown'));
		expect(playSound('tick')).toBe(true);
		expect(playSound('tick')).toBe(false);
	});
});
