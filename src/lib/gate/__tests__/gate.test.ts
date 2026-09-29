/**
 * The referee seam (tableplace-171) as seen from the store and the wire.
 *
 * Two things are checked here that a browser cannot check cheaply — that a
 * denial leaves NOTHING behind on any of the three channels (patch, wire,
 * intent log), and that a validator is consulted exactly once per action even
 * though two seams ask. The player-facing half — snap-back and the toast on a
 * real drag — is not assertable in jsdom and lives in `e2e/specs.ts`, which is
 * the acceptance for it.
 *
 * The websocket wrapper is installed on purpose, unlike the intent-channel
 * store test next door: "no broadcast" is half of what a denial means, and
 * without a wrapper there is no broadcast to withhold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnection = vi.hoisted(() => {
	const delivered: Sent[] = [];
	return {
		delivered,
		sendMessage: vi.fn((message: Sent) => {
			delivered.push(message);
			return true;
		})
	};
});

const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('../../websocket/connection', () => ({ sendMessage: mockConnection.sendMessage }));
vi.mock('svelte-french-toast', () => ({ default: mockToast }));

import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { clearIntentLog, intentLog, type IntentEvent } from '$lib/store/game/intents';
import { initWrappers } from '$lib/websocket/storeIntegration';
import {
	clearIntentValidator,
	clearIntentRefusals,
	hasIntentValidator,
	intentRefusals,
	refusalToMove,
	setIntentValidator,
	type IntentValidator,
	type IntentVerdict
} from '..';
import { ownerOf, stubValidator } from '$lib/dev/stub-validator';

/** as much of an outgoing message as these assertions look at */
type Sent = {
	playerId: string;
	value: { cards?: Record<string, unknown>; __intents?: IntentEvent[] };
};

/**
 * `initWrappers` monkeypatches `gameStore.updateState` in place, so each test
 * puts the untouched function back before re-wrapping — otherwise the wrapper
 * wraps the wrapper and every patch is sent twice (see intent-wire.test.ts).
 */
const unwrapped = gameStore.updateState;

/** a fresh actor per test: `seq` counts per seat for the life of the module */
let run = 0;
const me = () => `gate-tester-${run}`;
const OTHER = 'someone-else';

/** a card of mine, and one that is not */
const mine = () => `card:${me()}:main-AS`;
const theirs = `card:${OTHER}:main-KH`;

const ALLOW: IntentVerdict = { allow: true };

function allowAll() {
	return vi.fn<IntentValidator>(() => ALLOW);
}

function denyAll(reason = 'not on my watch') {
	return vi.fn<IntentValidator>(() => ({ allow: false, reason }));
}

beforeEach(() => {
	mockConnection.delivered.length = 0;
	vi.clearAllMocks();
	run++;
	localStorage.clear();
	localStorage.setItem('myPlayerId', me());
	gameStore.updateState = unwrapped;
	gameStore.set({
		players: { [me()]: { id: me(), seat: 0 } },
		decks: {},
		cards: {
			[mine()]: { faceImageUrl: 'gen:std52/AS', rotation: [0, 0, 0] },
			[theirs]: { faceImageUrl: 'gen:std52/KH', rotation: [0, 0, 0] }
		}
	} as never);
	clearIntentLog();
	clearIntentRefusals();
	clearIntentValidator();
	initWrappers();
});

afterEach(() => {
	clearIntentValidator();
	gameStore.updateState = unwrapped;
});

/** the rotation a flip writes, or undefined when nothing was written */
const rotationOf = (id: string) => get(gameStore)?.cards?.[id]?.rotation?.[0];

describe('with no validator registered', () => {
	it('is not registered — the pass-through default is the absence of a slot filler', () => {
		expect(hasIntentValidator()).toBe(false);
	});

	it('lets an action patch, broadcast and mint exactly as before', () => {
		gameActions.flipCard(mine());

		expect(rotationOf(mine())).toBe(180);
		expect(mockConnection.delivered).toHaveLength(1);
		expect(mockConnection.delivered[0]?.value?.__intents?.map((i) => i.verb)).toEqual(['flipCard']);
		expect(intentLog().map((i) => i.verb)).toEqual(['flipCard']);
		expect(mockToast.error).not.toHaveBeenCalled();
	});

	it('answers a pickup without judging anything', () => {
		expect(refusalToMove(theirs)).toBeNull();
	});
});

describe('a denied action', () => {
	it('leaves no patch, no broadcast and no intent — nothing crossed the wire', () => {
		setIntentValidator(denyAll('That card isn’t yours to touch'));

		gameActions.flipCard(theirs);

		expect(rotationOf(theirs)).toBe(0);
		expect(mockConnection.delivered).toHaveLength(0);
		expect(intentLog()).toHaveLength(0);
	});

	it('says why, once, in the validator’s own words', () => {
		setIntentValidator(denyAll('no touching'));

		gameActions.flipCard(theirs);

		expect(mockToast.error).toHaveBeenCalledTimes(1);
		expect(mockToast.error).toHaveBeenCalledWith('no touching');
		expect(intentRefusals()).toEqual([{ verb: 'flipCard', reason: 'no touching' }]);
	});

	it('does not burn a `seq` — the next allowed action numbers from 1', () => {
		const gatekeeper = vi.fn<IntentValidator>((intent) =>
			intent.args[0] === theirs ? { allow: false, reason: 'nope' } : { allow: true }
		);
		setIntentValidator(gatekeeper);

		gameActions.flipCard(theirs);
		gameActions.flipCard(mine());

		expect(intentLog().map((i) => [i.seq, i.verb])).toEqual([[1, 'flipCard']]);
	});
});

