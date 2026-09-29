/**
 * The dev-only stub validator (tableplace-171).
 *
 * No rules engine exists yet, and that is exactly why this is here: an interface
 * with no implementation behind it is a guess. One toy rule — *you may only act
 * on entities your own seat owns* — is enough to drive the gate's shape into
 * existence, so the Phase 2 engine adapter arrives at a slot to plug into rather
 * than a slot to design. There is deliberately **no turn concept**: turn state
 * does not exist on this table yet, and inventing one here would be inventing
 * the engine.
 *
 * Ownership is read straight off the ID. Entities are minted
 * `<kind>:<owner>:<rest>` — `piece:<playerId>:<slug>` (`actions/piece.ts`),
 * `deck:<playerId>:<n>` (`actions/deck.ts`), `card:<owner>:<slot>-<code>`
 * (`compose/pack.ts`) — and the player HUD already derives an opponent's hand
 * size from precisely that, so there is nothing new to put on the wire to know
 * whose a card is.
 *
 * Only TOP-LEVEL string arguments are inspected. A verb that nests ids inside a
 * payload is *creating* those entities rather than acting on somebody else's
 * (`addDeck({cards: [...]})` builds a whole deck of them), and the arguments a
 * validator sees are JSON-reduced anyway, so a 52-card payload is elided before
 * it ever gets here.
 *
 * Default OFF, and refused outside a dev build: the headline property of the
 * gate is that a table with no validator registered behaves byte-identically to
 * one built before it existed, and a stub that installed itself would be the
 * first thing to break that.
 */

import {
	clearIntentValidator,
	setIntentValidator,
	type IntentValidator,
	type IntentVerdict
} from '$lib/gate';

const ALLOW: IntentVerdict = { allow: true };

/**
 * `card:seat0:main-AS` → `seat0`. Null for anything that is not an owned entity
 * id, which is most arguments — a seat number, a rotation, a player id.
 */
const OWNED_ID = /^(card|deck|piece):([^:]+):/;

export function ownerOf(id: string): { kind: string; owner: string } | null {
	const match = OWNED_ID.exec(id);
	return match ? { kind: match[1]!, owner: match[2]! } : null;
}

/**
 * The toy rule. Synchronous, total, and it never reads the store: everything it
 * needs is in the proposed intent, which is also all a remote referee would have.
 */
export const stubValidator: IntentValidator = (intent) => {
	for (const arg of intent.args) {
		if (typeof arg !== 'string') continue;
		const entity = ownerOf(arg);
		if (!entity || entity.owner === intent.seat) continue;
		// the wording is the rulebook's, and the gate toasts it verbatim — phrased
		// like the deck refusals the radial menu already voices
		return { allow: false, reason: `That ${entity.kind} isn't yours to touch` };
	}
	return ALLOW;
};

let installed = false;

/** Register the toy rule. A no-op outside a dev build. */
export function installStubValidator(): void {
	if (!import.meta.env.DEV) {
		console.warn('the stub intent validator is dev-only and was not installed');
		return;
	}
	setIntentValidator(stubValidator);
	installed = true;
}

export function removeStubValidator(): void {
	clearIntentValidator();
	installed = false;
}

export function isStubValidatorInstalled(): boolean {
	return installed;
}
