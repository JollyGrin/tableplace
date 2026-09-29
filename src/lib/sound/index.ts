/**
 * Table sounds, wired to the live store (tableplace-204). `installSound` is
 * called once by /play; /setup never installs it, so authoring is silent.
 */

import { observePatches } from '$lib/store/game/gameStore.svelte';
import { soundsForPatch } from './classify';
import { armSound, playSound } from './engine';

export { soundEnabled, soundStats, playSound } from './engine';
export type { SoundName } from './synth';

/**
 * Hear every patch (yours at full volume, a peer's quieter) and arm the
 * audio for the first gesture. Returns the teardown.
 *
 * Hook for the ping (tableplace-198): `playSound('ping', { remote: true })`
 * from wherever a peer's ping arrives — the recipe is already here.
 */
export function installSound(): () => void {
	const disarm = armSound();
	observePatches((patch, before, origin) => {
		for (const name of soundsForPatch(patch, before))
			playSound(name, { remote: origin === 'remote' });
	});
	return () => {
		disarm();
		observePatches(null);
	};
}
