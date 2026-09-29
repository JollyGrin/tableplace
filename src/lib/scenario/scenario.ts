/**
 * Scenario presets: save a fully arranged table (both seats' decks, map
 * overlay, pieces) to localStorage, then seed a live lobby with it so a
 * shared lobby can start playing immediately.
 *
 * Scenarios are seat-relative. In the /setup editor, entities are owned by
 * placeholder players (`seat0`, `seat1`, …) — entity ids are `kind:owner:slug`.
 * When a real player claims a seat in a lobby, every entity id containing that
 * placeholder owner is renamed to the claimer's id, and the placeholder's
 * seat + tray move onto the claiming player.
 */

import { get } from 'svelte/store';
import { gameStore } from '$lib/store/game/gameStore.svelte';
import { gameActions } from '$lib/store/game/actions';
import { snapPointIds } from '$lib/store/game/actions/snap';
import { prewarmGameState } from '$lib/packs/prewarm-state';
import { packSource } from '$lib/packs/spawn';
import {
	composePlayers,
	composeScenario,
	composeSnapPoints,
	isSeatPlaceholder,
	placedCount,
	seatPlaceholderId
} from '$lib/compose/scenario';
import type { DeckDTO, GameDTO, OverlayDTO, PackOrigin, PieceDTO } from '$lib/store/game/types';
import {
	parseScenarioFile,
	serializeScenarioFile,
	scenarioFileName,
	scenarioVersion,
	type PackPlacement,
	type PackRef,
	type Scenario,
	type SnapPoint
} from './file';
import { resolvePacks } from './resolve-packs';

const STORAGE_KEY = 'scenarios:v1';

export type SeatIndex = 0 | 1 | 2 | 3;
type StateUpdate = Parameters<typeof gameStore.updateState>[0];

// the seat-placeholder grammar itself lives with the composer, since composing
// a table headlessly is the other thing that has to agree about it
export { isSeatPlaceholder, seatPlaceholderId };

export type { Scenario };

function readAll(): Record<string, Scenario> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
	} catch {
		return {};
	}
}

