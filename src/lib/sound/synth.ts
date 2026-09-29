/**
 * The table's sounds, synthesised (tableplace-204): filtered noise and short
 * decaying oscillators, built on the fly. No sample files ship — the added
 * asset weight is zero bytes; only this code.
 *
 * Every recipe schedules its own nodes onto `dest` starting at `t0` and
 * returns how long (seconds) it sounds, so the engine can count voices.
 */

export type SoundName = 'lift' | 'drop' | 'slide' | 'flip' | 'shuffle' | 'tick' | 'dice' | 'ping';

export const SOUND_NAMES: readonly SoundName[] = [
	'lift',
	'drop',
	'slide',
	'flip',
	'shuffle',
	'tick',
	'dice',
	'ping'
];

type Recipe = (ctx: AudioContext, dest: AudioNode, t0: number, noise: AudioBuffer) => number;

/** one shaped burst of the shared noise buffer through a band-pass */
function burst(
	ctx: AudioContext,
	dest: AudioNode,
	noise: AudioBuffer,
	t0: number,
	{
		dur,
		gain,
		from,
		to = from,
		q = 1,
		type = 'bandpass'
	}: {
		dur: number;
		gain: number;
		from: number;
		to?: number;
		q?: number;
		type?: BiquadFilterType;
	}
) {
	const src = ctx.createBufferSource();
	src.buffer = noise;
	const filter = ctx.createBiquadFilter();
	filter.type = type;
	filter.Q.value = q;
	filter.frequency.setValueAtTime(from, t0);
	filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
	const env = ctx.createGain();
	env.gain.setValueAtTime(0.0001, t0);
	env.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.008, dur / 3));
	env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
	src.connect(filter).connect(env).connect(dest);
	src.start(t0, Math.random() * 0.1);
	src.stop(t0 + dur + 0.02);
}

/** one decaying oscillator note */
function tone(
	ctx: AudioContext,
	dest: AudioNode,
	t0: number,
	{
		dur,
		gain,
		from,
		to = from,
		wave = 'sine'
	}: { dur: number; gain: number; from: number; to?: number; wave?: OscillatorType }
) {
	const osc = ctx.createOscillator();
	osc.type = wave;
	osc.frequency.setValueAtTime(from, t0);
	if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
	const env = ctx.createGain();
	env.gain.setValueAtTime(0.0001, t0);
	env.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
	env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
	osc.connect(env).connect(dest);
	osc.start(t0);
	osc.stop(t0 + dur + 0.02);
}

export const RECIPES: Record<SoundName, Recipe> = {
	// picked up: a soft rising breath of felt
	lift(ctx, dest, t, noise) {
		burst(ctx, dest, noise, t, { dur: 0.08, gain: 0.35, from: 700, to: 1800, q: 1.2 });
		return 0.1;
	},
	// set down: a low thump under a short click
	drop(ctx, dest, t, noise) {
		tone(ctx, dest, t, { dur: 0.1, gain: 0.7, from: 150, to: 55 });
		burst(ctx, dest, noise, t, { dur: 0.05, gain: 0.5, from: 1400, type: 'lowpass' });
		return 0.13;
	},
	// a card sliding over felt: a falling hiss
	slide(ctx, dest, t, noise) {
		burst(ctx, dest, noise, t, { dur: 0.16, gain: 0.3, from: 3200, to: 1100, q: 0.8 });
		return 0.18;
	},
	// a flick and a flap
	flip(ctx, dest, t, noise) {
		burst(ctx, dest, noise, t, { dur: 0.04, gain: 0.45, from: 4200, q: 1.5 });
		burst(ctx, dest, noise, t + 0.05, { dur: 0.05, gain: 0.35, from: 2600, q: 1.2 });
		return 0.12;
	},
	// a riffle: a run of tiny clacks with wandering pitch
	shuffle(ctx, dest, t, noise) {
		const n = 12;
		for (let i = 0; i < n; i++)
			burst(ctx, dest, noise, t + i * 0.032 + Math.random() * 0.01, {
				dur: 0.03,
				gain: 0.22 + Math.random() * 0.12,
				from: 2200 + Math.random() * 2400,
				q: 1.5
			});
		return n * 0.032 + 0.06;
	},
	// a counter step: a clean two-partial tick
	tick(ctx, dest, t) {
		tone(ctx, dest, t, { dur: 0.035, gain: 0.35, from: 1500, wave: 'triangle' });
		tone(ctx, dest, t, { dur: 0.025, gain: 0.2, from: 2250, wave: 'triangle' });
		return 0.06;
	},
	// dice on wood: a few hard clacks, each softer and later than the last
	dice(ctx, dest, t, noise) {
		let at = t;
		let gap = 0.05;
		for (let i = 0; i < 6; i++) {
			const soft = 1 - i * 0.14;
			const pitch = 700 + Math.random() * 500;
			tone(ctx, dest, at, { dur: 0.05, gain: 0.35 * soft, from: pitch, to: pitch * 0.6 });
			burst(ctx, dest, noise, at, { dur: 0.03, gain: 0.5 * soft, from: 2800, q: 1 });
			at += gap;
			gap *= 1.28;
		}
		return at - t + 0.06;
	},
	// a bell: two inharmonic partials, long decay
	ping(ctx, dest, t) {
		tone(ctx, dest, t, { dur: 0.5, gain: 0.45, from: 880 });
		tone(ctx, dest, t, { dur: 0.32, gain: 0.25, from: 1320 });
		return 0.55;
	}
};

/** a shared half-second of white noise for the recipes to shape */
export function makeNoise(ctx: AudioContext): AudioBuffer {
	const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
	return buffer;
}
