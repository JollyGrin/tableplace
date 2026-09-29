/**
 * The hint bar's line: what you can do to whatever is under the pointer, in
 * one quiet sentence. There is no tutorial — this is it.
 *
 * Pure over (game state, who I am, what is under the pointer, what a release
 * would do) so every rule is unit-testable without a canvas; `HintBar.svelte`
 * only draws the answer. Every word comes from the verb registry or from the
 * entity's own name — nothing here knows what game is on the table.
 */

import { currentPieceState } from '$lib/compose/piece';
import {
	DRAG_MODIFIERS,
	RELEASE_TEXT,
	TABLE_BASICS,
	TARGET_NOUNS,
	verbsFor
} from '$lib/verbs/registry';
import type { DropKind } from '$lib/utils/transforms/drop';
import type { GameDTO } from '$lib/store/game/types';
import type { Hotkey, Verb, VerbActor, VerbTarget } from '$lib/verbs/types';

/** one "key → what it does" pair; `key` is empty for a plain statement */
export type HintPart = { key: string; text: string; enabled: boolean; reason?: string };

export type Hint = {
	/** the thing the line is about; null when nothing is */
	name: string | null;
	parts: HintPart[];
};

/** how many verbs one line names — the rest are one `?` away */
export const HINT_MAX_VERBS = 5;

export type HintInput = {
	game: Partial<GameDTO> | undefined;
	actor: VerbActor;
	/** what is under the pointer, most specific first — `targetsUnder` */
	targets: VerbTarget[];
	/** the id being carried, if any */
	dragging: string | null;
	/** where the carried thing would land on release, if it resolves */
	dropKind: DropKind | null;
};

type VerbsFor = (target: VerbTarget, actor: VerbActor) => Verb[];

/**
 * The name the pointer may reveal. Hidden stays hidden: a face-down card is
 * just a card, and a pile says how many it holds, not what is inside.
 */
export function entityName(
	game: Partial<GameDTO> | undefined,
	actor: VerbActor,
	target: VerbTarget
): string {
	const noun = TARGET_NOUNS[target.kind];
	if (!('id' in target)) return noun;
	if (target.kind === 'card') {
		const card = game?.cards?.[target.id];
		const faceDown = (card?.rotation ?? [0])[0] === 180;
		return (!faceDown && card?.name) || noun;
	}
	if (target.kind === 'hand-card') {
		const tray = actor.playerId ? game?.players?.[actor.playerId]?.tray : undefined;
		return tray?.[target.id]?.name || noun;
	}
	if (target.kind === 'deck') {
		const deck = game?.decks?.[target.id];
		const cards = deck?.cards ?? [];
		// the face-up top is cards[0] — see Deck.svelte
		const top = deck?.isFaceUp ? cards[0]?.name : undefined;
		return `${top || noun} (${cards.length})`;
	}
	const piece = game?.pieces?.[target.id];
	if (!piece) return noun;
	const states = piece.states ?? [];
	const state = states.length > 1 ? states[currentPieceState(piece)]?.name : undefined;
	const name = piece.name || noun;
	return state ? `${name} — ${state}` : name;
}

/** does pressing `a` stop the same keypress reaching `b`? (see `matchesHotkey`) */
function shadows(a: Hotkey, b: Hotkey): boolean {
	const shiftOverlaps = a.shift === undefined || b.shift === undefined || a.shift === b.shift;
	return shiftOverlaps && a.codes.some((code) => b.codes.includes(code));
}

const part = (key: string, text: string): HintPart => ({ key, text, enabled: true });

function verbPart(verb: Verb): HintPart {
	return {
		key: verb.hotkey?.label ?? verb.gesture ?? '',
		text: verb.label,
		enabled: verb.enabled,
		...(verb.reasonDisabled ? { reason: verb.reasonDisabled } : {})
	};
}

/**
 * The verbs the pointer offers right now, in the order a key would find them.
 * A key falls through to the next target under the pointer (G on a deck still
 * groups the card beneath — `keyboard.ts`), so a lower target's hotkey verbs
 * are listed too unless a higher one already claims the key. A gesture only
 * ever reaches the topmost thing, so only its gestures are named.
 */
function offeredVerbs(targets: VerbTarget[], actor: VerbActor, verbs: VerbsFor): Verb[] {
	const offered: Verb[] = [];
	targets.forEach((target, depth) => {
		for (const verb of verbs(target, actor)) {
			if (verb.hotkey) {
				if (offered.some((o) => o.hotkey && shadows(o.hotkey, verb.hotkey!))) continue;
			} else if (!verb.gesture || depth > 0) continue;
			offered.push(verb);
		}
	});
	return offered;
}

function entityTargetFor(id: string): VerbTarget {
	if (id.startsWith('deck:')) return { kind: 'deck', id };
	if (id.startsWith('piece:')) return { kind: 'piece', id };
	return { kind: 'card', id };
}

export function hintFor(input: HintInput, verbs: VerbsFor = verbsFor): Hint {
	const { game, actor, targets, dragging, dropKind } = input;

	if (dragging) {
		return {
			name: entityName(game, actor, entityTargetFor(dragging)),
			parts: [
				...(dropKind ? [part('', RELEASE_TEXT[dropKind])] : []),
				...DRAG_MODIFIERS.map((row) => part(row.key, row.action))
			]
		};
	}

	const top = targets.find((target) => target.kind !== 'table');
	if (top) {
		const under = targets.slice(targets.indexOf(top));
		return {
			name: entityName(game, actor, top),
			parts: offeredVerbs(under, actor, verbs).slice(0, HINT_MAX_VERBS).map(verbPart)
		};
	}

	// nothing under the pointer: the camera, the wheel, and the table's own
	// keys. A held verb (the preview) acts on something under the pointer, so
	// it has nothing to say here; `?` goes last so the line ends on "more".
	const table = verbs({ kind: 'table' }, actor).filter((verb) => verb.hotkey && !verb.release);
	const help = table.filter((verb) => verb.id === 'help');
	const rest = table.filter((verb) => verb.id !== 'help');
	return {
		name: null,
		parts: [
			...TABLE_BASICS.map((row) => part(row.key, row.action)),
			...[...rest, ...help].map(verbPart)
		]
	};
}