function writeAll(all: Record<string, Scenario>) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function listScenarios(): Scenario[] {
	return Object.values(readAll()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getScenario(name: string): Scenario | undefined {
	return readAll()[name];
}

export function deleteScenario(name: string) {
	const all = readAll();
	delete all[name];
	writeAll(all);
}

/** owner segment of a `kind:owner:slug` id */
function ownerOf(id: string): string | undefined {
	return id.split(':')[1];
}

function seatOf(id: string): SeatIndex | undefined {
	const owner = ownerOf(id);
	return owner && isSeatPlaceholder(owner) ? (Number(owner.slice(4)) as SeatIndex) : undefined;
}

/**
 * Card ids are `card:<owner>:<slot>-<code>` (see spawnPackDeck), so the pack
 * card code is what's left after the deck's prefix.
 */
function cardCode(cardId: string, owner: string, slot: string): string | undefined {
	const prefix = `card:${owner}:${slot}-`;
	return cardId.startsWith(prefix) ? cardId.slice(prefix.length) : undefined;
}

/**
 * Turn one pack-spawned entity into a placement, or return undefined to leave
 * it in raw `state`. Only placeholder-owned content becomes a placement: a
 * real player's entities can't be expressed seat-relatively, and table-scoped
 * overlays carry no seat at all.
 */
function toPlacement(
	kind: PackPlacement['kind'],
	id: string,
	entity: { packOrigin?: PackOrigin } & Record<string, unknown>
): PackPlacement | undefined {
	const packOrigin = entity.packOrigin;
	if (!packOrigin) return undefined;
	const seat = seatOf(id);
	if (kind !== 'overlay' && seat === undefined) return undefined;

	const placement: PackPlacement = {
		kind,
		pack: packOrigin.pack,
		content: packOrigin.content,
		...(seat !== undefined ? { seat } : {})
	};
	if (entity.position) placement.position = entity.position as [number, number, number];
	if (entity.rotation) placement.rotation = entity.rotation as [number, number, number];
	// pinned is authoring intent for any kind (a board laid down locked)
	if (entity.locked) placement.locked = true;

	if (kind === 'deck') {
		const deck = entity as unknown as Partial<DeckDTO>;
		placement.isFaceUp = deck.isFaceUp ?? false;
		// the authored order, as pack card codes — ids only, never card bodies
		const owner = ownerOf(id) as string;
		const order = (deck.cards ?? []).map((card) => cardCode(card.id, owner, packOrigin.content));
		if (order.every((code) => code !== undefined)) placement.order = order as string[];
		if (deck.shuffleOnLoad) placement.shuffleOnLoad = true;
	}
	if (kind === 'piece') {
		const piece = entity as unknown as Partial<PieceDTO>;
		if (piece.value !== undefined) placement.value = piece.value;
		// the face it was left showing is authoring intent, like a counter's value
		if (piece.state) placement.state = piece.state;
	}
	if (kind === 'overlay') {
		const overlay = entity as unknown as Partial<OverlayDTO>;
		if (overlay.scale !== undefined) placement.scale = overlay.scale;
	}
	return placement;
}

/**
 * Snap points live in the store keyed by id, but a file keeps them as a stable
 * array, which reads far better in a hand-edited scenario. Sorted by id so an
 * export is deterministic, and dropped from `state` — the top-level
 * `snapPoints` field is their only home in the file.
 *
 * The one thing that references a point is another point's `links`, and a
 * file names a point by its index (`snap:<n>`, what `composeSnapPoints` gives
 * it back on load). So links are renumbered to the exported order, and a link
 * whose target isn't exported is dropped — left as it was, a deleted point's
 * old id could alias whichever point takes its index.
 */
function collectSnapPoints(s: Partial<GameDTO> | undefined | null): SnapPoint[] {
	const kept = snapPointIds(s ?? undefined).filter((id) => s?.snapPoints?.[id]?.position);
	const renumbered = new Map(kept.map((id, index) => [id, `snap:${index}`]));
	return kept.map((id) => {
		const point = s!.snapPoints![id]!;
		const position = point.position!;
		const snap: SnapPoint = { position: [position[0], position[1]] };
		if (point.y !== undefined) snap.y = point.y;
		if (point.rotation !== undefined) snap.rotation = point.rotation;
		if (point.radius !== undefined) snap.radius = point.radius;
		if (point.kind === 'grid') {
			snap.kind = 'grid';
			if (point.pitch !== undefined) snap.pitch = point.pitch;
			if (point.cols !== undefined) snap.cols = point.cols;
			if (point.rows !== undefined) snap.rows = point.rows;
			if (point.yawStep !== undefined) snap.yawStep = point.yawStep;
		}
		const links = (point.links ?? []).flatMap((link) => {
			const target = renumbered.get(link);
			return target && target !== renumbered.get(id) ? [target] : [];
		});
		if (links.length) snap.links = [...new Set(links)];
		if (point.tags?.length) snap.tags = [...point.tags];
		return snap;
	});
}

/**
 * Snapshot the current table as a scenario. Real players (and their trays)
 * are NOT saved — only placeholder seat players survive, so the preset stays
 * portable to any future lobby.
 *
 * Content that came from a pack is emitted as a pack ref + placement (tbps v2)
 * rather than inlined, so the pack stays the single source of truth for what
 * cards *are* and the scenario only says where they go. Hand-placed content —
 * TTS imports, ad-hoc pieces, cards drawn onto the table — falls back to a raw
 * `state` snapshot, exactly as v1 did.
 */
export function saveScenario(name: string): Scenario {
	const s = get(gameStore);
	const players: GameDTO['players'] = {};
	for (const [id, player] of Object.entries(s?.players ?? {})) {
		if (isSeatPlaceholder(id)) players[id] = player as GameDTO['players'][string];
	}

	const placements: PackPlacement[] = [];
	const refs = new Map<string, PackRef>();
	const state: Partial<GameDTO> = {
		cards: portableCards(s?.cards),
		decks: {},
		pieces: {},
		overlays: {},
		players
	};

	for (const [kind, collection] of [
		['deck', 'decks'],
		['piece', 'pieces'],
		['overlay', 'overlays']
	] as const) {
		for (const [id, entity] of Object.entries(s?.[collection] ?? {})) {
			const placement = entity
				? toPlacement(kind, id, entity as Parameters<typeof toPlacement>[2])
				: undefined;
			if (!placement) {
				// not pack-derived (or not seat-relative) — keep the raw snapshot
				(state[collection] as Record<string, unknown>)[id] = entity;
				continue;
			}
			placements.push(placement);
			const origin = (entity as { packOrigin: PackOrigin }).packOrigin;
			if (!refs.has(origin.pack)) {
				refs.set(origin.pack, {
					id: origin.pack,
					...(origin.source ? { source: origin.source } : {})
				});
			}
		}
	}

	const snapPoints = collectSnapPoints(s);
	const scenario: Scenario = {
		name,
		createdAt: Date.now(),
		state,
		...(placements.length ? { packs: [...refs.values()], placements } : {}),
		...(snapPoints.length ? { snapPoints } : {})
	};
	const all = readAll();
	all[name] = scenario;
	writeAll(all);
	return scenario;
}

/**
 * A peek mark (`placedBy`, tableplace-193) is kept only when it names a seat
 * placeholder — a real player's id means nothing in the next lobby, the same
 * reason real players themselves are not saved.
 */
function portableCards(cards: GameDTO['cards'] | undefined): GameDTO['cards'] {
	const out: GameDTO['cards'] = {};
	for (const [id, card] of Object.entries(cards ?? {})) {
		if (card?.placedBy && !isSeatPlaceholder(card.placedBy)) {
			const { placedBy: _placedBy, ...rest } = card;
			out[id] = rest;
		} else out[id] = card;
	}
	return out;
}

/** Placeholder players hold a seat's tray + seat index until a real player claims them. */
export function ensureSeatPlaceholder(seat: SeatIndex) {
	const id = seatPlaceholderId(seat);
	if (get(gameStore)?.players?.[id]) return;
	gameStore.updateState({
		players: { [id]: { id, seat, joinTimestamp: 0, tray: {}, metadata: {} } }
	});
}

/** nulls for everything currently on the table (real players survive) */
function clearUpdate(): Record<string, Record<string, unknown>> {
	const current = get(gameStore);
	const update: Record<string, Record<string, unknown>> = {
		cards: {},
		decks: {},
		pieces: {},
		overlays: {},
		snapPoints: {},
		players: {}
	};
	for (const collection of ['cards', 'decks', 'pieces', 'overlays', 'snapPoints'] as const) {
		for (const key of Object.keys(current?.[collection] ?? {})) update[collection][key] = null;
	}
	for (const key of Object.keys(current?.players ?? {})) {
		if (isSeatPlaceholder(key)) update.players[key] = null;
	}
	return update;
}

/**
 * Write a composed table into the store.
 *
 * Everything but the decks rides one patch — `base` lets a caller send the
 * clear along with it, so a legacy load still lands in a single message the
 * way it always did. Each deck then goes in its own: decks carry full card
 * lists, and one all-in-one update can blow past the server's websocket read
 * limit (server/lobby/server.go), after which the server silently drops the
 * whole seed and joiners sync stale state.
 */
function applyComposed(
	composed: Partial<GameDTO>,
	base: Record<string, Record<string, unknown>> = {}
) {
	const update: Record<string, Record<string, unknown>> = {
		cards: {},
		pieces: {},
		overlays: {},
		snapPoints: {},
		players: {},
		...base
	};
	for (const collection of ['cards', 'pieces', 'overlays', 'snapPoints', 'players'] as const) {
		Object.assign(update[collection], composed[collection] ?? {});
	}
	gameStore.updateState(update as StateUpdate);
	for (const [key, value] of Object.entries(composed.decks ?? {})) {
		gameStore.updateState({ decks: { [key]: value } } as StateUpdate);
	}
}

export type ApplyReport = {
	version: 1 | 2;
	placed: number;
	/** packs that could not be resolved — their placements were skipped */
	failedPacks: { id: string; reason: string }[];
};

/**
 * Replace the table contents with a scenario. Goes through updateState, so on
 * /play (ws-wrapped) it broadcasts to the whole lobby. Real player entries are
 * kept. Sheet refs are prewarmed locally, then a re-render sweep repaints.
 *
 * A thin wrapper over `compose/scenario.ts`: resolve the pack refs, compose
 * the table, push it. Everything about *what* the table is — entity ids, seat
 * placeholders, card order, `packOrigin` stamps — lives in the composer, which
 * is why a bun script can lay out the same table without a browser
 * (`scripts/seed-lobby.ts`).
 *
 * v1/v0 files compose too: with no placements the composition is just their
 * `state` snapshot, so they still apply synchronously in one tick as they
 * always did. Never rejects — an un-awaited call (the /play seed button) can't
 * produce an unhandled rejection; resolution failures come back in the report.
 */
export async function applyScenario(scenario: Scenario): Promise<ApplyReport> {
	if (scenarioVersion(scenario) === 1) {
		applyComposed(composeScenario(scenario, new Map()), clearUpdate());
		prewarmGameState(scenario.state, () => gameStore.updateStateSilently({}));
		return { version: 1, placed: 0, failedPacks: [] };
	}

	// clear, and seat the placeholders the placements need, before any await:
	// the table must not sit on the old scenario while packs are being fetched,
	// and a `?seat=N` joiner can start waiting on its placeholder immediately
	const update = clearUpdate();
	Object.assign(update.players, composePlayers(scenario));
	// snap points are pure data — they ride with the clear, no pack to resolve
	Object.assign(update.snapPoints, composeSnapPoints(scenario.snapPoints));
	gameStore.updateState(update as StateUpdate);

	const { packs, failed } = await resolvePacks(scenario.packs ?? []);
	for (const { ref, reason } of failed) {
		console.error(`[scenario] could not resolve pack '${ref.id}': ${reason}`);
	}

	applyComposed(
		composeScenario(scenario, packs, {
			// the browser knows one thing the composer's default doesn't: which
			// packs live in this device's library, and so re-resolve as 'local'
			sourceOf: (ref, pack) => packSource(pack, ref.source),
			// one shuffle implementation on the client, wherever it is called from
			shuffleWith: (cards) => gameActions.shuffleCards(cards)
		})
	);

	// pack content only exists in the store now, so prewarm the result
	prewarmGameState(get(gameStore), () => gameStore.updateStateSilently({}));
	return {
		version: 2,
		placed: placedCount(scenario, packs),
		failedPacks: failed.map(({ ref, reason }) => ({ id: ref.id, reason }))
	};
}

/** ids are `kind:owner:slug` — swap the owner segment */
function renameOwner(key: string, from: string, to: string): string {
	return key
		.split(':')
		.map((part) => (part === from ? to : part))
		.join(':');
}

/**
 * Claim a placeholder seat as the local player: the seat index + tray move
 * onto my player, and every entity owned by the placeholder is renamed to my
 * id so ownership-based UI (deck panes) follows. No-op if already claimed.
 */
export function claimSeat(seat: SeatIndex): boolean {
	const myId = gameActions.getMyId();
	if (!myId) return false;
	const placeholder = seatPlaceholderId(seat);
	const s = get(gameStore);
	const ph = s?.players?.[placeholder];
	if (!ph) return false;

	// decks first, one message each — full card lists must stay under the
	// server's websocket read limit
	for (const [key, value] of Object.entries(s?.decks ?? {})) {
		if (!key.includes(`:${placeholder}:`)) continue;
		const newKey = renameOwner(key, placeholder, myId);
		gameStore.updateState({
			decks: { [key]: null, [newKey]: { ...(value as object), id: newKey } }
		} as StateUpdate);
	}
	const update: Record<string, Record<string, unknown>> = { players: {}, cards: {}, pieces: {} };
	for (const collection of ['cards', 'pieces'] as const) {
		for (const [key, value] of Object.entries(s?.[collection] ?? {})) {
			if (!key.includes(`:${placeholder}:`)) continue;
			update[collection][renameOwner(key, placeholder, myId)] = value;
			update[collection][key] = null;
		}
	}
	// a card the seat laid face-down is mine to peek at now (tableplace-193),
	// wherever it lies and whoever's id it carries
	for (const [key, card] of Object.entries(s?.cards ?? {})) {
		if (card?.placedBy !== placeholder) continue;
		const target = key.includes(`:${placeholder}:`) ? renameOwner(key, placeholder, myId) : key;
		update.cards[target] = { ...(update.cards[target] as object), placedBy: myId };
	}
	update.players[placeholder] = null;
	update.players[myId] = { seat, tray: ph?.tray ?? {} };
	gameStore.updateState(update as StateUpdate);
	return true;
}

export function exportScenarioToFile(scenario: Scenario) {
	const blob = new Blob([serializeScenarioFile(scenario)], { type: 'application/json' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = scenarioFileName(scenario.name);
	a.click();
	URL.revokeObjectURL(a.href);
}

/**
 * Parse a scenario file (`.tbps.json`, or a legacy `scenario-*.json`) and
 * store it. Returns the saved scenario.
 */
export function importScenarioFromText(text: string): Scenario {
	const scenario = parseScenarioFile(text);
	const all = readAll();
	all[scenario.name] = scenario;
	writeAll(all);
	return scenario;
}
