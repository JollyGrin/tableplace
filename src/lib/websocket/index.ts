import { connect, joinLobby, onMessage, sendMessage, type WebSocketMessage } from './connection';
import { gameActions } from '$lib/store/game/actions';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { prewarmGameState } from '$lib/packs/prewarm-state';
import { remoteCameraActions } from '$lib/store/remoteCameraStore.svelte';
import { requestCameraBroadcast } from '$lib/store/cameraStore.svelte';
import { installJournal, journal } from '$lib/journal';
import { installPing, receivePing } from '$lib/ping';
import { createWsMetaData } from '$lib/utils/transforms/websocket';
import toast from 'svelte-french-toast';

/**
 * Initialize websocket connection and join the given lobby
 * @param lobbyId Lobby to join — callers roll one with randomLobbyName() when
 * the URL has no ?lobby, so there is no shared fallback room
 * @returns Promise that resolves when connected and joined
 */
export async function initWebsocket(lobbyId: string, serverUrl?: string): Promise<boolean> {
	// Check if player exists, if not create a player
	const player = gameActions.getMe();
	if (!player) {
		console.log('No player found, creating a new player');
		gameActions.addPlayer();
	}

	try {
		// Connect to the lobby
		const connected = await connect(lobbyId, serverUrl);
		if (!connected) {
			console.error('Failed to connect to websocket server');
			return false;
		}

		// Join the lobby
		const joined = await joinLobby(lobbyId);
		if (!joined) {
			console.error(`Failed to join lobby ${lobbyId}`);
			return false;
		}

		console.log(`Successfully connected and joined lobby ${lobbyId}`);

		// Set up event listeners for incoming messages
		setupMessageHandlers();

		// the action journal (tableplace-201): one ephemeral message per action
		installJournal((entry) =>
			sendMessage({ ...createWsMetaData(), type: 'journal', value: entry })
		);
		// pings (tableplace-198): one ephemeral message per ping, rate-limited
		installPing((value) => sendMessage({ ...createWsMetaData(), type: 'ping', value }));

		// Re-publish my player row now that the socket is open. addPlayer()
		// above ran before connect(), so its patch was dropped (sendMessage has
		// no queue) — without this, peers only ever receive seat/tray/connected
		// patches for this player, and the HUD's ghost-row guard (rows without
		// a joinTimestamp are not players yet) would hide the row forever.
		// Only id + joinTimestamp: re-sending the fresh local row's seat would
		// clobber the seat a reconnecting player already holds in lobby state.
		publishMyPlayerRow();

		// announce our camera to whoever is already here — the ephemeral tier is
		// never replayed, so without this we stay invisible until we orbit
		requestCameraBroadcast();

		return true;
	} catch (error) {
		console.error('Error initializing websocket:', error);
		return false;
	}
}

/**
 * Broadcast the minimal row that marks the local player as a real player in
 * the lobby state. Goes through gameStore.updateState, which storeIntegration
 * wraps to send over the (now open) websocket.
 */
function publishMyPlayerRow(): void {
	const me = gameActions.getMe();
	if (!me?.id) return;
	gameStore.updateState({
		players: { [me.id]: { id: me.id, joinTimestamp: me.joinTimestamp ?? Date.now() } }
	});
}

/**
 * React to #48's presence patches on behalf of the camera avatars.
 *
 * Presence rides the ordinary `update` channel as `players[id].connected`, so
 * there is no connect/disconnect message to hook — this reads the same patch
 * the HUD dots read:
 *  - a peer going `true` is a joiner who missed every camera sample we sent
 *    before they attached (the ephemeral tier is never replayed), so we answer
 *    with one of ours or stay invisible until we next orbit;
 *  - a peer going `false` has really left, so their avatar goes immediately
 *    rather than lingering until the staleness timeout.
 */
function applyPresenceToCameras(value: unknown): void {
	const players = (
		value as { players?: Record<string, { connected?: boolean } | null> } | undefined
	)?.players;
	if (!players) return;

	const myId = gameActions.getMyId();
	let peerCameOnline = false;
	for (const [id, player] of Object.entries(players)) {
		if (!player || id === myId) continue;
		if (player.connected === true) peerCameOnline = true;
		else if (player.connected === false) remoteCameraActions.forget(id);
	}
	if (peerCameOnline) requestCameraBroadcast();
}

/**
 * Set up handlers for different message types
 */
function setupMessageHandlers(): void {
	onMessage((message: WebSocketMessage) => {
		switch (message.type) {
			case 'sync':
				console.log('Received sync message, updating local state', message);
				gameStore.updateStateSilently(message.value);
				// resolve all sheet refs in the synced state, then force one
				// re-render sweep so everything repaints deterministically
				prewarmGameState(message.value, ({ total, failed }) => {
					gameStore.updateStateSilently({});
					toast(
						failed > 0
							? `Card art: ${total - failed}/${total} loaded`
							: `Card art ready (${total})`,
						{ duration: 3000 }
					);
				});
				break;

			case 'update':
				console.log('Received update message', message);
				gameStore.updateStateSilently(message.value);
				prewarmGameState(message.value, () => gameStore.updateStateSilently({}));
				applyPresenceToCameras(message.value);
				// a peer touching something I did last is what refuses my undo
				if (message.playerId) journal.remotePatch(message.value, message.playerId);
				break;

			case 'journal':
				// Ephemeral (SPEC.md §4c), like 'camera': one line in the log,
				// never a patch — the action's own 'update' already carried the change
				if (message.playerId) journal.receive(message.value, message.playerId);
				break;

			case 'ping':
				// Ephemeral too: a ripple for ~1.2s, never a patch
				if (message.playerId) receivePing(message.value, message.playerId);
				break;

			case 'camera':
				// Ephemeral presence (SPEC.md §4c). Deliberately NOT routed through
				// gameStore: any updateState here would echo straight back onto the
				// wire and persist a pose in lobby state.
				// The server already excludes the sender, but guard anyway — a
				// self-echo would draw our own camera in our own face.
				if (message.playerId && message.playerId !== gameActions.getMyId())
					remoteCameraActions.receive(message.playerId, message.value);
				break;

			case 'error':
				console.error('Received error message:', message.value);
				toast('Connection Error:', message.value);
				break;

			default:
				console.warn(`Unknown message type: ${message.type}`);
		}
	});
}

// Export the required functions
export { connect, joinLobby, sendMessage, onMessage };

// Also re-export the WebSocketMessage type
export type { WebSocketMessage };
