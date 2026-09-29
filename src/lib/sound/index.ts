/**
 * Table sounds, wired to the live store (tableplace-204). `installSound` is
 * called once by /play; /setup never installs it, so authoring is silent.
 */

import { setPingSound } from '$lib/ping/sound';
import { observePatches } from '$lib/store/game/gameStore.svelte';
import { soundsForPatch } from './classify';
import { armSound, playSound } from './engine';

export { soundEnabled, soundStats, playSound } from './engine';
export type { SoundName } from './synth';

/**
 * Hear every patch (yours at full volume, a peer's quieter) and arm the
 * audio for the first gesture. Returns the teardown.
 */
export function installSound(): () => void {
	const disarm = armSound();
	// the ping's chime (tableplace-198) goes through the same gates as everything
	// else: none before a gesture, none while muted
	setPingSound(() => void playSound('ping'));
	observePatches((patch, before, origin) => {
		for (const name of soundsForPatch(patch, before))
			playSound(name, { remote: origin === 'remote' });
	});
	return () => {
		disarm();
		setPingSound(null);
		observePatches(null);
	};
}
