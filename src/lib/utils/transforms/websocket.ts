// NOTE: perhaps this should be in a helper file. The playerstore can crash the page if used before instatiated
import { gameActions } from '$lib/store/game/actions';

/**
 * Returns your playerId, timestamp, and type as update
 *
 * Useful to reduce code needed when using sendMessage
 * */
export function createWsMetaData() {
	const playerId = gameActions.getMyId() ?? '';
	if (!playerId)
		console.warn('No playerId found when creating websocket metadata');
	const timestamp = Date.now();
	const type = 'update' as const;
	return { playerId, timestamp, type };
}
