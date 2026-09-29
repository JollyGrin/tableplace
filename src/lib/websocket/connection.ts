import { gameActions } from '$lib/store/game/actions';
import toast from 'svelte-french-toast';

export type WebSocketMessage = {
	// 'connect' is outbound-only: the join handshake sent by joinLobby().
	// Inbound traffic is 'sync' | 'update' | 'error' | 'camera' | 'journal' —
	// presence arrives as an ordinary 'update' merge patch on
	// players[id].connected, while 'camera' and 'journal' are the ephemeral
	// tier (SPEC.md §4c): relayed to peers, never merged into lobby state. Both
	// flow both ways. Old clients log an unknown-type warning and carry on, so
	// either is safe to roll out one-sided.
	type: 'connect' | 'sync' | 'update' | 'error' | 'camera' | 'journal';
	path?: string[];
	value?: any;
	playerId: string;
	timestamp: number;
};

// Config
/** Accepts 'localhost:8080', 'http://localhost:8080/', 'wss://host' etc. → bare host:port */
function normalizeServerHost(url: string): string {
	return url
		.trim()
		.replace(/^(https?|wss?):\/\//, '')
		.replace(/\/+$/, '');
}
// Default to the public lobby server so a first-time visitor gets real
// multiplayer; a non-empty localStorage.serverurl (set in Settings) always wins.
// `||` (not ??) because connectionStore writes '' to localStorage before a
// server is ever set. The host is `lobby.` and not `api.`: `api.table.place` is
// being repurposed as the HTTP lobby-provisioning API, so the websocket relay
// answers at its own name.
const CACHE_SERVER_URL =
	normalizeServerHost(localStorage.getItem('serverurl') ?? '') || 'lobby.table.place';
const SECURITY = CACHE_SERVER_URL.includes('localhost') ? 'ws' : 'wss';
const WS_SERVER_URL = `${SECURITY}://${CACHE_SERVER_URL}/ws`;

// State
let socket: WebSocket | null = null;
let isConnected = false;
let isConnecting = false;
let manualDisconnect = false; // deliberate disconnect() — suppress auto-reconnect
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000; // 2 seconds

// Event callbacks
type MessageCallback = (message: WebSocketMessage) => void;
const messageCallbacks: MessageCallback[] = [];

/**
 * Connect to the websocket server
 * @param lobbyId The lobby ID to connect to
 * @returns Promise that resolves when connected
 */
export async function connect(lobbyId: string, serverUrl?: string): Promise<boolean> {
	if (isConnected) {
		console.log('Already connected to websocket server');
		return true;
	}

	if (isConnecting) {
		console.log('Already attempting to connect to websocket server');
		return false;
	}

	isConnecting = true;
	manualDisconnect = false;
	const player = gameActions.getMe();

	if (!player) {
		console.error('No player found in store');
		isConnecting = false;
		return false;
	}

	const playerId = player.id;
	let wsUrl = `${WS_SERVER_URL}?lobby=${lobbyId}&player=${playerId}`;
	if (serverUrl) {
		const host = normalizeServerHost(serverUrl);
		const security = host.includes('localhost') ? 'ws' : 'wss';
		wsUrl = `${security}://${host}/ws?lobby=${lobbyId}&player=${playerId}`;
	}

	console.log(`Connecting to websocket server at ${wsUrl}`);
	return new Promise((resolve) => {
		try {
			socket = new WebSocket(wsUrl);

			socket.onopen = () => {
				console.log('Connected to websocket server. Reconnection attempts:', reconnectAttempts);
				toast(`Connected to lobby: ${lobbyId}`);
				isConnected = true;
				isConnecting = false;
				reconnectAttempts = 0;
				resolve(true);
			};

			socket.onclose = (event) => {
				const target = serverUrl ?? CACHE_SERVER_URL;
				console.log(
					`Websocket connection closed: ${event.code} ${event.reason} (server: ${target})`
				);
				if (!manualDisconnect) {
					toast(
						`Connection to ${target} closed (${event.code}). Check Settings → Connection → Server.`
					);
				}

				isConnected = false;
				isConnecting = false;

				// Attempt to reconnect (keep the same server, not the cached fallback)
				if (!manualDisconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
					reconnectAttempts++;
					setTimeout(() => {
						console.log(
							`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
						);
						connect(lobbyId, serverUrl);
					}, RECONNECT_DELAY);
				}

				if (!event.wasClean) {
					console.error('Connection closed abnormally');
				}

				resolve(false);
			};

			socket.onerror = (error) => {
				console.error('Websocket error:', error);
				isConnecting = false;
				resolve(false);
			};

			socket.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data) as WebSocketMessage;
					handleMessage(message);
				} catch (error) {
					console.error('Error parsing message:', error);
				}
			};
		} catch (error) {
			console.error('Error connecting to websocket server:', error);
			isConnecting = false;
			resolve(false);
		}
	});
}

/**
 * Join a lobby as the current player
 * @param lobbyId Lobby ID to join
 * @returns Promise that resolves when joined
 */
export async function joinLobby(lobbyId: string): Promise<boolean> {
	// First ensure we're connected
	if (!isConnected) {
		const connected = await connect(lobbyId);
		if (!connected) return false;
	}

	const playerId = gameActions.getMyId();
	if (!playerId) {
		console.error('No player found in store');
		return false;
	}

	// Send join message
	const joinMessage: WebSocketMessage = {
		type: 'connect',
		playerId: playerId,
		timestamp: Date.now()
	};

	return sendMessage(joinMessage);
}

/**
 * Send a message to the websocket server
 * @param message Message to send
 * @returns True if sent successfully
 */
export function sendMessage(message: WebSocketMessage): boolean {
	// A warning, not an error: patches made before the socket opens are dropped
	// BY DESIGN (there is no send queue) and initWebsocket re-publishes the row
	// that matters once it is up. Logging it as an error meant a healthy first
	// load always had a red console, which is exactly the noise that let #102's
	// real error hide in plain sight.
	if (!socket) {
		console.warn('Dropped a message: the websocket is not open yet');
		return false;
	}
	if (!isConnected) {
		console.warn('Dropped a message: not connected to the websocket server');
		return false;
	}

	try {
		socket.send(JSON.stringify(message));
		return true;
	} catch (error) {
		console.error('Error sending message:', error);
		return false;
	}
}

/**
 * Register a callback to be called when a message is received
 * @param callback Function to call with the received message
 */
export function onMessage(callback: MessageCallback): void {
	messageCallbacks.push(callback);
}

/**
 * Handle incoming messages
 * @param message Message received from the server
 */
function handleMessage(message: WebSocketMessage): void {
	// Log the message — except the ephemeral camera stream, which arrives
	// several times a second per peer and would bury everything else
	if (message.type !== 'camera') console.log('Received message:', message);

	// Call all registered callbacks
	messageCallbacks.forEach((callback) => {
		try {
			callback(message);
		} catch (error) {
			console.error('Error in message callback:', error);
		}
	});
}

/**
 * Disconnect from the websocket server
 */
export function disconnect(): void {
	manualDisconnect = true;
	if (socket) {
		socket.close();
		socket = null;
	}
	isConnected = false;
	isConnecting = false;
}

/**
 * Check if connected to the websocket server
 * @returns True if connected
 */
export function isWebSocketConnected(): boolean {
	return isConnected;
}
