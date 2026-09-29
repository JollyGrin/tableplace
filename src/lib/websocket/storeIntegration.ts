import { allowIntent } from '$lib/gate';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { attachIntents, INTENTS_KEY, mintIntent } from '$lib/store/game/intents';
import type { GameDTO } from '$lib/store/game/types';
import { purgeUndefinedValues } from '$lib/utils/transforms/data';
import { createWsMetaData } from '$lib/utils/transforms/websocket';
import { sendMessage } from './connection';

/**
 * @deprecated
 * */
export function wsWrapperObjectUpdate(fn: Function) {
	return function passArgs(...args: any[]) {
		const [cardId, ...rest] = args;

		console.log('PAYLOAD WS SEND:', args, rest);
		const payload = purgeUndefinedValues({
			...rest[0],
			position: rest[0]?.position,
			rotation: rest[0]?.rotation
		});
		console.log('ws object: payload being passed', payload);

		sendMessage({
			...createWsMetaData(),
			// path: ['objects', cardId, ...[key]].filter((e) => e !== undefined), // add 'position' or other var to be more specific
			value: {
				objects: {
					[cardId]: payload
				}
			}
		});

		return fn(...args);
	};
}

/**
 * @deprecated
 * */
export function wsWrapperPlayerUpdate(fn: Function) {
	return function passArgs(...args: any[]) {
		console.log('ws player: spread args:', args, ...args);
		const [playerId, ...rest] = args;
		const payload = purgeUndefinedValues({
			...rest[0]
		});
		sendMessage({
			...createWsMetaData(),
			value: {
				players: {
					[playerId]: payload
				}
			}
		});

		return fn(...args);
	};
}

/**
 * @deprecated
 * */
export function wsWrapperUpdateDeck(fn: Function) {
	return function passArgs(...args: any[]) {
		console.log('ws deck: spread args', ...args);
		const [deckId, ...rest] = args;
		// const cards = rest[0]?.cards;
		const payload = purgeUndefinedValues({
			...rest[0]
		});

		// Position could be an array or already an object, let's ensure it's an object with x, y, z
		sendMessage({
			...createWsMetaData(),
			// TODO: figure out how to include path for when args is just 1
			// path: ['decks', deckId], // add 'position' or other var to be more specific
			value: {
				decks: {
					[deckId]: payload
				}
			}
		});

		return fn(...args);
	};
}

/**
 * Merge a new update payload into a pending (throttled) one so coalescing
 * NEVER drops entities. Two levels: collection (cards/decks/pieces/…) →
 * entity id → shallow field merge. Drag streams still coalesce correctly
 * (same id, latest position wins); bursts of distinct entities (imports!)
 * all survive to the server instead of only the last one.
 */
function mergePendingValue(pending: any, incoming: any) {
	const merged = { ...pending };
	for (const collection of Object.keys(incoming ?? {})) {
		// the piggybacked intents are a log, not a collection: coalescing two
		// patches must CONCATENATE them (pending first — it happened first), or a
		// throttled drop would silently lose the verb that caused it and the two
		// clients' intent streams would stop matching
		if (collection === INTENTS_KEY) {
			merged[INTENTS_KEY] = [...(pending?.[INTENTS_KEY] ?? []), ...(incoming[INTENTS_KEY] ?? [])];
			continue;
		}
		const incomingEntities = incoming[collection];
		if (!incomingEntities || typeof incomingEntities !== 'object') {
			merged[collection] = incomingEntities;
			continue;
		}
		const target = { ...(merged[collection] ?? {}) };
		for (const id of Object.keys(incomingEntities)) {
			const entity = incomingEntities[id];
			target[id] =
				entity && typeof entity === 'object' && target[id] && typeof target[id] === 'object'
					? { ...target[id], ...entity }
					: entity;
		}
		merged[collection] = target;
	}
	return merged;
}

