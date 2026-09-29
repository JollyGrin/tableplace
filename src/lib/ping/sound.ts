/**
 * The ping's sound (tableplace-198) — a hook, off until something turns sound
 * on.
 *
 * There is no sound setting yet (tableplace-204). Until there is, nothing
 * installs a player and a ping is silent. When sound lands it calls
 * `setPingSound(playPingTone)` while sound is enabled and `setPingSound(null)`
 * when it is turned off — this module never decides on its own to make noise.
 */

let player: (() => void) | null = null;

/** install (or, with null, remove) what a ping plays */
export function setPingSound(play: (() => void) | null) {
	player = play;
}

/** called once per ping drawn */
export function playPingSound() {
	try {
		player?.();
	} catch {
		// a sound that cannot play (no audio device, a blocked context) is not
		// worth a broken ping
	}
}

let audio: AudioContext | null = null;

/** a short two-note chime, synthesised: no asset to fetch or cache */
export function playPingTone() {
	if (typeof AudioContext === 'undefined') return;
	audio ??= new AudioContext();
	const start = audio.currentTime;
	for (const [freq, delay, length, level] of [
		[880, 0, 0.25, 0.08],
		[1320, 0.09, 0.3, 0.06]
	] as const) {
		const osc = audio.createOscillator();
		const gain = audio.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;
		gain.gain.setValueAtTime(level, start + delay);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + length);
		osc.connect(gain).connect(audio.destination);
		osc.start(start + delay);
		osc.stop(start + delay + length);
	}
}
