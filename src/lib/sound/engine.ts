/**
 * Table sounds (tableplace-204): the engine. Purely local — nothing here
 * touches game state or the wire.
 *
 * Two gates, both checked on every `playSound`:
 * - the browser will not play audio before a user gesture, and neither do we:
 *   the AudioContext is not even created until the first pointer, key or
 *   touch event (`armSound`); anything asked for before that is dropped, not
 *   queued — a sound that lands seconds late is worse than none;
 * - the mute switch (`soundEnabled`), remembered per browser.
 *
 * What a remote player did plays at `SOUND_REMOTE_VOLUME` of what you did.
 */

import { get, writable } from 'svelte/store';
import {
	SOUND_MASTER_GAIN,
	SOUND_MAX_VOICES,
	SOUND_MIN_GAP_MS,
	SOUND_OWN_VOLUME,
	SOUND_REMOTE_VOLUME
} from '$lib/utils/constants-sound';
import { makeNoise, RECIPES, SOUND_NAMES, type SoundName } from './synth';

const SOUND_KEY = 'sound:v1';

function readEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem(SOUND_KEY) !== 'off';
	} catch {
		return true;
	}
}

/** the mute switch: sound is on unless this browser switched it off */
export const soundEnabled = writable(readEnabled());

soundEnabled.subscribe((on) => {
	try {
		if (on) globalThis.localStorage?.removeItem(SOUND_KEY);
		else globalThis.localStorage?.setItem(SOUND_KEY, 'off');
	} catch {
		// private window or blocked storage: the setting lasts this session only
	}
});

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let gestured = false;
let voices = 0;
const lastAt = new Map<SoundName, number>();

/** what actually started, by sound — the render harness reads this */
const played: Record<SoundName, number> = Object.fromEntries(
	SOUND_NAMES.map((n) => [n, 0])
) as Record<SoundName, number>;
export const soundStats = () => ({ ...played, gestured, running: ctx?.state === 'running' });

function ensureContext(): AudioContext | null {
	if (ctx) return ctx;
	const Ctor =
		globalThis.AudioContext ??
		(globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	try {
		ctx = new Ctor();
		master = ctx.createGain();
		master.gain.value = SOUND_MASTER_GAIN;
		master.connect(ctx.destination);
		noise = makeNoise(ctx);
	} catch {
		ctx = null;
	}
	return ctx;
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

/**
 * Listen for the first user gesture, then create (and resume) the audio
 * context inside it. Returns the teardown. Safe to call more than once.
 */
export function armSound(target: Window = window): () => void {
	const onGesture = () => {
		gestured = true;
		const audio = ensureContext();
		if (audio?.state === 'suspended') void audio.resume().catch(() => {});
		for (const type of GESTURES) target.removeEventListener(type, onGesture, true);
	};
	if (gestured) onGesture();
	else for (const type of GESTURES) target.addEventListener(type, onGesture, true);
	return () => {
		for (const type of GESTURES) target.removeEventListener(type, onGesture, true);
	};
}

/**
 * Play a table sound. `remote` = another player caused it (quieter).
 * Returns whether it started.
 */
export function playSound(name: SoundName, { remote = false }: { remote?: boolean } = {}): boolean {
	if (!get(soundEnabled) || !gestured || !ctx || !master || !noise) return false;
	if (ctx.state !== 'running') return false;
	const now = performance.now();
	if (now - (lastAt.get(name) ?? -Infinity) < SOUND_MIN_GAP_MS) return false;
	if (voices >= SOUND_MAX_VOICES) return false;
	lastAt.set(name, now);

	const bus = ctx.createGain();
	bus.gain.value = remote ? SOUND_REMOTE_VOLUME : SOUND_OWN_VOLUME;
	bus.connect(master);
	const length = RECIPES[name](ctx, bus, ctx.currentTime + 0.005, noise);
	played[name]++;
	voices++;
	setTimeout(
		() => {
			voices--;
			bus.disconnect();
		},
		length * 1000 + 60
	);
	return true;
}

/** test seam: forget gesture, context and rate limits */
export function resetSoundForTests() {
	ctx = null;
	master = null;
	noise = null;
	gestured = false;
	voices = 0;
	lastAt.clear();
	for (const n of SOUND_NAMES) played[n] = 0;
}