export function wsWrapperUpdateGameState(fn: Function) {
	let lastSentTime = 0; // track the last time a message was sent
	let positionTimeout: ReturnType<typeof setTimeout> | null = null;
	let pendingPayload: any = null;
	return function passArgs(...args: any[]) {
		// The referee's veto (tableplace-171), ahead of EVERYTHING this wrapper
		// does. A refused action must not reach the relay, so this cannot sit any
		// later: the send below is the point of no return, and once a peer has the
		// patch there is no un-telling it. Returning here also skips `fn`, so the
		// store never applies it either and no intent is minted. Free when no
		// validator is registered, and memoised per action call, so the store's
		// own check underneath reads the same verdict rather than a second one.
		if (!allowIntent()) return;
		console.log('ws update gamestate: spread args', ...args);
		const metadata = createWsMetaData();
		if (!metadata.playerId || metadata.playerId === '') {
			console.warn('wsWrapperUpdateGameState: No playerId found when creating websocket metadata');
			return fn(...args);
		}

		const [...[rest]] = args;

		// Name the verb behind this patch and send it along WITH the patch
		// (tableplace-169) — a second message would consume the relay's 7/sec
		// budget twice over. It rides inside `value`, which the Go relay carries
		// as an opaque json.RawMessage, so nothing server-side has to learn about
		// it. Minted here rather than left to the store call below so the event
		// exists before the send; the store's own mint then finds it done.
		const intent = mintIntent();
		const payload = {
			...createWsMetaData(),
			value: attachIntents({ ...(rest as GameDTO) }, intent ? [intent] : [])
		};

		// NOTE: This is a hacky way to check if there are any position updates
		// (cards, pieces AND decks — anything draggable must go through the
		// throttle, or pointer-move-rate messages trip the server rate limiter)
		const hasPositionUpdate = [payload.value.cards, payload.value.pieces, payload.value.decks].some(
			(collection) =>
				Object.values(collection || {}).some(
					(item: any) => !!item && Object.keys(item ?? {}).includes('position')
				)
		);
		const now = Date.now();
		const limitMs = 200;
		if (hasPositionUpdate) {
			if (now - lastSentTime >= limitMs) {
				// Leading send
				lastSentTime = now;
				console.log('Position update: sending payload', payload);
				sendMessage(payload);
			} else {
				// Schedule trailing send — MERGE into pending, never replace
				// (replacing dropped every entity between first and last of a burst)
				pendingPayload = pendingPayload
					? { ...payload, value: mergePendingValue(pendingPayload.value, payload.value) }
					: payload;
				const remaining = limitMs - (now - lastSentTime);
				if (!positionTimeout) {
					positionTimeout = setTimeout(() => {
						lastSentTime = Date.now();
						console.log('Position update: sending trailing payload', pendingPayload);
						sendMessage(pendingPayload);
						positionTimeout = null;
						pendingPayload = null;
					}, remaining);
				}
			}
		} else {
			// Flush any queued trailing position send INTO this message instead of
			// letting it fire afterwards: a stale position arriving after a
			// structural update (card → tray/deck) re-creates the entity on remote
			// clients as a position-only ghost with no art.
			if (positionTimeout) {
				clearTimeout(positionTimeout);
				positionTimeout = null;
			}
			const outgoing = pendingPayload
				? { ...payload, value: mergePendingValue(pendingPayload.value, payload.value) }
				: payload;
			if (pendingPayload) lastSentTime = now;
			pendingPayload = null;
			console.log('Immediate (non-position): sending payload', outgoing);
			sendMessage(outgoing);
		}

		return fn(...args);
	};
}

export function initWrappers() {
	const originalFn = gameStore.updateState;
	gameStore.updateState = wsWrapperUpdateGameState(originalFn);
	// `updateStateSilently` is deliberately left alone: it is its own function
	// now (it peels the piggybacked intents off an inbound patch), and pointing
	// it back at the local one would blind every observer to the remote half of
	// the game.
}
