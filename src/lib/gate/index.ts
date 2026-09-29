/**
 * The referee seam (tableplace-171).
 *
 * #169 made actions legible: every state-changing `gameActions` verb mints an
 * `IntentEvent` at the patch seam, and that channel deliberately knows no rules
 * — it is a readout. This is the other half: a single registrable **validator**
 * that sees the proposed intent at the same seam, *before* the patch applies or
 * broadcasts, and can say no.
 *
 * What a denial costs the table: nothing crosses the wire. No patch, no
 * broadcast, and no minted intent — a peer must not be able to tell that the
 * refused action was ever attempted, which is the difference between a rule and
 * a cosmetic one.
 *
 * Three properties are load-bearing:
 *
 *  - **Pass-through is free.** With no validator registered, `allowIntent` is
 *    one module-level null check and every code path behaves byte-identically
 *    to a build without a gate. Games with no rules engine pay nothing. The
 *    harness proves this at the wire rather than asserting it (see the
 *    `gate: pass-through` spec).
 *  - **One verdict per action.** The websocket wrapper asks before it sends and
 *    the store asks before it applies, so the answer is memoised against the
 *    live call's identity (`currentActionCall`). A validator is therefore
 *    called once per action and a refusal is voiced once.
 *  - **Local actor only.** The gate reads the `withIntent` frame stack, which
 *    only exists inside a local `gameActions` call. An inbound patch arrives
 *    through `updateStateSilently` with no frame at all, so a peer's action is
 *    never re-judged here — remote and asynchronous verdicts are the Phase 2
 *    adapter's problem, and the synchronous shape below is what it plugs into.
 *
 * A validator that throws is treated as an allow. A referee that crashes must
 * not be able to freeze the table — the same reasoning that keeps `onIntent`
 * listeners from taking a mutation down with them.
 */

import toast from 'svelte-french-toast';
import {
	actingSeat,
	currentActionCall,
	proposedIntent,
	type ProposedIntent
} from '$lib/store/game/intents';

export type { ProposedIntent };

/** Synchronous only, on purpose — see the module comment. */
export type IntentVerdict = { allow: true } | { allow: false; reason: string };

export type IntentValidator = (intent: ProposedIntent) => IntentVerdict;

/**
 * The verb a plain felt landing reads as (`drop/commit.ts` names it), and so
 * the verb a PICKUP asks the referee about. It lives here because the gate is
 * the only thing that has to ask the question before the drop resolves.
 */
export const MOVE_ENTITY = 'moveEntity';

const ALLOW: IntentVerdict = { allow: true };

/**
 * One slot. Composition and multiple validators are out of scope: a table has
 * one rulebook, and stacking two referees raises questions (whose reason wins?
 * does an allow override a deny?) that no caller needs answered yet.
 */
let validator: IntentValidator | null = null;

/** Register the referee. `null` clears it, which restores the pass-through default. */
export function setIntentValidator(fn: IntentValidator | null): void {
	validator = fn ?? null;
	judged = null;
}

export function clearIntentValidator(): void {
	setIntentValidator(null);
}

export function hasIntentValidator(): boolean {
	return validator !== null;
}

/** Ask the referee, absorbing a throw as an allow (see the module comment). */
function judge(proposed: ProposedIntent): IntentVerdict {
	if (!validator) return ALLOW;
	try {
		return validator(proposed) ?? ALLOW;
	} catch (error) {
		// warn, not error: a referee that crashed is a bug worth reading, but it
		// must not read as the table itself being broken
		console.warn('The intent validator threw — allowing the action:', error);
		return ALLOW;
	}
}

/** A refusal the player was shown, kept for the dev bridge and the harness. */
export type Refusal = { verb: string; reason: string };

/** Recent refusals, oldest dropped. Nothing in the app reads this. */
const REFUSAL_LIMIT = 50;
const refusals: Refusal[] = [];

export function intentRefusals(): Refusal[] {
	return [...refusals];
}

/** Forget them, so a spec can bracket one gesture. */
export function clearIntentRefusals(): void {
	refusals.length = 0;
}

/**
 * Say no, out loud.
 *
 * A toast carrying the validator's own `reason` is the whole of the deny UX for
 * an instantaneous verb — `flipCard` simply does not happen, and without a word
 * the table looks broken rather than refereed. Drag verbs get the snap-back on
 * top (`drop/commit.ts`). The wording is the validator's, never this module's:
 * only the rulebook knows why.
 */
export function refuse(verb: string, reason: string): void {
	refusals.push({ verb, reason });
	if (refusals.length > REFUSAL_LIMIT) refusals.splice(0, refusals.length - REFUSAL_LIMIT);
	toast.error(reason);
}

/** The one verdict the live call gets, so both seams read the same answer. */
let judged: { call: object; verdict: IntentVerdict } | null = null;

/**
 * The gate. Call it at a patch seam, ahead of everything that seam does, and
 * abandon the patch when it answers false.
 *
 * Both seams call it: `wsWrapperUpdateGameState` before it sends, so a refused
 * action never reaches the relay, and `gameStore.updateState` before it mints
 * and applies, so the gate does not depend on a websocket being installed at
 * all (an offline table is refereed too).
 */
export function allowIntent(): boolean {
	// the pass-through default, before anything is read or allocated
	if (!validator) return true;
	const call = currentActionCall();
	// not an action: the per-frame drag stream, a scenario load, an inbound
	// patch. Nothing named is running, so there is nothing to rule on.
	if (!call) return true;
	// the same call asking a second time: answer from the memo, and in particular
	// do NOT voice a second refusal for one action
	if (judged?.call === call) return judged.verdict.allow;

	const proposed = proposedIntent();
	if (!proposed) return true;
	const verdict = judge(proposed);
	judged = { call, verdict };
	if (!verdict.allow) refuse(proposed.verb, verdict.reason);
	return verdict.allow;
}

/**
 * May the local actor move this entity at all, and if not, why?
 *
 * The coarse question a PICKUP has to ask. Where a release will land is not
 * knowable when the entity is lifted — felt, a deck, a bag, the hand, each with
 * a verb of its own — so a drag asks about `moveEntity` and the specific verb is
 * still ruled on at the patch seam when the drop commits. Under a rulebook that
 * cares which target a move is legal for (Phase 1 step 3's legal-target
 * highlights), the two answers can differ; today they cannot.
 *
 * Returns null when the move is allowed, INCLUDING the no-validator case, which
 * it answers without allocating anything.
 */
export function refusalToMove(id: string): string | null {
	if (!validator) return null;
	const verdict = judge({ seat: actingSeat(), verb: MOVE_ENTITY, args: [id] });
	return verdict.allow ? null : verdict.reason;
}