describe('an allowing validator', () => {
	it('changes nothing about what happens', () => {
		setIntentValidator(allowAll());

		gameActions.flipCard(mine());

		expect(rotationOf(mine())).toBe(180);
		expect(mockConnection.delivered).toHaveLength(1);
		expect(intentLog().map((i) => i.verb)).toEqual(['flipCard']);
	});

	it('is asked once per action, though two seams ask', () => {
		// the websocket wrapper checks before it sends and the store checks before
		// it applies; a referee with a rulebook to consult must not pay twice, and
		// a player must not be refused twice
		const validator = allowAll();
		setIntentValidator(validator);

		gameActions.flipCard(mine());

		expect(validator).toHaveBeenCalledTimes(1);
	});

	it('sees the verb, the acting seat and the arguments that ride the wire', () => {
		const validator = allowAll();
		setIntentValidator(validator);

		gameActions.flipCard(mine());

		expect(validator).toHaveBeenCalledWith({
			seat: me(),
			verb: 'flipCard',
			args: [mine()]
		});
	});
});

describe('what the gate deliberately does not judge', () => {
	it('a raw patch with no verb in scope — the per-frame drag stream, a scenario load', () => {
		const validator = denyAll();
		setIntentValidator(validator);

		gameStore.updateState({ cards: { [theirs]: { rotation: [90, 0, 0] } } } as never);

		expect(validator).not.toHaveBeenCalled();
		expect(rotationOf(theirs)).toBe(90);
	});

	it('an inbound patch — a peer’s action is theirs to rule on, not ours', () => {
		const validator = denyAll();
		setIntentValidator(validator);

		gameStore.updateStateSilently({ cards: { [theirs]: { rotation: [180, 0, 0] } } } as never);

		expect(validator).not.toHaveBeenCalled();
		expect(rotationOf(theirs)).toBe(180);
	});

	it('a read-only verb, which never reaches a patch seam at all', () => {
		const validator = denyAll();
		setIntentValidator(validator);

		expect(gameActions.getMyId()).toBe(me());
		expect(validator).not.toHaveBeenCalled();
	});
});

describe('a validator that throws', () => {
	it('allows the action rather than freezing the table', () => {
		setIntentValidator(() => {
			throw new Error('the rulebook is on fire');
		});

		gameActions.flipCard(mine());

		expect(rotationOf(mine())).toBe(180);
		expect(intentLog().map((i) => i.verb)).toEqual(['flipCard']);
	});
});

describe('the dev stub rule — you may only act on what your seat owns', () => {
	const propose = (verb: string, args: unknown[]) => stubValidator({ seat: me(), verb, args });

	it('allows an entity the acting seat owns', () => {
		expect(propose('flipCard', [mine()])).toEqual({ allow: true });
	});

	it('refuses another seat’s entity, naming its kind', () => {
		expect(propose('flipCard', [theirs])).toEqual({
			allow: false,
			reason: "That card isn't yours to touch"
		});
		expect(propose('moveEntity', [`piece:${OTHER}:token-0`])).toEqual({
			allow: false,
			reason: "That piece isn't yours to touch"
		});
		expect(propose('shuffleDeck', [`deck:${OTHER}:0`])).toEqual({
			allow: false,
			reason: "That deck isn't yours to touch"
		});
	});

	it('ignores arguments that are not owned entity ids', () => {
		// a seat number, a player id, a rotation, a nested payload of ids
		expect(propose('rotatePiece', [90])).toEqual({ allow: true });
		expect(propose('moveCardToTray', [mine(), me()])).toEqual({ allow: true });
		expect(propose('addDeck', [{ cards: [{ id: theirs }] }])).toEqual({ allow: true });
	});

	it('reads ownership off the id, and nothing else', () => {
		expect(ownerOf('card:seat0:main-AS')).toEqual({ kind: 'card', owner: 'seat0' });
		expect(ownerOf('deck:abc:0')).toEqual({ kind: 'deck', owner: 'abc' });
		expect(ownerOf('token')).toBeNull();
		expect(ownerOf('gen:std52/AS')).toBeNull();
	});

	it('drives the gate end to end: my card flips, theirs does not', () => {
		setIntentValidator(stubValidator);

		gameActions.flipCard(mine());
		gameActions.flipCard(theirs);

		expect(rotationOf(mine())).toBe(180);
		expect(rotationOf(theirs)).toBe(0);
		expect(intentLog().map((i) => i.verb)).toEqual(['flipCard']);
		expect(mockConnection.delivered).toHaveLength(1);
		expect(refusalToMove(theirs)).toBe("That card isn't yours to touch");
		expect(refusalToMove(mine())).toBeNull();
	});
});
