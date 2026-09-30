/**
 * Which table sounds a state patch makes (tableplace-204).
 *
 * Read off the same merge patches the store already handles, from your own
 * writes and a peer's alike — so a remote player's move is heard with no
 * message of its own. `before` is the state the patch is about to land on.
 *
 * Generic on purpose: it hears heights, positions, a flip, a shuffle stamp,
 * a counter value and a roll nonce — never what a piece is called.
 */

import {
	SOUND_LIFT_DELTA,
	SOUND_MAX_ENTITIES,
	SOUND_SLIDE_DISTANCE
} from '$lib/utils/constants-sound';
import type { SoundName } from './synth';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const vec = (v: unknown): number[] | null =>
	Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')
		? (v as number[])
		: null;

export function soundsForPatch(patch: unknown, before: unknown): SoundName[] {
	if (!isRec(patch) || !isRec(before)) return [];
	const heard = new Set<SoundName>();
	let entities = 0;

	for (const collection of ['cards', 'decks', 'pieces'] as const) {
		const patched = patch[collection];
		const known = before[collection];
		if (!isRec(patched) || !isRec(known)) continue;
		for (const [id, change] of Object.entries(patched)) {
			entities++;
			const was = known[id];
			// a new or deleted entity is a spawn or a removal, not a gesture
			if (!isRec(change) || !isRec(was)) continue;

			const from = vec(was.position);
			const to = vec(change.position);
			if (from && to) {
				const dy = to[1] - from[1];
				if (dy >= SOUND_LIFT_DELTA) heard.add('lift');
				else if (dy <= -SOUND_LIFT_DELTA) heard.add('drop');
				else if (
					Math.hypot(to[0] - from[0], to[2] - from[2]) >= SOUND_SLIDE_DISTANCE &&
					Math.max(from[1], to[1]) < SOUND_LIFT_DELTA * 2
				)
					heard.add('slide');
			}

			const turn = vec(change.rotation);
			const turned = vec(was.rotation);
			if (collection === 'cards' && turn && turned && turn[0] !== turned[0]) heard.add('flip');

			if (
				collection === 'decks' &&
				typeof change.shuffledAt === 'number' &&
				change.shuffledAt !== was.shuffledAt
			)
				heard.add('shuffle');

			if (collection === 'pieces') {
				if (typeof change.rollSeq === 'number' && change.rollSeq !== was.rollSeq) heard.add('dice');
				else if (
					was.kind === 'counter' &&
					typeof change.value === 'number' &&
					change.value !== was.value
				)
					heard.add('tick');
			}
		}
	}
	// a sync or a scenario load touches many entities at once: not something anyone did
	return entities > SOUND_MAX_ENTITIES ? [] : [...heard];
}
