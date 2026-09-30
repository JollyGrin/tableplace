/**
 * What the harness checks.
 *
 * Every spec has the same spine, because #102 does: put something new on the
 * table, then confirm that *everything else* still answers the pointer and that
 * nothing new mounts broken. The shared `interactivity()` context (#86) means
 * one entity that throws during raycast takes dispatch down for the whole
 * table — and a Svelte effect that reads state it also writes is worse still,
 * because the runtime teardown stops every later component mounting at all.
 * So "the deck still drags" is the assertion that catches a broken die.
 *
 * Positions matter. Anything the specs click has to draw clear of the HUD
 * panes; `dragBy` fails loudly if it doesn't, because a pane over the target
 * looks identical to a frozen table.
 */

import type { Browser } from 'puppeteer-core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ok, planarDistance } from './assert';
import type { Servers } from './servers';
import { PIECE_REST_Y, PIECE_THICKNESS } from '../src/lib/utils/constants-pieces';
import {
	TABLE_HALF_X,
	TABLE_HALF_Z,
	TABLE_RIM_RISE,
	TABLE_RIM_WIDTH,
	TABLE_TOP_Y
} from '../src/lib/utils/constants-table';
import { openTable, type Table } from './table';

export type Spec = {
	name: string;
	run: (context: { browser: Browser; servers: Servers }) => Promise<void>;
};

/**
 * A clear lane of felt, left-to-right, below the Settings pane and above the
 * bottom edge. Everything a spec drags lives here and is dragged straight down
 * into empty table.
 */
const LANE = (slot: number): [number, number, number] => [-4 + slot * 4, 0.16, 1];
const DRAG = { dx: 0, dy: 150 };
/**
 * The same lane at a flat piece's rest height. `LANE`'s y sinks a token's disc
 * below the felt — harmless for a spec that only raycasts and drags it, fatal
 * for one that looks at what it draws.
 */
const ON_FELT = (slot: number): [number, number, number] => [LANE(slot)[0], PIECE_REST_Y, 1];

let lobbySeq = 0;
/** a fresh lobby per spec, so nothing leaks between them through the relay */
function nextLobby(name: string): string {
	return `e2e-${name.replace(/[^a-z0-9]+/gi, '-')}-${process.pid}-${lobbySeq++}`;
}

/**
 * Poll a probe until its answer satisfies `holds`, then return that answer —
 * or return the last answer when time runs out, so the caller's own `ok(...)`
 * still reports the real observed state.
 *
 * For spring-animated state the harness can only watch (a tap turning a card,
 * a rotate turning a model): a fixed settle races the CI runner's frame rate,
 * and a shared runner under load has lost that race in two different specs.
 * The assertion is about the FINAL state, so waiting for it — bounded — is
 * what the spec actually means.
 */
async function eventually<T>(
	probe: () => Promise<T>,
	holds: (value: T) => boolean,
	timeoutMs = 8000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last = await probe();
	while (!holds(last) && Date.now() < deadline) {
		await sleep(300);
		last = await probe();
	}
	return last;
}

/** in-page: how many cards the local player holds (the tray is keyed by card id) */
function handSize(): number {
	const bridge = window.__tableplace!;
	const me = bridge.actions.getMyId();
	return Object.keys((me && bridge.state()?.players?.[me]?.tray) ?? {}).length;
}

/**
 * Walk the pointer from wherever it is to `to`, the way a hand flicks toward a
 * wedge: several moves, so the wheel's highlight tracks and the entities under
 * the path get their hover events — a single jump would test a gesture nobody
 * makes. The button is left DOWN; the caller's release is what decides.
 */
async function flickTo(table: Table, to: { x: number; y: number }): Promise<void> {
	await table.page.mouse.move(to.x, to.y, { steps: 10 });
	await sleep(200); // the highlight, and any hover the path crossed, land first
}

/**
 * Called with `what just happened`. The runtime-teardown case is named
 * separately because it is the failure #102 actually was, and because its
 * signature — `effect_update_depth_exceeded` — is worth reading in the report
 * rather than being one line of a console dump.
 */
/**
 * Wait until a camera move has landed: the pose reads the same across three
 * animation frames (and a beat). A preset move is tweened, and on a
 * software-rendered runner a frame can take a third of a second, so neither a
 * fixed sleep nor two reads a fixed time apart is the right length.
 */
async function settleCamera(table: Table, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const frames = () =>
		table.page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					let n = 0;
					const tick = () => (++n >= 3 ? setTimeout(resolve, 150) : requestAnimationFrame(tick));
					requestAnimationFrame(tick);
				})
		);
	let last = JSON.stringify(await table.cameraPose());
	while (Date.now() < deadline) {
		await frames();
		const now = JSON.stringify(await table.cameraPose());
		if (now === last) return;
		last = now;
	}
}

function assertClean(table: Table, when: string): void {
	const problems = table.appProblems();
	const teardown = problems.find((problem) => /effect_update_depth_exceeded/.test(problem.text));
	ok(
		!teardown,
		`the Svelte runtime tore itself down ${when} — every effect on the page is dead, ` +
			`so nothing further mounts and nothing answers the pointer:\n  ${teardown?.text.split('\n').slice(0, 4).join('\n  ')}`
	);
	ok(
		problems.length === 0,
		`console was not clean ${when}:\n${problems.map((p) => `  [${p.kind}] ${p.text}`).join('\n')}`
	);
}

/** the load-bearing check: pick the entity up with a real mouse and see it move */
async function assertDraggable(
	table: Table,
	id: string,
	label: string,
	drag: { dx: number; dy: number } = DRAG
): Promise<void> {
	const before = await table.positionOf(id);
	ok(before, `${label} (${id}) has no position to start from`);
	const point = await table.locate(id);
	ok(point, `${label} (${id}) never mounted into the scene — nothing to click`);

	// what dispatch would see: the entity has to be the thing under its own
	// pixel, not merely *something*. A table that has stopped updating still
	// answers with felt.
	const hits = await table.hits(point!);
	ok(
		hits.includes(id),
		`the raycaster does not reach ${label} (${id}) at its own screen position — it hits ${
			hits.length ? hits.join(', ') : 'nothing at all'
		}`
	);

	await table.dragBy(id, drag.dx, drag.dy);
	const after = await table.positionOf(id);
	ok(
		planarDistance(before, after) > 0.5,
		`${label} (${id}) did not move: ${JSON.stringify(before)} → ${JSON.stringify(after)}`
	);
}

/** "renders white" was never a material fault — it was nothing mounting at all */
async function assertRenders(table: Table, id: string, label: string): Promise<void> {
	const shape = await table.describe(id);
	ok(shape, `${label} (${id}) is in the store but has no object in the scene — it never mounted`);
	ok(shape!.meshes > 0, `${label} (${id}) mounted an empty group — no meshes to draw`);
}

/**
 * A second player that is only a relay client: joins the lobby over a bare
 * WebSocket, keeps the lobby state the relay sends it (the same RFC-7386-style
 * merge the app does: `null` deletes), and can publish patches of its own.
 * What a remote player's HUD is drawn from, without a second rendering page.
 */
type Json = Record<string, unknown>;
/** the slice of lobby state the specs read off a peer */
type PeerState = {
	decks?: Record<string, { cards?: unknown[]; shuffledAt?: number }>;
	players?: Record<string, { tray?: Json }>;
};
type Peer = { state: PeerState; send: (value: object) => void; close: () => void };

const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function mergePatch(target: Json, patch: Json): Json {
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value === null) delete target[key];
		else if (isRecord(value))
			target[key] = mergePatch(isRecord(target[key]) ? target[key] : {}, value);
		else target[key] = value;
	}
	return target;
}

async function relayPeer(relay: string, lobby: string, playerId: string): Promise<Peer> {
	const url = `ws://${relay}/ws?lobby=${encodeURIComponent(lobby)}&player=${encodeURIComponent(playerId)}`;
	const socket = new WebSocket(url);
	const peer: Peer = {
		state: {},
		send: (value) =>
			socket.send(JSON.stringify({ type: 'update', playerId, timestamp: Date.now(), value })),
		close: () => socket.close()
	};
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(String(event.data));
		if (message.type === 'sync') peer.state = mergePatch({}, message.value ?? {}) as PeerState;
		if (message.type === 'update') mergePatch(peer.state as Json, message.value ?? {});
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error(`relay peer could not reach ${url}`)), {
			once: true
		});
	});
	socket.send(JSON.stringify({ type: 'connect', playerId, timestamp: Date.now() }));
	return peer;
}

async function withTable(
	context: { browser: Browser; servers: Servers },
	name: string,
	body: (table: Table) => Promise<void>
): Promise<void> {
	const table = await openTable(context.browser, context.servers, nextLobby(name));
	try {
		await body(table);
	} finally {
		await table.close();
	}
}

export const SPECS: Spec[] = [
	{
		// the control. If this fails, the harness is broken, not the app.
		name: 'deck alone: drags, console clean',
		run: (context) =>
			withTable(context, 'deck-alone', async (table) => {
				const deck = await table.seedDeck();
				await table.settle();
				await assertRenders(table, deck, 'deck');
				await assertDraggable(table, deck, 'deck');
				assertClean(table, 'with a deck alone on the table');
				await table.snap('deck-alone');
			})
	},
	{
		name: 'freeze: a die does not break the deck',
		run: (context) =>
			withTable(context, 'die', async (table) => {
				const deck = await table.seedDeck();
				const die = await table.spawn('die', { sides: 20, position: LANE(0) });
				await table.settle(1200);
				assertClean(table, 'immediately after spawning a d20');
				await assertRenders(table, die, 'the d20');
				await assertDraggable(table, deck, 'deck (with a d20 on the table)');
				await assertDraggable(table, die, 'the d20 itself');
				assertClean(table, 'after dragging with a d20 on the table');
				await table.snap('die');
			})
	},
	{
		name: 'freeze: every die shape is harmless',
		run: (context) =>
			withTable(context, 'die-shapes', async (table) => {
				const deck = await table.seedDeck();
				const shapes = [4, 6, 8, 10, 12, 20];
				const dice: string[] = [];
				for (const [index, sides] of shapes.entries()) {
					dice.push(await table.spawn('die', { sides, position: [-9 + index * 3, 0.16, -3] }));
				}
				await table.settle(1500);
				assertClean(table, 'with one die of every shape on the table');
				for (const [index, id] of dice.entries()) {
					await assertRenders(table, id, `the d${shapes[index]}`);
				}
				await assertDraggable(table, deck, 'deck (with d4…d20 on the table)');
				await table.snap('die-shapes');
			})
	},
	{
		name: 'freeze: a bag does not break the deck',
		run: (context) =>
			withTable(context, 'bag', async (table) => {
				const deck = await table.seedDeck();
				const bag = await table.spawn('bag', { position: LANE(0) });
				await table.settle(1200);
				assertClean(table, 'immediately after spawning a bag');
				await assertRenders(table, bag, 'the bag');
				await assertDraggable(table, deck, 'deck (with a bag on the table)');
				await assertDraggable(table, bag, 'the bag itself');
				assertClean(table, 'after dragging with a bag on the table');
				await table.snap('bag');
			})
	},
	{
		/**
		 * The reported "spawn a pack, it's just white". It was never a material
		 * fault: the die had already torn the runtime down, so the deck landed in
		 * the store and no component ever mounted for it. Spawning the pack
		 * *after* the die is what makes this spec name the symptom.
		 */
		name: 'white pack: a deck spawned after a die still mounts and textures',
		run: (context) =>
			withTable(context, 'white-pack', async (table) => {
				const die = await table.spawn('die', { sides: 6, position: LANE(0) });
				await table.settle(1200);
				assertClean(table, 'after spawning a d6 on an empty table');

				const deck = await table.seedDeck();
				await table.settle(1500);
				await assertRenders(table, deck, 'a deck spawned after a die');

				const shape = await table.describe(deck);
				ok(
					shape!.materials.some((material) => (material as { hasMap: boolean }).hasMap),
					`the deck mounted but every material is untextured — this is what "renders white" looks like: ${JSON.stringify(shape!.materials)}`
				);
				await assertDraggable(table, deck, 'a deck spawned after a die');
				await assertRenders(table, die, 'the d6');
				assertClean(table, 'with a pack spawned after a die');
				await table.snap('white-pack');
			})
	},
	{
		/**
		 * tableplace-132: a landscape card's quarter turn is applied by the
		 * renderer alone. The store cannot answer "which way does it draw", so
		 * this reads the rendered bounding box — wider than deep means sideways —
		 * and checks the synced rotation stayed orientation-relative underneath.
		 */
		name: 'landscape card: draws sideways, taps upright, still drags',
		run: (context) =>
			withTable(context, 'landscape', async (table) => {
				// a two-card all-landscape deck, positioned clear of the HUD panes
				const deck = await table.page.evaluate(() => {
					const cards = ['AS', 'KH'].map((code) => ({
						id: `card:std:site-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back',
						orientation: 'landscape'
					}));
					return String(
						window.__tableplace!.actions.addDeck({ cards, position: [-2, 0.4, -2] } as never) ?? ''
					);
				});
				await table.settle(1000);

				const cardId = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					deck
				);
				ok(!!cardId, 'nothing came off the top of the deck');
				await table.settle(1500); // let the draw/flip springs finish
				await assertRenders(table, cardId, 'the landscape card');

				// sideways on the felt: footprint wider (x) than deep (z), once the
				// draw/flip springs finish — polled, not raced (see eventually)
				const drawn = await eventually(
					() => table.describe(cardId),
					(shape) => !!shape && shape.size[0] > shape.size[2]
				);
				ok(
					drawn!.size[0] > drawn!.size[2],
					`the landscape card draws portrait: footprint ${JSON.stringify(drawn!.size)}`
				);
				// …and the quarter turn never leaked into the synced rotation
				const stored = await table.page.evaluate(
					(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
					cardId
				);
				ok(
					Math.abs(stored?.[2] ?? NaN) % 180 === 0,
					`the 90° was baked into synced state: rotation ${JSON.stringify(stored)}`
				);

				// tap stands it upright — orientation-relative, exactly like a
				// portrait card lies down. Polled: a loaded CI runner has caught this
				// mid-turn (a near-square footprint) with a fixed settle.
				await table.page.evaluate((id) => window.__tableplace!.actions.tapCard(false, id), cardId);
				const tapped = await eventually(
					() => table.describe(cardId),
					(shape) => !!shape && shape.size[2] > shape.size[0]
				);
				ok(
					tapped!.size[2] > tapped!.size[0],
					`tapping did not stand the landscape card upright: footprint ${JSON.stringify(tapped!.size)}`
				);

				await assertDraggable(table, cardId, 'the landscape card');
				await assertDraggable(table, deck, 'deck (with a landscape card out)');
				assertClean(table, 'with a landscape card on the table');
				await table.snap('landscape');
			})
	},
	{
		/**
		 * Snap grids (tableplace-134) under a real mouse: a token and a whole
		 * deck released over a 3×3 grid must land on cell centres — the exact
		 * transform the resolver promises — and the rest of the table must
		 * still answer the pointer afterwards (a broken grid entry in the
		 * shared snapPoints record would poison every drop on the table).
		 */
		name: 'snap grid: a token and a deck land on cell centres',
		run: (context) =>
			withTable(context, 'snap-grid', async (table) => {
				const deck = await table.seedDeck();
				const token = await table.spawn('token', { position: LANE(0) });
				// grid centred at [6, 1], pitch 2, 3×3 → cells x ∈ {4,6,8}, z ∈ {-1,1,3}
				await table.page.evaluate(() =>
					window.__tableplace!.actions.addSnapPoint({
						position: [6, 1],
						kind: 'grid',
						pitch: 2,
						cols: 3,
						rows: 3
					})
				);
				await table.settle();

				// released inside the middle cell but off its centre: the landing
				// must be the centre, not the pointer
				await table.dragTo(token, 5.4, 0.6);
				const tokenPos = await table.positionOf(token);
				ok(tokenPos, `the token has no position after the drop`);
				ok(
					Math.abs(tokenPos![0] - 6) < 0.01 && Math.abs(tokenPos![2] - 1) < 0.01,
					`the token did not land on the cell centre [6, 1]: ${JSON.stringify(tokenPos)}`
				);

				// a whole deck snaps too, released nearest the [8, 1] cell
				await table.dragTo(deck, 7.6, 0.8);
				const deckPos = await table.positionOf(deck);
				ok(deckPos, `the deck has no position after the drop`);
				ok(
					Math.abs(deckPos![0] - 8) < 0.01 && Math.abs(deckPos![2] - 1) < 0.01,
					`the deck did not land on the cell centre [8, 1]: ${JSON.stringify(deckPos)}`
				);

				// the grid must not have cost the table its raycast: everything
				// still lifts and drags (single shared interactivity() — #86)
				await assertDraggable(table, deck, 'deck (after grid snapping)');
				await assertDraggable(table, token, 'the token (after grid snapping)');
				assertClean(table, 'after snapping onto a grid');
				await table.snap('snap-grid');
			})
	},
	{
		/**
		 * tableplace-188: while something that snaps is lifted, every snap point
		 * rings, a grid shows only the cells near the pointer, the point that
		 * will catch the drop is filled, Alt hides it all — and every bit of it
		 * is gone once the entity lands, exactly where the fill promised.
		 *
		 * Read two ways: structurally off the rendered guide objects (the
		 * bridge's `snapGuides`), and as pixels, because a ring that "is
		 * visible" to three.js but draws nothing is the failure a structural
		 * probe can't see. 33 discrete points + a grid, so the instanced path
		 * is what's under test.
		 */
		name: 'snap guides: rings light up on lift, the catcher is filled, all gone on drop',
		run: (context) =>
			withTable(context, 'snap-guides', async (table) => {
				const { page } = table;
				const token = await table.spawn('token', { position: LANE(0) });
				// every addSnapPoint is one patch on the wire, and the relay drops a
				// client over its burst budget (15) — so the scenario is seeded in
				// small paced batches, never one 34-patch burst
				const add = (points: Record<string, unknown>[]) =>
					page.evaluate(
						(batch) => batch.map((p) => window.__tableplace!.actions.addSnapPoint(p as never)),
						points
					);
				const [target, probe] = await add([
					{ position: [2, 1] },
					// a wide ring well clear of the landing: the pixel probe reads its band
					{ position: [-2, 1], radius: 2 }
				]);
				const ids = { target, probe };
				// a far row of 31 more — the 30+ scenario the guides must stay cheap for
				for (let i = 0; i < 31; i += 3) {
					await sleep(700);
					await add(
						Array.from({ length: Math.min(3, 31 - i) }, (_, k) => ({
							position: [-15 + i + k, -9 + ((i + k) % 2)],
							radius: 0.4
						}))
					);
				}
				await sleep(700);
				// cells x ∈ {4,6,8}: only the column nearest the pointer is in reach
				await add([{ position: [6, 1], kind: 'grid', pitch: 2, cols: 3, rows: 3 }]);
				await table.settle();

				const guides = () => page.evaluate(() => window.__tableplace!.snapGuides());
				const at = (x: number, z: number) =>
					page.evaluate((wx, wz) => window.__tableplace!.project([wx, 0.26, wz]), x, z);

				const idle = await guides();
				ok(
					idle.rings === 0 && idle.target === null && idle.dim === 0,
					`snap guides draw with nothing lifted: ${JSON.stringify(idle)}`
				);
				// the probe pixel: inside the wide ring's band, on bare felt
				const probePoint = await at(-2 + 2 * 0.93, 1);
				ok(probePoint, 'the probe ring projects off-screen');
				const [before] = await table.pixels([probePoint!]);
				ok(before!.onCanvas, 'the probe ring draws under a HUD pane — move it');

				// lift the token and hold it over the target point
				const from = await table.locate(token);
				const to = await at(2, 1);
				ok(from && to, 'cannot place the gesture on screen');
				await page.mouse.move(from!.x, from!.y);
				await sleep(80);
				await page.mouse.down();
				await sleep(80);
				for (let step = 1; step <= 12; step++) {
					await page.mouse.move(
						from!.x + ((to!.x - from!.x) * step) / 12,
						from!.y + ((to!.y - from!.y) * step) / 12
					);
					await sleep(20);
				}
				try {
					const lifted = await eventually(guides, (g) => g.opacity >= 0.69 && g.target !== null);
					const dragging = await page.evaluate(() => window.__tableplace!.drag().isDragging);
					ok(dragging === token, `the token was never lifted (dragging: ${dragging})`);
					ok(lifted.rings === 33, `expected 33 rings while lifted, got ${JSON.stringify(lifted)}`);
					ok(
						lifted.cells > 0 && lifted.cells < 9,
						`the grid should show only the cells near the pointer, got ${lifted.cells} of 9`
					);
					ok(
						lifted.target === ids.target,
						`the filled point is ${lifted.target}, not the one under the drop (${ids.target})`
					);
					ok(
						Math.abs(lifted.targetAt![0] - 2) < 0.01 && Math.abs(lifted.targetAt![2] - 1) < 0.01,
						`the fill draws at ${JSON.stringify(lifted.targetAt)}, not on the point [2, 1]`
					);
					ok(lifted.dim > 0, `overlays under the points did not dim: ${lifted.dim}`);
					ok(
						lifted.objects === 5,
						`the guides should be 5 draw objects however many points exist, got ${lifted.objects}`
					);
					// a token without `reach` gets no bright set, whatever the links
					ok(lifted.reach === 0, `reach rings drew for a piece without reach: ${lifted.reach}`);
					const [during] = await table.pixels([probePoint!]);
					const shift = during!.rgb.reduce((sum, c, i) => sum + Math.abs(c - before!.rgb[i]!), 0);
					ok(
						shift > 30,
						`the probe ring did not draw: felt ${JSON.stringify(before!.rgb)} → ${JSON.stringify(during!.rgb)}`
					);
					await table.snap('snap-guides');

					// Alt: the no-snap modifier hides the rings (and the drop won't snap)
					await page.keyboard.down('Alt');
					const alt = await eventually(guides, (g) => g.rings === 0);
					ok(alt.rings === 0 && alt.target === null, `Alt left guides up: ${JSON.stringify(alt)}`);
					await page.keyboard.up('Alt');
					const back = await eventually(guides, (g) => g.opacity >= 0.69);
					const state = await page.evaluate(() => window.__tableplace!.drag());
					ok(
						back.target === ids.target,
						`releasing Alt did not bring the guides back: ${JSON.stringify(back)}, drag ${JSON.stringify(state)}`
					);
				} finally {
					await page.mouse.up();
				}

				const dropped = await eventually(guides, (g) => g.rings === 0 && g.dim === 0);
				ok(
					dropped.rings === 0 &&
						dropped.cells === 0 &&
						dropped.target === null &&
						dropped.dim === 0,
					`snap guides still draw after the drop: ${JSON.stringify(dropped)}`
				);
				const landed = await table.positionOf(token);
				ok(
					landed && Math.abs(landed[0] - 2) < 0.01 && Math.abs(landed[2] - 1) < 0.01,
					`the token did not land on the point the guides filled: ${JSON.stringify(landed)}`
				);
				const [after] = await table.pixels([probePoint!]);
				const residue = after!.rgb.reduce((sum, c, i) => sum + Math.abs(c - before!.rgb[i]!), 0);
				ok(
					residue < 15,
					`the probe ring is still drawn after the drop: ${JSON.stringify(before!.rgb)} → ${JSON.stringify(after!.rgb)}`
				);

				await assertDraggable(table, token, 'the token (after the guides)');
				assertClean(table, 'with snap guides');
			})
	},
	{
		/**
		 * tableplace-190: links and reach. A ring of six linked snap points; a
		 * piece with `reach: 2` lifted off one of them lights the points within
		 * two links brighter, from their own instanced mesh, and fades the rest.
		 * A second piece sits on a neighbour: that point is not a landing, but
		 * the walk still passes through it. Advisory only — the piece is then
		 * dropped on the one point *out* of reach, and it lands there.
		 */
		name: 'reach rings: a linked board lights the points within reach, and blocks nothing',
		run: (context) =>
			withTable(context, 'reach-rings', async (table) => {
				const { page } = table;
				// a ring of six, 0-1-2-3-4-5-0, plus a link to a point that doesn't exist
				const spots: [number, number][] = [
					[-6, -1],
					[-3, 1],
					[3, 1],
					[6, -1],
					[3, -4],
					[-3, -4]
				];
				const link = (i: number) => [`snap:${(i + 1) % 6}`];
				const add = (points: Record<string, unknown>[]) =>
					page.evaluate(
						(batch) => batch.map((p) => window.__tableplace!.actions.addSnapPoint(p as never)),
						points
					);
				// paced under the relay's burst budget, like the snap-guides seed
				const ids: string[] = [];
				for (let i = 0; i < 6; i += 3) {
					if (i) await sleep(700);
					ids.push(
						...(await add(
							spots.slice(i, i + 3).map((position, k) => ({
								position,
								radius: 1.2,
								links: i + k === 0 ? [...link(0), 'snap:99'] : link(i + k),
								tags: [i + k < 3 ? 'north' : 'south']
							}))
						))
					);
				}
				ok(
					ids.join() === 'snap:0,snap:1,snap:2,snap:3,snap:4,snap:5',
					`the board seeded unexpected ids: ${ids.join()}`
				);
				await sleep(700);
				const runner = await table.spawn('token', {
					position: [spots[0]![0], PIECE_REST_Y, spots[0]![1]],
					reach: 2
				});
				const blocker = await table.spawn('token', {
					position: [spots[1]![0], PIECE_REST_Y, spots[1]![1]]
				});
				await table.settle();

				const guides = () => page.evaluate(() => window.__tableplace!.snapGuides());
				const at = (x: number, z: number) =>
					page.evaluate((wx, wz) => window.__tableplace!.project([wx, 0.26, wz]), x, z);

				// lift the runner off snap:0 and carry it to snap:3, three links away
				const from = await table.locate(runner);
				const to = await at(spots[3]![0], spots[3]![1]);
				ok(from && to, 'cannot place the gesture on screen');
				await page.mouse.move(from!.x, from!.y);
				await sleep(80);
				await page.mouse.down();
				await sleep(80);
				for (let step = 1; step <= 12; step++) {
					await page.mouse.move(
						from!.x + ((to!.x - from!.x) * step) / 12,
						from!.y + ((to!.y - from!.y) * step) / 12
					);
					await sleep(20);
				}
				try {
					const lifted = await eventually(guides, (g) => g.reach > 0 && g.target !== null);
					const dragging = await page.evaluate(() => window.__tableplace!.drag().isDragging);
					ok(dragging === runner, `the runner was never lifted (dragging: ${dragging})`);
					// within 2 links of snap:0: 1 and 5, then 2 and 4 — minus the occupied snap:1
					const expected = ['snap:0', 'snap:2', 'snap:4', 'snap:5'];
					ok(
						JSON.stringify(lifted.reachIds) === JSON.stringify(expected),
						`bright set is ${JSON.stringify(lifted.reachIds)}, expected ${JSON.stringify(expected)}`
					);
					ok(
						lifted.reach === 4 && lifted.rings === 2,
						`expected 4 bright + 2 ordinary rings (occupied snap:1, far snap:3): ${JSON.stringify(lifted)}`
					);
					ok(
						lifted.target === 'snap:3',
						`the drop should still be caught by snap:3, out of reach: ${lifted.target}`
					);
					await table.snap('reach-rings');
				} finally {
					await page.mouse.up();
				}

				const dropped = await eventually(guides, (g) => g.reach === 0 && g.rings === 0);
				ok(
					dropped.reach === 0 && dropped.reachIds.length === 0,
					`reach rings still draw after the drop: ${JSON.stringify(dropped)}`
				);
				// advisory: the out-of-reach drop landed exactly where it was aimed
				const landed = await table.positionOf(runner);
				ok(
					landed &&
						Math.abs(landed[0] - spots[3]![0]) < 0.01 &&
						Math.abs(landed[2] - spots[3]![1]) < 0.01,
					`an out-of-reach drop was blocked or moved: ${JSON.stringify(landed)}`
				);

				await assertDraggable(table, blocker, 'the blocker (after reach rings)');
				await assertDraggable(table, runner, 'the runner (after reach rings)');
				assertClean(table, 'with reach rings');
			})
	},
	{
		/**
		 * tableplace-145: Alt opts out of the XZ square-up, not of resting on
		 * top. An Alt-drop overlapping a resting card must land at the pointer's
		 * XZ (no pull onto the pile) but one card thickness ABOVE the card under
		 * it — two coplanar cards z-fight no matter how good the depth buffer is,
		 * which is exactly what the broken build rendered.
		 */
		name: 'alt drop: overlapping a resting card rests on top, at the pointer',
		run: (context) =>
			withTable(context, 'alt-drop', async (table) => {
				const CARD_REST = 0.26; // felt rest height for a card
				const CARD_THICKNESS = 0.03;

				// same retry-on-slip shape as the model-surface spec: what's being
				// retried is puppeteer's pointer delivery under SwiftShader, and each
				// hop proves the drag ARRIVED before its landing is judged
				const dragToArrives = async (
					id: string,
					x: number,
					z: number,
					label: string,
					options: { alt?: boolean } = {}
				) => {
					for (let attempt = 0; attempt < 3; attempt++) {
						await table.dragTo(id, x, z, options);
						await table.settle(900);
						const position = await table.positionOf(id);
						if (position && Math.hypot(position[0] - x, position[2] - z) < 1.0) return position;
					}
					const stuck = await table.positionOf(id);
					throw new Error(
						`${label} (${id}) never arrived at (${x}, ${z}) after 3 drags: ${JSON.stringify(stuck)}`
					);
				};

				// a two-card deck clear of the HUD panes. The cards come out ONE AT A
				// TIME, each parked before the next is drawn — two cards drawn
				// together land fanned only 0.42 apart, and a press at the lower
				// one's centre grabs the top one instead
				const deck = await table.page.evaluate(() => {
					const cards = ['AS', 'KH'].map((code) => ({
						id: `card:std:alt-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(
						window.__tableplace!.actions.addDeck({ cards, position: [-2, 0.4, -2] } as never) ?? ''
					);
				});
				await table.settle(1000);
				const draw = async () => {
					const id = await table.page.evaluate(
						(deckId) => window.__tableplace!.actions.drawFromTop(deckId, 1)[0]?.id ?? '',
						deck
					);
					ok(!!id, 'nothing came off the top of the deck');
					await table.settle(1500); // draw springs done before the grab
					return id;
				};

				// the resting card, parked on bare felt in the clear lane
				const under = await dragToArrives(await draw(), -4, 1, 'the resting card');
				ok(
					Math.abs((under[1] ?? 9) - CARD_REST) < 0.02,
					`the resting card is not at felt rest (${CARD_REST}): ${JSON.stringify(under)}`
				);

				// Alt-drop the second card overlapping it, released off its centre
				const dropped = await dragToArrives(await draw(), -3.4, 1.4, 'the Alt-dropped card', {
					alt: true
				});

				// Alt held: no square-up — the landing stays at the pointer, planar
				// distance from the card under it well clear of zero (a squared-up
				// drop would sit at EXACTLY its XZ) yet still overlapping
				const apart = planarDistance(under, dropped);
				ok(
					apart > 0.2 && apart < 1.6,
					`the Alt-drop did not stay at the pointer: ${JSON.stringify(dropped)} vs ${JSON.stringify(under)} (planar ${apart.toFixed(3)})`
				);

				// …and the height merged anyway: one thickness above the resting
				// card, never coplanar with it (tableplace-145's z-fight)
				ok(
					Math.abs((dropped[1] ?? 9) - ((under[1] ?? 0) + CARD_THICKNESS)) < 0.005,
					`the Alt-drop did not rest one thickness above the card under it: ` +
						`${JSON.stringify(dropped)} over ${JSON.stringify(under)}`
				);

				await assertDraggable(table, deck, 'deck (after an Alt-drop)');
				assertClean(table, 'after Alt-dropping onto an overlapping card');
				await table.snap('alt-drop');
			})
	},
	{
		/**
		 * tableplace-135: a catalog model (GLB over HTTP) renders, drags, and
		 * rotates VISIBLY — the piece-rotation binding this ticket fixed — while
		 * the deck and a die stay interactive beside it. `requestfailed` is part
		 * of assertClean, so a 404ing manifest or GLB fails here by name. A
		 * second browser then joins the same lobby and must see the same cave:
		 * the ref syncs, the geometry re-resolves.
		 */
		name: 'model: a cave section renders, rotates and syncs beside deck + die',
		run: async (context) => {
			const lobby = nextLobby('model');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				const deck = await table.seedDeck();
				// room-wide: 5×3 cells → a 10×6.1 world footprint, asymmetric on
				// purpose so a quarter turn is measurable in the rendered bbox
				const model = await table.spawn('model', {
					name: 'room-wide',
					model: 'model:kenney-cave/room-wide',
					radius: 5.86,
					position: [0, 0.16, 0]
				});
				const die = await table.spawn('die', { sides: 20, position: [8, 0.16, 1] });
				await table.settle(3000); // manifest fetch + GLB fetch + parse
				assertClean(table, 'after spawning a cave section from the catalog');
				await assertRenders(table, model, 'the cave section');

				// polled: a slow CI runner can still be showing the placeholder box
				// (untextured) while the GLB fetch+parse finishes
				const flat = await eventually(
					() => table.describe(model),
					(shape) =>
						!!shape &&
						shape.size[0] > shape.size[2] + 2 &&
						shape.materials.some((material) => (material as { hasMap: boolean }).hasMap)
				);
				ok(
					flat!.size[0] > flat!.size[2] + 2,
					`room-wide should be wider (x) than deep (z): ${JSON.stringify(flat!.size)}`
				);
				ok(
					flat!.materials.some((material) => (material as { hasMap: boolean }).hasMap),
					`the section mounted untextured — the atlas did not load: ${JSON.stringify(flat!.materials)}`
				);

				// rotate by the grid step: the synced yaw must become visible geometry
				await table.page.evaluate((id) => window.__tableplace!.actions.rotatePiece(id, 90), model);
				const turned = await eventually(
					() => table.describe(model),
					(shape) => !!shape && shape.size[2] > shape.size[0] + 2
				);
				ok(
					turned!.size[2] > turned!.size[0] + 2,
					`rotating 90° did not turn the rendered section: ${JSON.stringify(turned!.size)}`
				);
				const storedYaw = await table.page.evaluate(
					(id) => window.__tableplace!.state()?.pieces?.[id]?.rotation ?? null,
					model
				);
				ok(storedYaw?.[1] === 90, `the yaw did not sync as degrees: ${JSON.stringify(storedYaw)}`);

				await assertDraggable(table, model, 'the cave section');
				await assertDraggable(table, deck, 'deck (with a cave section on the table)');
				await assertDraggable(table, die, 'the d20 (with a cave section on the table)');
				assertClean(table, 'after dragging with a cave section on the table');

				// the second browser: same lobby, same cave
				const remote = await openTable(context.browser, context.servers, lobby);
				try {
					await remote.settle(3000);
					await assertRenders(remote, model, 'the cave section (remote client)');
					const localPos = await table.positionOf(model);
					const remotePos = await remote.positionOf(model);
					ok(
						!!localPos &&
							!!remotePos &&
							planarDistance(localPos, remotePos) < 0.01 &&
							Math.abs((localPos[1] ?? 0) - (remotePos[1] ?? 0)) < 0.01,
						`the two clients disagree where the section is: ${JSON.stringify(localPos)} vs ${JSON.stringify(remotePos)}`
					);
					assertClean(remote, 'on the second client with the synced cave');
				} finally {
					await remote.close();
				}
				await table.snap('model');
			} finally {
				await table.close();
			}
		}
	},
	{
		/**
		 * Surface rest (tableplace-135 §6): a token dropped onto a raised model
		 * tile must rest on its top surface — the injected surfaceYAt raycast —
		 * and settle back EXACTLY to felt rest height when dragged off again
		 * (elevation must never stick to the next drop). No physics: both
		 * heights are computed at the drop and synced as plain positions.
		 *
		 * Each hop asserts the drag ARRIVED (planar) before judging its height,
		 * so a synthetic-pointer grab that slips on a slow CI frame reads as
		 * "the drag never happened", not as a false elevation bug — and slips
		 * are retried via dragToArrives, with generous settles so the height
		 * spring has finished before the next grab aims at the token.
		 */
		name: 'model surface: a token dropped on a raised tile rests on it',
		run: (context) =>
			withTable(context, 'model-surface', async (table) => {
				const PIECE_FELT_REST = 0.335; // TABLE_TOP_Y + half the disc thickness

				/**
				 * dragTo, retried while the token demonstrably did not arrive at the
				 * target XZ. What is being retried is puppeteer's pointer delivery
				 * under SwiftShader — dispatch liveness has its own single-attempt
				 * assertions (assertDraggable) elsewhere; the properties under test
				 * here are the rest HEIGHTS, asserted after arrival.
				 */
				const dragToArrives = async (id: string, x: number, z: number, label: string) => {
					for (let attempt = 0; attempt < 3; attempt++) {
						await table.dragTo(id, x, z);
						await table.settle(900); // springs done before the next locate()
						const position = await table.positionOf(id);
						if (position && Math.hypot(position[0] - x, position[2] - z) < 1.0) return position;
					}
					const stuck = await table.positionOf(id);
					throw new Error(
						`${label} (${id}) never arrived at (${x}, ${z}) after 3 drags: ${JSON.stringify(stuck)}`
					);
				};

				const deck = await table.seedDeck();
				const tile = await table.spawn('model', {
					name: 'raised',
					model: 'model:kenney-cave/template-floor-layer-raised',
					radius: 2.83,
					position: [-4, 0.16, 1]
				});
				const token = await table.spawn('token', { position: [4, 0.16, 1] });
				await table.settle(2500);
				assertClean(table, 'with a raised tile and a token on the table');
				await assertRenders(table, tile, 'the raised tile');

				// on: the drop lands on the tile's surface, well above felt rest
				const onTile = await dragToArrives(token, -4, 1, 'the token (onto the tile)');
				ok(
					(onTile[1] ?? 0) > 0.5,
					`the token sank to felt height instead of resting on the tile: ${JSON.stringify(onTile)}`
				);

				// off: the next drop has no model under it — the effective floor
				// falls back to the felt and the rest height is EXACTLY the token's
				// felt rest, not the carried-over elevation
				const onFelt = await dragToArrives(token, 6, 1, 'the token (off the tile)');
				ok(
					Math.abs((onFelt[1] ?? 9) - PIECE_FELT_REST) < 0.02,
					`the token did not return to felt rest (${PIECE_FELT_REST}) after leaving the tile: ${JSON.stringify(onFelt)}`
				);

				// and back on: the surface answer is repeatable, not a spawn artifact
				const backOn = await dragToArrives(token, -4, 1, 'the token (back onto the tile)');
				ok(
					(backOn[1] ?? 0) > 0.5,
					`the token failed to rest on the tile a second time: ${JSON.stringify(backOn)}`
				);

				await assertDraggable(table, deck, 'deck (with surface rest in play)');
				assertClean(table, 'after resting a token on a model surface');
				await table.snap('model-surface');
			})
	},
	{
		/**
		 * tableplace-164: the same tile → felt → tile gesture as `model surface`,
		 * run while the page's main thread is deliberately held for long
		 * stretches — the frame gaps a shared CI runner, a slow GPU or a
		 * backgrounded window produce.
		 *
		 * What it is guarding, precisely: a press aims at where an entity is
		 * DRAWN, and is dispatched against wherever the scene has got to by the
		 * time the main thread frees up. When frames are scarce those two states
		 * drift apart — an entity still animating toward its resting place is
		 * drawn at a stale place, the press queues behind the stall, and the
		 * raycast at the aimed pixel finds whatever is underneath instead. That
		 * is how the token's press relocated the TILE on CI (#157/#159), which
		 * is why the tile's own position is asserted here: it is the sharpest
		 * signature of the race, and it holds no matter which drag attempt won.
		 */
		name: 'frame stalls: a drag survives long frame gaps',
		run: (context) =>
			withTable(context, 'frame-stalls', async (table) => {
				const PIECE_FELT_REST = 0.335; // TABLE_TOP_Y + half the disc thickness

				/**
				 * Tuned, not guessed. The gap has to outlast the harness's own
				 * settles so an entity is still mid-flight when the next press aims
				 * at it, and the free window has to be about one frame wide —
				 * svelte's springs clamp their integration to 1/30s per tick, so a
				 * wider window lets a whole flight finish in one catch-up and there
				 * is nothing left to race. At these numbers the pre-fix build
				 * relocates the tile to (6, 1): CI's exact failing position.
				 */
				const STALL = { ms: 800, everyMs: 20 };

				/**
				 * The invariant the whole ticket is about: an entity's own pixel has
				 * to belong to that entity. It is checked with no settle in front of
				 * it, because the window where it fails is the flight itself — a
				 * token still rising onto a raised tile is UNDER that tile's top
				 * surface, so the pointer aimed at the token grabs the tile and
				 * drags it away (#157/#159, and reproduced here to the millimetre).
				 */
				const assertAimBelongsTo = async (id: string, when: string) => {
					const point = await table.locate(id);
					ok(point, `${id} could not be located ${when}`);
					const hits = await table.hits(point!);
					ok(
						hits[0] === id,
						`${when}, the pixel ${id} is DRAWN at belongs to ${hits[0] ?? 'nothing'} — ` +
							`a press aimed at it would grab that instead (hits: ${hits.join(', ')})`
					);
				};

				/** as `model surface`: what is retried is pointer delivery, not the property under test */
				const dragToArrives = async (id: string, x: number, z: number, label: string) => {
					for (let attempt = 0; attempt < 3; attempt++) {
						await table.dragTo(id, x, z);
						await table.settle(900);
						const position = await table.positionOf(id);
						if (position && Math.hypot(position[0] - x, position[2] - z) < 1.0) return position;
					}
					const stuck = await table.positionOf(id);
					throw new Error(
						`${label} (${id}) never arrived at (${x}, ${z}) after 3 drags: ${JSON.stringify(stuck)}`
					);
				};

				const deck = await table.seedDeck();
				const tile = await table.spawn('model', {
					name: 'raised',
					model: 'model:kenney-cave/template-floor-layer-raised',
					radius: 2.83,
					position: [-4, 0.16, 1]
				});
				const token = await table.spawn('token', { position: [4, 0.16, 1] });
				await table.settle(2500);
				assertClean(table, 'with a raised tile and a token on the table');

				const tileAtRest = await table.positionOf(tile);
				ok(tileAtRest, `the raised tile (${tile}) never landed in the store`);

				let injected = 0;
				try {
					await table.stall(STALL);

					// onto the tile — then, with no settle, the moment the race lives in
					await table.dragTo(token, -4, 1);
					await assertAimBelongsTo(token, 'just after the token was dropped on the raised tile');

					const onTile = await dragToArrives(token, -4, 1, 'the token (onto the tile)');
					ok(
						(onTile[1] ?? 0) > 0.5,
						`under frame stalls the token sank to felt height instead of resting on the tile: ${JSON.stringify(onTile)}`
					);

					// and off again: the drop that must fall back to felt rest
					await table.dragTo(token, 6, 1);
					await assertAimBelongsTo(token, 'just after the token was dragged off the tile');

					const onFelt = await dragToArrives(token, 6, 1, 'the token (off the tile)');
					ok(
						Math.abs((onFelt[1] ?? 9) - PIECE_FELT_REST) < 0.02,
						`under frame stalls the token did not return to felt rest (${PIECE_FELT_REST}) after ` +
							`leaving the tile: ${JSON.stringify(onFelt)}`
					);
				} finally {
					injected = await table.stall(null);
				}

				// the injector is the whole point of the spec: if it never ran, the
				// green above means nothing
				ok(
					injected > 5,
					`the stall injector only ran ${injected} times — this spec did not test what it claims to`
				);

				// the race's own fingerprint: a press meant for the token, dispatched
				// against a scene it could no longer see, grabs the tile and drags THAT
				const tileNow = await table.positionOf(tile);
				ok(
					planarDistance(tileAtRest, tileNow) < 0.5,
					`a press meant for the token grabbed the raised tile underneath it and moved it: ` +
						`${JSON.stringify(tileAtRest)} → ${JSON.stringify(tileNow)}`
				);

				await table.settle(1200); // frames are free again; let the scene catch up
				await assertDraggable(table, deck, 'deck (after a run of frame stalls)');
				assertClean(table, 'after dragging through injected frame stalls');
				await table.snap('frame-stalls');
			})
	},
	{
		/**
		 * Scene sanity (tableplace-135 acceptance): a template-built ~30-tile
		 * cave plus decks and dice stays interactive — thirty clones of one GLB,
		 * one texture, and the shared raycast still answers for everything.
		 */
		name: 'model scene: a 30-tile cave + decks + dice stays interactive',
		run: (context) =>
			withTable(context, 'model-scene', async (table) => {
				const deck = await table.seedDeck();
				const tiles: string[] = [];
				for (let column = 0; column < 6; column++) {
					for (let row = 0; row < 5; row++) {
						tiles.push(
							await table.spawn('model', {
								name: `corridor-${column}-${row}`,
								model: 'model:kenney-cave/corridor',
								radius: 1.42,
								position: [-14 + column * 2, 0.16, -5 + row * 2]
							})
						);
					}
				}
				const die = await table.spawn('die', { sides: 6, position: [4, 0.16, 2] });
				await table.settle(4000);
				assertClean(table, 'with a 30-tile cave, a deck and a die on the table');

				await assertRenders(table, tiles[0], 'the first cave tile');
				await assertRenders(table, tiles[tiles.length - 1], 'the last cave tile');
				await assertDraggable(table, deck, 'deck (in the 30-tile cave scene)');
				await assertDraggable(table, die, 'the d6 (in the 30-tile cave scene)');
				assertClean(table, 'at the end of the 30-tile cave scene');
				await table.snap('model-scene');
			})
	},
	{
		/**
		 * tableplace-148: the Cataclysm Arcade lobby creator's zone set
		 * (tableplace-demos/cataclysm-arcade) — a one-card face-up boss pile in
		 * play, the draw deck, a face-up token pile, a counter rail (boss health
		 * full at 17, coins started at 1) and an infinite bag of damage counters —
		 * composed together and interactive. Faces are `gen:` refs so the spec
		 * fetches nothing; the demo's real `sheet:` faces ride the pipeline other
		 * specs already exercise.
		 */
		name: 'cataclysm arcade: boss pile, counter rail and token bag stay interactive',
		run: (context) =>
			withTable(context, 'cataclysm', async (table) => {
				const deck = await table.page.evaluate(() => {
					// the 14-card booster deal, at the layout's own deck spot
					const codes = [
						'AS',
						'2S',
						'3S',
						'4S',
						'5S',
						'6S',
						'7S',
						'8S',
						'9S',
						'10S',
						'JS',
						'QS',
						'KS',
						'AH'
					];
					const cards = codes.map((code) => ({
						id: `card:cade:${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(window.__tableplace!.actions.addDeck({ cards } as never) ?? '');
				});
				const boss = await table.page.evaluate(() => {
					// the Boss starts in play: a one-card pile dealt face-up
					const cards = [
						{ id: 'card:cade:boss', faceImageUrl: 'gen:std52/KD', backImageUrl: 'gen:std52/back' }
					];
					return String(
						window.__tableplace!.actions.addDeck({
							cards,
							isFaceUp: true,
							position: [-2, 0.4, -2]
						} as never) ?? ''
					);
				});
				const tokens = await table.page.evaluate(() => {
					// five copies of the pack's token card, face-up
					const cards = [1, 2, 3, 4, 5].map((n) => ({
						id: `card:cade:token-${n}`,
						faceImageUrl: 'gen:std52/JC',
						backImageUrl: 'gen:std52/back'
					}));
					return String(
						window.__tableplace!.actions.addDeck({
							cards,
							isFaceUp: true,
							position: [-6, 0.4, -2]
						} as never) ?? ''
					);
				});
				const health = await table.spawn('counter', {
					name: 'Boss health',
					maxValue: 17,
					position: LANE(0)
				});
				const coins = await table.spawn('counter', {
					name: 'Coins',
					maxValue: 20,
					value: 1,
					position: LANE(1)
				});
				const bag = await table.spawn('bag', {
					name: 'Damage counters',
					infinite: true,
					position: LANE(2),
					contents: [{ kind: 'counter', name: 'Damage', color: '#b3372f', maxValue: 99 }]
				});
				await table.settle(1500);
				assertClean(table, 'with the cataclysm arcade zone set on the table');

				for (const [id, label] of [
					[deck, 'the draw deck'],
					[boss, 'the boss pile'],
					[tokens, 'the token pile'],
					[health, 'the boss-health counter'],
					[coins, 'the coin counter'],
					[bag, 'the damage-counter bag']
				] as const) {
					await assertRenders(table, id, `${label} (cataclysm table)`);
				}

				// the counters carry the seeded values: health spawns full, coins at 1
				const values = await table.page.evaluate(
					(a, b) => [
						window.__tableplace!.state()?.pieces?.[a]?.value ?? null,
						window.__tableplace!.state()?.pieces?.[b]?.value ?? null
					],
					health,
					coins
				);
				ok(values[0] === 17, `boss health did not spawn full at 17: ${JSON.stringify(values)}`);
				ok(values[1] === 1, `coins did not start at 1: ${JSON.stringify(values)}`);
				await table.page.evaluate(
					(id) => window.__tableplace!.actions.incrementCounter(id, 1),
					coins
				);
				const bumped = await eventually(
					() =>
						table.page.evaluate(
							(id) => window.__tableplace!.state()?.pieces?.[id]?.value ?? null,
							coins
						),
					(value) => value === 2
				);
				ok(
					bumped === 2,
					`incrementing the coin counter did not land on 2: ${JSON.stringify(bumped)}`
				);

				// play the Boss: draw it off its pile and tap it — a portrait card
				// taps sideways, so the rendered footprint turns wider than deep
				const bossCard = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					boss
				);
				ok(!!bossCard, 'nothing came off the boss pile');
				await table.settle(1500);
				await table.page.evaluate(
					(id) => window.__tableplace!.actions.tapCard(false, id),
					bossCard
				);
				const tapped = await eventually(
					() => table.describe(bossCard),
					(shape) => !!shape && shape.size[0] > shape.size[2]
				);
				ok(
					tapped!.size[0] > tapped!.size[2],
					`tapping did not turn the boss card sideways: footprint ${JSON.stringify(tapped!.size)}`
				);

				// a damage counter comes out of the bag live, and the infinite bag
				// keeps its contents
				const draw = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromBag(id),
					bag
				);
				ok(draw && (draw as { id: string }).id, 'the damage bag drew nothing');
				await table.settle(1000);
				await assertRenders(table, (draw as { id: string }).id, 'the drawn damage counter');
				const left = await table.page.evaluate(
					(id) =>
						(window.__tableplace!.state()?.pieces?.[id] as { contents?: unknown[] } | undefined)
							?.contents?.length ?? 0,
					bag
				);
				ok(left === 1, `the infinite bag lost its contents: ${left} left`);

				await assertDraggable(table, bossCard, 'the boss card (cataclysm table)');
				await assertDraggable(table, deck, 'the draw deck (cataclysm table)');
				await assertDraggable(table, bag, 'the damage-counter bag (cataclysm table)');
				assertClean(table, 'at the end of the cataclysm arcade table');
				await table.snap('cataclysm');
			})
	},
	{
		/**
		 * The deck's gestures, driven by a real mouse — REWRITTEN for
		 * tableplace-161's contract, which is deliberately not -103's:
		 *
		 *   tap                → draw one
		 *   drag               → draw the top card INTO the drag (always now:
		 *                        there is no hold that turns a drag into a move)
		 *   press and hold     → the radial wheel
		 *   "Move pile" wedge  → the pile follows the pointer and lands on the
		 *                        next click, once
		 *
		 * -103's hold-then-travel arm (and its amber cue) is gone: the long
		 * press belongs to the wheel, at the same beat as every other entity,
		 * and moving a pile is a verb you can see rather than a timing you have
		 * to know. The old spec asserted the arm cue's meshes; this asserts the
		 * wheel and the carry.
		 *
		 * Timing still follows #141: every gesture first ASSERTS IT ARRIVED (the
		 * drag started, the wheel is up, the pile is carried) before judging what
		 * it did, slipped synthetic gestures retry, and animated outcomes are
		 * polled to a bounded final state instead of racing a fixed settle.
		 */
		name: 'deck gestures: tap draws to the hand, drag draws into the drag, the wheel moves the pile',
		run: (context) =>
			withTable(context, 'deck-gestures', async (table) => {
				const deck = await table.seedDeck();
				await table.settle();

				const deckCount = () =>
					table.page.evaluate(
						(id) => window.__tableplace!.state()?.decks?.[id]?.cards?.length ?? -1,
						deck
					);
				const looseCards = () =>
					table.page.evaluate(() => Object.keys(window.__tableplace!.state()?.cards ?? {}));
				const handCount = () => table.page.evaluate(handSize);
				const dragOwner = () => table.page.evaluate(() => window.__tableplace!.drag().isDragging);

				// ── tap: one card into the hand, deck stays put ───────────────
				// (tableplace-194; the felt is Shift+click's — see the draw-to-hand spec)
				const start = await deckCount();
				const handBefore = await handCount();
				const tapAt = await table.locate(deck);
				ok(tapAt, 'the deck never mounted — nothing to tap');
				await table.page.mouse.click(tapAt!.x, tapAt!.y);
				// polled: the count is store truth, but a loaded runner can lag
				// processing the click itself
				const afterTap = await eventually(deckCount, (count) => count === start - 1);
				ok(
					afterTap === start - 1 &&
						(await handCount()) === handBefore + 1 &&
						(await looseCards()).length === 0,
					`a tap did not draw exactly one card into the hand: deck ${start} → ${afterTap}, ` +
						`hand ${handBefore} → ${await handCount()}, ${(await looseCards()).length} loose`
				);
				await table.settle(900); // the card's flight to the hand lands first

				// ── drag off the top: the drawn card takes over the gesture ───
				// The press and the threshold-crossing move are dispatched
				// back-to-back so no arm timer can be processed between them, and
				// the travel goes up-screen: the seeded deck sits near the table's
				// bottom edge, and a release down-screen of it would land the card
				// in the hand tray, which swallows it out of `cards` entirely.
				let handoff: { owner: string; deckAt: number[]; count: number } | null = null;
				let lastArrival: string | null = null;
				for (let attempt = 0; attempt < 3 && !handoff; attempt++) {
					const count = await deckCount();
					const deckAt = await table.positionOf(deck);
					const from = await table.locate(deck);
					ok(deckAt && from, 'the deck vanished from the scene');
					await table.page.mouse.move(from!.x, from!.y);
					await sleep(80);
					await table.page.mouse.down();
					await table.page.mouse.move(from!.x, from!.y - 40);
					// did the gesture arrive — and as what?
					const owner = await eventually(dragOwner, (o) => o !== null, 3000);
					lastArrival = owner;
					if (owner?.startsWith('card:')) {
						// walk on and confirm the drag never changes hands mid-flight
						for (let step = 1; step <= 6; step++) {
							await table.page.mouse.move(from!.x, from!.y - 40 - step * 20);
							await sleep(30);
							const now = await dragOwner();
							ok(
								now === owner,
								`the drag changed hands mid-gesture (${owner} → ${JSON.stringify(now)}) — the handoff flickered`
							);
						}
						await table.page.mouse.up();
						handoff = { owner, deckAt: deckAt!, count };
					} else {
						// never arrived (slipped grab) or arrived as the deck (the
						// spurious-arm race): abandon this attempt and re-baseline
						await table.page.mouse.up();
						await table.settle(900);
					}
				}
				ok(
					!!handoff,
					`travel off the deck never handed the drag to the drawn card in 3 attempts — ` +
						`the last gesture arrived as ${JSON.stringify(lastArrival)}`
				);
				const afterDraw = await eventually(deckCount, (count) => count === handoff!.count - 1);
				ok(
					afterDraw === handoff!.count - 1,
					`the drag-off draw did not shrink the deck by one (${handoff!.count} → ${afterDraw})`
				);
				const deckAfterDraw = await table.positionOf(deck);
				ok(
					planarDistance(handoff!.deckAt, deckAfterDraw) < 0.05,
					`dragging off the top moved the deck itself: ${JSON.stringify(handoff!.deckAt)} → ${JSON.stringify(deckAfterDraw)}`
				);
				const drawnPos = await eventually(
					() => table.positionOf(handoff!.owner),
					(p) => !!p && planarDistance(handoff!.deckAt, p) > 0.5
				);
				ok(
					!!drawnPos && planarDistance(handoff!.deckAt, drawnPos) > 0.5,
					`the drawn card did not follow the pointer away from the deck: ${JSON.stringify(drawnPos)}`
				);

				// ── long press: the wheel, and nothing drawn ──────────────────
				const countBeforeHold = await deckCount();
				const wheel = await table.openRadial(deck, { button: 'left', timeoutMs: 8000 });
				ok(
					['draw', 'flip', 'shuffle', 'ungroup', 'move'].every((slug) =>
						wheel.actions.includes(slug)
					),
					`the deck wheel is missing verbs: ${JSON.stringify(wheel.actions)}`
				);
				await table.page.mouse.up(); // released in the deadzone: a cancel
				await table.settle(700);
				ok(!(await table.radial()), 'the deck wheel stayed up after a deadzone release');
				ok(
					(await deckCount()) === countBeforeHold,
					`a long press that opened the wheel drew a card — it must not`
				);

				// ── the "Move pile" wedge carries the pile to the next click ──
				// The whole gesture — hold, flick to the wedge, walk, click down —
				// lives in table.ts's grabMoveTo, which is what dragBy now does for
				// a deck. Outcome polled, slipped attempts retried, same as before.
				let moved: { count: number } | null = null;
				for (let attempt = 0; attempt < 3 && !moved; attempt++) {
					const count = await deckCount();
					const before = await table.positionOf(deck);
					await table.dragBy(deck, 0, 150);
					const after = await eventually(
						() => table.positionOf(deck),
						(p) => !!p && planarDistance(before, p) > 0.5,
						3000
					);
					if (after && planarDistance(before, after) > 0.5) moved = { count };
				}
				ok(!!moved, `the "Move pile" wedge did not move the pile in 3 attempts`);
				ok((await deckCount()) === moved!.count, `moving the pile changed its card count`);
				ok(!(await table.radial()), 'the wheel was still up after the pile was placed');
				// one use only: the pile is settled, not still following the pointer
				const owner = await table.page.evaluate(() => window.__tableplace!.drag().isDragging);
				ok(owner === null, `the pile is still being carried after its placing click: ${owner}`);
				const placedAt = await table.positionOf(deck);
				await table.page.mouse.move(placedAt ? 200 : 200, 200);
				await table.settle(500);
				const stillPlaced = await table.positionOf(deck);
				ok(
					planarDistance(placedAt, stillPlaced) < 0.05,
					`the pile followed the pointer after being placed: ${JSON.stringify(placedAt)} → ${JSON.stringify(stillPlaced)}`
				);

				// ── Escape puts a carried pile back ──────────────────────────
				const homeAt = await table.positionOf(deck);
				const carry = await table.openRadial(deck, { button: 'left', timeoutMs: 8000 });
				await table.page.mouse.move(carry.wedges.move!.x, carry.wedges.move!.y, { steps: 8 });
				await sleep(120);
				await table.page.mouse.up();
				const lifted = await eventually(dragOwner, (o) => o === deck, 3000);
				ok(lifted === deck, `the "Move pile" wedge did not pick the pile up: ${lifted}`);
				const away = await table.locate(deck);
				await table.page.mouse.move(away!.x + 120, away!.y, { steps: 8 });
				await table.settle(300);
				await table.page.keyboard.press('Escape');
				await table.settle(800);
				ok((await dragOwner()) === null, 'Escape left the pile in the air');
				const returned = await table.positionOf(deck);
				ok(
					planarDistance(homeAt, returned) < 0.05,
					`Escape did not put the carried pile back: ${JSON.stringify(homeAt)} → ${JSON.stringify(returned)}`
				);

				assertClean(table, 'after the deck gesture suite');
				await table.snap('deck-gestures');
			})
	},
	{
		/**
		 * tableplace-194: a deck click deals into your hand. Shift+click keeps
		 * the old landing on the felt. `5` draws five in one wire message (the relay drops a client
		 * past 7 msg/s). The other player in the lobby sees the deck count drop
		 * and the hand count rise, and their own deck refuses the host's click,
		 * out loud.
		 *
		 * The other player is a bare relay client (`relayPeer`), not a second
		 * page: a second SwiftShader page doubles the render load and on a
		 * shared runner blows the harness's 60s ready wait. The relay's view of
		 * the lobby is exactly what a remote player's HUD counts are drawn from.
		 * Every step waits on state, never on a fixed delay.
		 *
		 * Not asserted here: the deck → hand flight (HUDTray/drawFlight). A
		 * per-frame recorder in this harness only ever saw the card at its
		 * resting slot, and whether that is the harness or the flight is still
		 * open — it is verified by eye in a follow-up ticket, not by this spec.
		 */
		name: 'draw to hand: click deals to the hand, Shift keeps the felt, 5 is one message',
		run: async (context) => {
			const lobby = nextLobby('draw-to-hand');
			const peer = await relayPeer(context.servers.relay, lobby, 'e2e-peer');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				// the other seat: a player with a small deck of its own, clear of the
				// host's deck and of the HUD panes
				const peerDeck = 'deck:e2e-peer:0';
				peer.send({
					players: { 'e2e-peer': { id: 'e2e-peer', seat: 1, tray: {} } },
					decks: {
						[peerDeck]: {
							id: peerDeck,
							isFaceUp: false,
							position: [LANE(0)[0], 0.4, LANE(0)[2]],
							rotation: [0, 0, 0],
							cards: ['AS', '2S', '3S'].map((code) => ({
								id: `card:e2e-peer:${code}`,
								faceImageUrl: `gen:std52/${code}`,
								backImageUrl: 'gen:std52/back'
							}))
						}
					}
				});
				const deck = await table.seedDeck();

				const deckCount = (id: string) =>
					table.page.evaluate(
						(deckId) => window.__tableplace!.state()?.decks?.[deckId]?.cards?.length ?? -1,
						id
					);
				const hostId = await table.page.evaluate(() => window.__tableplace!.actions.getMyId());
				ok(hostId, 'the host has no player id');
				const hand = () =>
					table.page.evaluate(() => {
						const bridge = window.__tableplace!;
						const me = bridge.actions.getMyId();
						return Object.keys((me && bridge.state()?.players?.[me]?.tray) ?? {});
					});
				const looseCards = () =>
					table.page.evaluate(() => Object.keys(window.__tableplace!.state()?.cards ?? {}).length);
				// what the other seat's PlayerHud counts
				const seenByPeer = () => ({
					deck: peer.state.decks?.[deck]?.cards?.length ?? -1,
					hand: Object.keys(peer.state.players?.[hostId!]?.tray ?? {}).length
				});

				const start = await eventually(
					() => deckCount(deck),
					(count) => count === 52
				);
				ok(start === 52, `the seeded deck holds ${start} cards, not 52`);
				const peerStart = await eventually(
					() => deckCount(peerDeck),
					(count) => count === 3
				);
				ok(peerStart === 3, `the other player's deck never reached the host (${peerStart})`);
				ok(
					(await eventually(
						async () => seenByPeer().deck,
						(count) => count === 52
					)) === 52,
					'the other player never saw the seeded deck'
				);

				// ── click: one card from the deck into the hand ───────────────
				const deckAt = await eventually(
					() => table.locate(deck),
					(point) => !!point
				);
				ok(deckAt, 'the deck never mounted — nothing to click');
				await table.page.mouse.click(deckAt!.x, deckAt!.y);

				const drawn = await eventually(hand, (ids) => ids.length === 1);
				ok(drawn.length === 1, `a deck click put ${drawn.length} cards in the hand, not 1`);
				ok(
					(await deckCount(deck)) === start - 1 && (await looseCards()) === 0,
					`the click did not take exactly one card off the deck into the hand: ` +
						`deck ${start} → ${await deckCount(deck)}, ${await looseCards()} loose on the felt`
				);

				// ── the other seat sees the counts ────────────────────────────
				const remote = await eventually(
					async () => seenByPeer(),
					(seen) => seen.deck === start - 1 && seen.hand === 1
				);
				ok(
					remote.deck === start - 1 && remote.hand === 1,
					`the other player saw deck ${remote.deck} / hand ${remote.hand}, not ${start - 1} / 1`
				);

				// ── Shift+click: the old landing on the felt ──────────────────
				await table.page.keyboard.down('Shift');
				await table.page.mouse.click(deckAt!.x, deckAt!.y);
				await table.page.keyboard.up('Shift');
				const loose = await eventually(looseCards, (count) => count === 1);
				ok(
					loose === 1 && (await hand()).length === 1,
					`Shift+click did not draw to the felt: ${loose} loose, ${(await hand()).length} in hand`
				);
				ok((await deckCount(deck)) === start - 2, 'Shift+click did not shrink the deck by one');

				// ── `5`: five cards, one message on the wire ──────────────────
				await table.page.mouse.move(deckAt!.x, deckAt!.y);
				const hovered = await eventually(
					() => table.page.evaluate(() => window.__tableplace!.drag().isDeckHovered),
					(id) => id === deck
				);
				ok(hovered === deck, `the pointer never hovered the deck (hovered: ${hovered})`);
				const cdp = await table.page.createCDPSession();
				await cdp.send('Network.enable');
				const sent: string[] = [];
				cdp.on('Network.webSocketFrameSent', (event) => sent.push(event.response.payloadData));
				await table.page.keyboard.press('Digit5');
				const afterFive = await eventually(
					async () => (await hand()).length,
					(count) => count === 6
				);
				// the peer holding the new count means the patch has crossed the
				// wire — anything a draw sends has been sent by then
				const remoteFive = await eventually(
					async () => seenByPeer(),
					(seen) => seen.hand === 6 && seen.deck === start - 7
				);
				await cdp.detach();
				const drawMessages = sent.filter((frame) => frame.includes('"tray"'));
				ok(
					afterFive === 6 && (await deckCount(deck)) === start - 7,
					`5 did not draw five into the hand: hand 1 → ${afterFive}, deck ${await deckCount(deck)}`
				);
				ok(
					remoteFive.hand === 6,
					`the other player never saw the host hold 6 (saw ${remoteFive.hand})`
				);
				ok(
					drawMessages.length >= 1 && drawMessages.length <= 5,
					`drawing 5 sent ${drawMessages.length} hand patches — budget is one per card or fewer ` +
						`(${sent.length} frames in all)`
				);
				ok(await table.connected(), 'the relay dropped the host after drawing 5');

				// ── someone else's deck refuses, out loud ─────────────────────
				const peerDeckAt = await eventually(
					() => table.locate(peerDeck),
					(point) => !!point
				);
				ok(peerDeckAt, "the other player's deck never mounted");
				await table.page.mouse.click(peerDeckAt!.x, peerDeckAt!.y);
				const toastShown = await eventually(
					() =>
						table.page.evaluate(() =>
							document.body.innerText.includes("That deck isn't yours to draw from")
						),
					(shown) => shown
				);
				ok(toastShown, "clicking another player's deck did not say why nothing happened");
				ok(
					(await deckCount(peerDeck)) === 3 && (await hand()).length === 6,
					"clicking another player's deck took a card from it"
				);

				// ── and everything else on the table still answers ────────────
				const onFelt = await table.page.evaluate(
					() => Object.keys(window.__tableplace!.state()?.cards ?? {})[0] ?? ''
				);
				// sideways, toward the middle of the table: it lies in front of the
				// deck, low on screen, and since #214's seat camera both the default
				// drag down and a drag up take it off the felt (most likely into the
				// hand and back onto the deck — not confirmed)
				await assertDraggable(table, onFelt, 'the Shift-drawn card', { dx: -150, dy: 0 }).catch(
					async (error: Error) => {
						throw new Error(
							`${error.message} (hand ${(await hand()).length}, deck ${await deckCount(deck)})`
						);
					}
				);
				assertClean(table, 'after drawing to the hand');
				await table.snap('draw-to-hand');
			} finally {
				await table.close();
				peer.close();
			}
		}
	},
	{
		/**
		 * tableplace-196: `/` on a hovered deck opens the search drawer. A
		 * 100-card deck pages rather than rendering whole; a click takes the named
		 * card into the hand, Shift+click lays one face-up on the felt; closing
		 * shuffles (the other seat sees the wiggle stamp and the counts). A
		 * face-up pile opens from the wheel and closes without a shuffle.
		 */
		name: 'deck search: / opens the drawer, a click takes the named card, close shuffles',
		run: async (context) => {
			const lobby = nextLobby('deck-search');
			const peer = await relayPeer(context.servers.relay, lobby, 'e2e-peer');
			const table = await openTable(context.browser, context.servers, lobby);
			const { page } = table;
			try {
				const peerDeck = 'deck:e2e-peer:0';
				peer.send({
					players: { 'e2e-peer': { id: 'e2e-peer', seat: 1, tray: {} } },
					decks: {
						[peerDeck]: {
							id: peerDeck,
							isFaceUp: false,
							position: [LANE(2)[0], 0.4, LANE(2)[2]],
							rotation: [0, 0, 0],
							cards: ['AS', '2S'].map((code) => ({
								id: `card:e2e-peer:${code}`,
								faceImageUrl: `gen:std52/${code}`
							}))
						}
					}
				});
				// 100 named cards, generic names — the drawer lists them by name
				const deck = await page.evaluate(() => {
					const codes = ['AS', 'KH', 'QD', 'JC'];
					const cards = Array.from({ length: 100 }, (_, i) => ({
						id: `card:search:${i + 1}`,
						name: `Card ${i + 1}`,
						faceImageUrl: `gen:std52/${codes[i % codes.length]}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(window.__tableplace!.actions.addDeck({ cards } as never) ?? '');
				});
				ok(deck, 'the 100-card deck was not created');

				const state = () => page.evaluate(() => window.__tableplace!.state());
				const deckCount = async (id: string) => (await state())?.decks?.[id]?.cards?.length ?? -1;
				const hand = () =>
					page.evaluate(() => {
						const bridge = window.__tableplace!;
						const me = bridge.actions.getMyId();
						return Object.keys((me && bridge.state()?.players?.[me]?.tray) ?? {});
					});
				const hostId = await page.evaluate(() => window.__tableplace!.actions.getMyId());
				const drawerOpen = () =>
					page.evaluate(() => !!document.querySelector('[data-testid="deck-search"]'));
				const drawerCards = () =>
					page.evaluate(() =>
						[...document.querySelectorAll('[data-deck-card]')].map(
							(el) => el.getAttribute('title') ?? ''
						)
					);
				const hover = async (id: string) => {
					const at = await eventually(
						() => table.locate(id),
						(point) => !!point
					);
					ok(at, `${id} never mounted`);
					await page.mouse.move(at!.x, at!.y, { steps: 6 });
					const hovered = await eventually(
						() => page.evaluate(() => window.__tableplace!.drag().isDeckHovered),
						(value) => value === id
					);
					ok(hovered === id, `the pointer is over ${id} but the hovered deck is ${hovered}`);
				};

				ok(
					(await eventually(
						() => deckCount(deck),
						(n) => n === 100
					)) === 100,
					'deck never held 100'
				);
				ok(
					(await eventually(
						async () => peer.state.decks?.[deck]?.cards?.length ?? -1,
						(n) => n === 100
					)) === 100,
					'the other seat never saw the deck'
				);
				ok(
					(await eventually(
						() => deckCount(peerDeck),
						(n) => n === 2
					)) === 2,
					'peer deck never arrived'
				);
				await table.settle(600);

				// ── `/` opens the drawer; 100 cards are paged ─────────────────
				await hover(deck);
				await page.keyboard.press('Slash');
				ok(await eventually(drawerOpen, (open) => open), '/ on a hovered deck opened no drawer');
				const firstPage = await drawerCards();
				ok(
					firstPage.length > 0 && firstPage.length < 100,
					`the drawer rendered ${firstPage.length} cards at once — a 100-card deck must page`
				);
				ok(
					firstPage[0] === 'Card 1',
					`a face-down deck should list by name, first is ${firstPage[0]}`
				);

				// ── page forward, click the named card into the hand ──────────
				const target = 'Card 77';
				for (let i = 0; i < 5 && !(await drawerCards()).includes(target); i++) {
					await page.click('[data-testid="deck-search-next"]');
				}
				ok((await drawerCards()).includes(target), `${target} is on no page of the drawer`);
				const peerShuffledBefore = peer.state.decks?.[deck]?.shuffledAt;
				await page.click(`[data-deck-card="card:search:77"]`);
				const taken = await eventually(hand, (ids) => ids.length === 1);
				ok(taken[0] === 'card:search:77', `the hand holds ${JSON.stringify(taken)}, not ${target}`);
				ok((await deckCount(deck)) === 99, `the deck holds ${await deckCount(deck)}, not 99`);
				const tray = (await state())?.players?.[hostId!]?.tray?.['card:search:77'];
				ok(tray?.name === target, `the card in hand is named ${tray?.name}, not ${target}`);
				ok(
					!(await drawerCards()).includes(target),
					'the drawer still lists the card that was taken'
				);

				// ── filter + Shift+click: face-up on the felt ─────────────────
				await page.type('[data-testid="deck-search-filter"]', 'card 5');
				const filtered = await drawerCards();
				ok(
					filtered.includes('Card 5') && !filtered.includes('Card 6'),
					`filter showed ${filtered.join(', ')}`
				);
				await page.keyboard.down('Shift');
				await page.click(`[data-deck-card="card:search:5"]`);
				await page.keyboard.up('Shift');
				const loose = await eventually(
					async () => (await state())?.cards?.['card:search:5'],
					(card) => !!card
				);
				ok(
					loose?.rotation?.[0] === 0,
					`Shift+click landed the card rotated ${loose?.rotation}, not face-up`
				);
				ok(
					(await deckCount(deck)) === 98 && (await hand()).length === 1,
					'Shift+click went to the hand'
				);

				// ── close: Shuffle is on by default, everyone sees the wiggle ──
				ok(
					await page.evaluate(
						() =>
							(document.querySelector('[data-testid="deck-search-shuffle"]') as HTMLInputElement)
								?.checked
					),
					'Shuffle is not ticked by default'
				);
				await page.keyboard.press('Escape');
				ok(!(await eventually(drawerOpen, (open) => !open)), 'Esc did not close the drawer');
				const shuffledAt = await eventually(
					async () => (await state())?.decks?.[deck]?.shuffledAt,
					(at) => !!at
				);
				ok(shuffledAt, 'closing the drawer did not shuffle');
				const remote = await eventually(
					async () => ({
						shuffledAt: peer.state.decks?.[deck]?.shuffledAt,
						deck: peer.state.decks?.[deck]?.cards?.length ?? -1,
						hand: Object.keys(peer.state.players?.[hostId!]?.tray ?? {}).length
					}),
					(seen) => seen.shuffledAt === shuffledAt && seen.deck === 98 && seen.hand === 1
				);
				ok(
					remote.shuffledAt === shuffledAt && remote.shuffledAt !== peerShuffledBefore,
					`the other seat never saw the shuffle (${remote.shuffledAt})`
				);
				ok(remote.deck === 98 && remote.hand === 1, `the other seat saw ${JSON.stringify(remote)}`);

				// ── a face-up pile: the wheel opens it, no shuffle step ───────
				await page.evaluate((id) => window.__tableplace!.actions.flipDeck(id), deck);
				await eventually(
					async () => (await state())?.decks?.[deck]?.isFaceUp,
					(up) => !!up
				);
				await table.settle(400);
				const wheel = await table.openRadial(deck, { button: 'right' });
				ok(
					wheel.wedges['search'],
					`the deck's wheel has no search wedge: ${wheel.actions.join(', ')}`
				);
				// the button is still held: flick to the wedge and let go
				await page.mouse.move(wheel.wedges['search']!.x, wheel.wedges['search']!.y, { steps: 8 });
				await sleep(120);
				await page.mouse.up({ button: 'right' });
				ok(await eventually(drawerOpen, (open) => open), 'the wheel did not open the drawer');
				ok(
					!(await page.evaluate(
						() => !!document.querySelector('[data-testid="deck-search-shuffle"]')
					)),
					'a face-up pile offered a shuffle'
				);
				await page.click('[data-testid="deck-search-close"]');
				ok(!(await eventually(drawerOpen, (open) => !open)), 'Close did not close the drawer');
				await sleep(300);
				ok(
					(await state())?.decks?.[deck]?.shuffledAt === shuffledAt,
					'closing a face-up pile shuffled it'
				);

				// ── someone else's deck refuses ───────────────────────────────
				await hover(peerDeck);
				await page.keyboard.press('Slash');
				const refused = await eventually(
					() =>
						page.evaluate(() =>
							document.body.innerText.includes("That deck isn't yours to search")
						),
					(shown) => shown
				);
				ok(refused && !(await drawerOpen()), "another player's deck opened for search");

				// ── and the table still answers ───────────────────────────────
				await assertDraggable(table, 'card:search:5', 'the searched-out card', { dx: -150, dy: 0 });
				assertClean(table, 'after searching a deck');
				await table.snap('deck-search');
			} finally {
				await table.close();
				peer.close();
			}
		}
	},
	{
		/**
		 * tableplace-103 × tableplace-145, the composed case: a card drawn INTO
		 * the drag (one continuous gesture off the deck top) released with Alt
		 * held. Two reachable landings:
		 *  - overlapping a resting card near the deck: the noSnap branch must
		 *    keep the pointer's XZ (no square-up) but rest one thickness above
		 *    the card under it — #145's height merge, fed by a card that did
		 *    not exist at pointerdown;
		 *  - back over its own deck: the aimed deck hover is checked BEFORE
		 *    noSnap in resolveDrop, so Alt or not, the card returns onto the
		 *    pile and the count is restored.
		 * (Alt-dropping NEAR the deck slab never height-merges against it:
		 * resolveStack scans cards only, and decks are aimed-at targets, not
		 * proximity stacks — unchanged semantics either side of #145.)
		 */
		name: 'composed: alt-drop of a drag-drawn card — rests on cards, returns to its deck',
		run: (context) =>
			withTable(context, 'deck-alt', async (table) => {
				const CARD_THICKNESS = 0.03;

				// a four-card deck in the clear lane (same berth as the alt-drop spec)
				const deck = await table.page.evaluate(() => {
					const cards = ['AS', 'KH', 'QD', 'JC'].map((code) => ({
						id: `card:std:deckalt-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(
						window.__tableplace!.actions.addDeck({ cards, position: [-2, 0.4, -2] } as never) ?? ''
					);
				});
				await table.settle(1000);

				const deckCount = () =>
					table.page.evaluate(
						(id) => window.__tableplace!.state()?.decks?.[id]?.cards?.length ?? -1,
						deck
					);
				const dragOwner = () => table.page.evaluate(() => window.__tableplace!.drag().isDragging);

				/**
				 * The #103 gesture under #145's modifier: press the deck, cross the
				 * threshold back-to-back with the press (no arm timer can interleave),
				 * confirm the drag arrived owned by a drawn card, walk to `resolveTo`'s
				 * pixel and release — with Alt held for the whole gesture, so the
				 * pointerup carries altKey. Slipped or mis-armed gestures retry 3x.
				 */
				const drawDragAltTo = async (
					resolveTo: () => Promise<{ x: number; y: number } | null>,
					options: { awaitDeckHover?: boolean } = {}
				) => {
					for (let attempt = 0; attempt < 3; attempt++) {
						const from = await table.locate(deck);
						const to = await resolveTo();
						ok(from && to, 'the deck or the release point left the screen');
						await table.page.keyboard.down('Alt');
						try {
							await table.page.mouse.move(from!.x, from!.y);
							await sleep(80);
							await table.page.mouse.down();
							await table.page.mouse.move(from!.x, from!.y - 40);
							const owner = await eventually(dragOwner, (o) => o !== null, 3000);
							if (owner?.startsWith('card:')) {
								for (let step = 1; step <= 8; step++) {
									await table.page.mouse.move(
										from!.x + ((to!.x - from!.x) * step) / 8,
										from!.y - 40 + ((to!.y - (from!.y - 40)) * step) / 8
									);
									await sleep(30);
								}
								if (options.awaitDeckHover) {
									// the landing under test is the aimed deck target: assert
									// the hover ARRIVED before releasing, so a slipped enter
									// reads as its own failure and not as a wrong landing
									const hovered = await eventually(
										() => table.page.evaluate(() => window.__tableplace!.drag().isDeckHovered),
										(id) => id === deck,
										3000
									);
									ok(
										hovered === deck,
										`the deck never became the hover target before release — ` +
											`isDeckHovered is ${JSON.stringify(hovered)}`
									);
								}
								await sleep(150);
								await table.page.mouse.up();
								return owner;
							}
							await table.page.mouse.up(); // slipped or spuriously armed
						} finally {
							await table.page.keyboard.up('Alt');
						}
						await table.settle(900);
					}
					throw new Error(
						'the drag-off gesture never handed the drag to a drawn card in 3 attempts'
					);
				};

				// park a resting card on bare felt via the plain action (this phase is
				// #145's precondition, not what is under test)
				const underId = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					deck
				);
				ok(!!underId, 'nothing came off the top of the deck');
				await table.settle(1500);
				await table.dragTo(underId, -4, 1);
				const under = await eventually(
					() => table.positionOf(underId),
					(p) => !!p && Math.hypot((p[0] ?? 9) - -4, (p[2] ?? 9) - 1) < 1.0
				);
				ok(!!under, `the resting card never parked: ${JSON.stringify(under)}`);

				// ── landing 1: Alt-release overlapping the parked card ────────
				const countBefore = await deckCount();
				const overlap = await drawDragAltTo(() =>
					table.page.evaluate(
						(x, z) => window.__tableplace!.project([x, 0.26, z]),
						under![0]! + 0.5,
						under![2]! + 0.4
					)
				);
				const landed = await eventually(
					() => table.positionOf(overlap),
					(p) => !!p && (p[1] ?? 9) < 1 // committed out of the air
				);
				ok((await deckCount()) === countBefore - 1, `the drag-off draw did not shrink the deck`);
				const apart = planarDistance(under, landed);
				ok(
					!!landed && apart > 0.2 && apart < 1.6,
					`the Alt-drop did not stay at the pointer: ${JSON.stringify(landed)} vs ` +
						`${JSON.stringify(under)} (planar ${apart.toFixed(3)})`
				);
				ok(
					Math.abs((landed![1] ?? 9) - ((under![1] ?? 0) + CARD_THICKNESS)) < 0.005,
					`the drag-drawn card did not rest one thickness above the card under it: ` +
						`${JSON.stringify(landed)} over ${JSON.stringify(under)}`
				);

				// ── landing 2: Alt-release back over its own deck ─────────────
				const countMid = await deckCount();
				const returned = await drawDragAltTo(() => table.locate(deck), { awaitDeckHover: true });
				const backOnPile = await eventually(deckCount, (count) => count === countMid);
				ok(
					backOnPile === countMid,
					`the Alt-release over the deck did not return the card to the pile ` +
						`(${countMid} → ${backOnPile})`
				);
				const stillLoose = await table.positionOf(returned);
				ok(
					!stillLoose,
					`the returned card is still loose on the table: ${JSON.stringify(stillLoose)}`
				);

				await assertDraggable(table, deck, 'deck (after the composed alt-drops)');
				assertClean(table, 'after alt-dropping drag-drawn cards');
				await table.snap('deck-alt');
			})
	},
	{
		/**
		 * tableplace-156: every floating label is the same LabelBadge, and the
		 * restyle must not have changed WHEN one shows or how it reacts. Pinned
		 * here with a real pointer: a bag's count and a deck's card count wear
		 * their badges with no hover anywhere; a plain piece's name badge mounts
		 * under the pointer and unmounts when it leaves. A counter wears none —
		 * since tableplace-191 its dial face prints the value (see the dial spec).
		 */
		name: 'badges: hover-only labels and always-on counts',
		run: (context) =>
			withTable(context, 'badges', async (table) => {
				const deck = await table.seedDeck();
				const counter = await table.spawn('counter', {
					name: 'HP',
					maxValue: 17,
					value: 5,
					position: LANE(0)
				});
				const bag = await table.spawn('bag', { position: LANE(1) });
				const token = await table.spawn('token', { name: 'Guard', position: LANE(2) });
				await table.settle(1500);
				assertClean(table, 'with a counter, a bag and a named token on the table');

				const badge = (id: string) =>
					table.page.evaluate((entityId) => window.__tableplace!.badge(entityId), id);

				// always-on: the pointer has not been near any of these
				for (const [id, label] of [
					[bag, 'the bag'],
					[deck, 'the deck']
				] as const) {
					ok(!!(await badge(id)), `${label} (${id}) has no badge mounted without hover`);
				}

				// hover-only: the plain token wears its name only under the pointer
				ok(!(await badge(token)), 'the plain token mounted a badge with no pointer near it');
				ok(!(await badge(counter)), 'the counter still wears a floating pill over its dial');
				const over = await table.locate(token);
				ok(over, 'the token never mounted — nothing to hover');
				await table.page.mouse.move(over!.x, over!.y);
				const hovered = await eventually(
					() => badge(token),
					(b) => !!b
				);
				ok(!!hovered, 'hovering the token never mounted its name badge');
				// park the pointer on bare felt, well clear of everything
				const felt = await table.page.evaluate(() => window.__tableplace!.project([0, 0.26, 6]));
				ok(felt, 'the felt parking spot projects off-screen');
				await table.page.mouse.move(felt!.x, felt!.y);
				const unhovered = await eventually(
					() => badge(token),
					(b) => !b
				);
				ok(!unhovered, 'the token badge stayed mounted after the pointer left');

				// badges must not have cost the table its raycast
				await assertDraggable(table, counter, 'the counter (wearing its badge)');
				await assertDraggable(table, deck, 'deck (with badges on the table)');
				assertClean(table, 'at the end of the badge suite');

				// the train's visual evidence: bag and deck badges always-on,
				// and the token hovered so its name badge is in the frame too
				const pose = await table.locate(token);
				if (pose) await table.page.mouse.move(pose.x, pose.y);
				await table.snap('badges');
			})
	},
	{
		/**
		 * tableplace-191: a counter reads as a dial. Its top face prints name,
		 * value and `of max`, with the rim arc for value/max — drawn onto a
		 * canvas that is redrawn only when one of those changes. A real click
		 * (counter-input's plain-click −1) must change the PRINTED value, pulse
		 * the face once, and cost exactly one redraw; a counter owned by another
		 * seat prints square to that seat.
		 */
		name: 'counter dial: click changes the printed value, pulses once, faces its seat, honours lock',
		run: (context) =>
			withTable(context, 'dial', async (table) => {
				const deck = await table.seedDeck();
				const counter = await table.spawn('counter', {
					name: 'Health',
					maxValue: 17,
					value: 5,
					radius: 1,
					position: ON_FELT(0)
				});
				const plain = await table.spawn('counter', {
					name: 'Score',
					value: 3,
					radius: 1,
					position: ON_FELT(1),
					ownerId: 'seat1'
				});
				await table.settle(1500);
				assertClean(table, 'with two counter dials on the table');

				const dial = (id: string) =>
					table.page.evaluate((entityId) => window.__tableplace!.dial(entityId), id);

				const first = await dial(counter);
				ok(first, 'the counter drew no dial face');
				ok(
					first!.name === 'Health' && first!.value === 5 && first!.maxValue === 17,
					`the dial printed the wrong thing: ${JSON.stringify(first)}`
				);
				ok(Math.abs(first!.facing) < 0.01, `seat 0's dial does not face seat 0: ${first!.facing}`);
				const other = await dial(plain);
				ok(
					other?.name === 'Score' && other.value === 3,
					`the second dial printed the wrong thing: ${JSON.stringify(other)}`
				);
				ok(
					Math.abs(Math.abs(other!.facing) - Math.PI) < 0.01,
					`seat 1's dial does not face seat 1: ${other!.facing}`
				);

				// frames alone never redraw the canvas
				await table.settle(800);
				const idle = await dial(counter);
				ok(
					idle!.redraws === first!.redraws,
					`the dial redrew with nothing changed: ${first!.redraws} → ${idle!.redraws}`
				);

				// the pulse is instant on the value change, so watch for the kick
				// first — waiting on the value, then looking, could miss it
				const at = await table.locate(counter);
				ok(at, 'the counter never mounted — nothing to click');
				await table.page.mouse.click(at!.x, at!.y);
				const kicked = await eventually(
					() => dial(counter),
					(d) => !!d && d.scale > 1.05,
					5000
				);
				ok(
					!!kicked && kicked.scale > 1.05,
					`the value change never pulsed the dial: ${JSON.stringify(kicked)}`
				);
				const printed = await eventually(
					() => dial(counter),
					(d) => !!d && d.value === 4 && Math.abs(d.scale - 1) < 0.02
				);
				ok(
					printed?.value === 4,
					`the click did not change the printed value to 4: ${JSON.stringify(printed)}`
				);
				ok(
					printed!.redraws === first!.redraws + 1,
					`one value change cost ${printed!.redraws - first!.redraws} redraws`
				);
				ok(
					Math.abs(printed!.scale - 1) < 0.02,
					`the pulse never settled: ${JSON.stringify(printed)}`
				);
				const stored = await table.page.evaluate(
					(id) => window.__tableplace!.state()?.pieces?.[id]?.value ?? null,
					counter
				);
				ok(stored === 4, `the store disagrees with the dial: ${JSON.stringify(stored)}`);

				// locked (tableplace-189): a real drag leaves the dial where it is,
				// a real click still counts, and hovering it shows the lock pill —
				// the dial took over the counter's value badge, not the lock cue
				await table.page.evaluate(
					(id) => window.__tableplace!.actions.setLocked('piece', id, true),
					counter
				);
				const pinnedAt = await table.positionOf(counter);
				await table.dragBy(counter, DRAG.dx, DRAG.dy);
				await table.settle(500);
				const pinnedAfter = await table.positionOf(counter);
				ok(
					planarDistance(pinnedAt, pinnedAfter) < 0.01,
					`the locked counter moved: ${JSON.stringify(pinnedAt)} → ${JSON.stringify(pinnedAfter)}`
				);
				const lifted = await table.page.evaluate(() => window.__tableplace!.drag().isDragging);
				ok(!lifted, `the locked counter was lifted into a drag: ${lifted}`);
				const pinned = await table.locate(counter);
				ok(pinned, 'the locked counter vanished');
				await table.page.mouse.click(pinned!.x, pinned!.y);
				const counted = await eventually(
					() => dial(counter),
					(d) => !!d && d.value === 3
				);
				ok(
					counted?.value === 3,
					`a click on the locked counter did not count: ${JSON.stringify(counted)}`
				);
				const lockPill = await eventually(
					() => table.page.evaluate((id) => window.__tableplace!.badge(id), counter),
					(b) => !!b
				);
				ok(!!lockPill, 'hovering the locked counter shows no lock pill');
				await table.page.evaluate(
					(id) => window.__tableplace!.actions.setLocked('piece', id, false),
					counter
				);

				// the face must not have cost the table its raycast
				await assertDraggable(table, counter, 'the counter dial');
				await assertDraggable(table, deck, 'deck (with counter dials on the table)');
				assertClean(table, 'at the end of the dial suite');
				await table.snap('dial');
			})
	},
	{
		/**
		 * tableplace-161, the wheel itself: a right press that HOLDS STILL opens
		 * the radial menu on the card under it, a flick to a wedge fires exactly
		 * that wedge, and a release in the centre deadzone is a cancel.
		 *
		 * Driven with the real CDP mouse, because everything under test lives
		 * between the pointer and the store: which entity the press claimed, what
		 * angle the release was at, and whether the action took the id it was
		 * pressed with. A store-level test would pass on a build where the wheel
		 * opened on the wrong card.
		 */
		name: 'radial: right-press flick flips the pressed card, deadzone cancels',
		run: (context) =>
			withTable(context, 'radial-card', async (table) => {
				const deck = await table.page.evaluate(() => {
					const cards = ['AS', 'KH'].map((code) => ({
						id: `card:std:radial-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(
						window.__tableplace!.actions.addDeck({ cards, position: [-2, 0.4, -2] } as never) ?? ''
					);
				});
				await table.settle(1000);
				const card = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					deck
				);
				ok(!!card, 'nothing came off the top of the deck');
				await table.settle(1500);
				// park it in the clear lane, well away from the deck and the panes
				await table.dragTo(card, -4, 1);
				await table.settle(900);

				const rotationOf = () =>
					table.page.evaluate(
						(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
						card
					);

				// ── the wheel opens on the card, with the card's own verbs ────
				const wheel = await table.openRadial(card, { button: 'right' });
				ok(
					['flip', 'tap', 'tap-reverse', 'group'].every((slug) => wheel.actions.includes(slug)),
					`the card wheel is missing verbs: ${JSON.stringify(wheel.actions)}`
				);

				// ── flick to Flip and release: that card turns over ───────────
				const before = await rotationOf();
				ok(before, 'the card has no rotation to start from');
				const flip = wheel.wedges.flip!;
				await flickTo(table, flip);
				await table.page.mouse.up({ button: 'right' });
				const flipped = await eventually(rotationOf, (r) => !!r && r[0] !== before![0]);
				ok(
					!!flipped && flipped[0] !== before![0],
					`the flick did not flip the card: ${JSON.stringify(before)} → ${JSON.stringify(flipped)}`
				);
				ok(!(await table.radial()), 'the wheel stayed up after the release fired a wedge');

				// ── and the deadzone release is a cancel ──────────────────────
				const held = await table.openRadial(card, { button: 'right' });
				ok(!!held, 'the wheel did not reopen on the card');
				const centre = await table.locate(card);
				await table.page.mouse.move(centre!.x + 8, centre!.y + 6); // inside the deadzone
				await sleep(120);
				await table.page.mouse.up({ button: 'right' });
				await table.settle();
				ok(!(await table.radial()), 'a deadzone release left the wheel up');
				const unchanged = await rotationOf();
				ok(
					JSON.stringify(unchanged) === JSON.stringify(flipped),
					`a deadzone release changed the card anyway: ${JSON.stringify(flipped)} → ${JSON.stringify(unchanged)}`
				);

				// the wheel must not have cost the table its raycast
				await assertDraggable(table, deck, 'deck (with the radial menu in play)');
				assertClean(table, 'after flicking the card wheel');
				await table.snap('radial-card');
			})
	},
	{
		/**
		 * The sticky half of the opener: a quick right-click leaves the wheel up
		 * to be read and clicked. Escape and a click on bare felt must dismiss it
		 * without firing anything — an accidental right-click has to be free.
		 *
		 * The last section: a piece's right-click is its own wheel (tableplace-187
		 * moved a counter's +1 onto it), and the felt behind it must not answer
		 * for it with a table wheel.
		 */
		name: 'radial: quick right-click sticks, Escape and click-away cancel, pieces get their own',
		run: (context) =>
			withTable(context, 'radial-sticky', async (table) => {
				const deck = await table.page.evaluate(() => {
					const cards = ['AS', 'KH'].map((code) => ({
						id: `card:std:sticky-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back'
					}));
					return String(
						window.__tableplace!.actions.addDeck({ cards, position: [-2, 0.4, -2] } as never) ?? ''
					);
				});
				await table.settle(1000);
				const card = await table.page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					deck
				);
				ok(!!card, 'nothing came off the top of the deck');
				await table.settle(1500);
				await table.dragTo(card, -4, 1);
				await table.settle(900);

				const rotationOf = () =>
					table.page.evaluate(
						(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
						card
					);
				const at = await table.locate(card);
				ok(at, 'the card never mounted — nothing to right-click');

				// ── a quick right-click leaves the wheel up ───────────────────
				const stickAt = async (point: { x: number; y: number }) => {
					await table.page.mouse.click(point.x, point.y, { button: 'right' });
					const open = await eventually(
						() => table.radial(),
						(wheel) => !!wheel
					);
					ok(!!open, 'a quick right-click did not leave the wheel up');
					return open!;
				};
				const stick = () => stickAt(at!);

				const before = await rotationOf();
				await stick();
				await table.page.keyboard.press('Escape');
				await table.settle(400);
				ok(!(await table.radial()), 'Escape did not dismiss the sticky wheel');
				ok(
					JSON.stringify(await rotationOf()) === JSON.stringify(before),
					'Escape fired a wedge on the way out'
				);

				// ── click-away on bare felt: same, no action ──────────────────
				await stick();
				const felt = await table.page.evaluate(() => window.__tableplace!.project([6, 0.26, 4]));
				ok(felt, 'the felt click-away spot projects off-screen');
				await table.page.mouse.click(felt!.x, felt!.y);
				await table.settle(400);
				ok(!(await table.radial()), 'clicking away did not dismiss the sticky wheel');
				ok(
					JSON.stringify(await rotationOf()) === JSON.stringify(before),
					'clicking away fired a wedge'
				);

				// ── clicking a wedge fires exactly it ─────────────────────────
				const wheel = await stick();
				const tap = wheel.wedges.tap!;
				await table.page.mouse.click(tap.x, tap.y);
				const tapped = await eventually(rotationOf, (r) => !!r && r[2] !== before![2]);
				ok(
					!!tapped && Math.abs((tapped[2] ?? 0) - (before![2] ?? 0)) === 90,
					`clicking the Tap wedge did not turn the card a quarter: ${JSON.stringify(before)} → ${JSON.stringify(tapped)}`
				);
				ok(!(await table.radial()), 'the wheel stayed up after a wedge was clicked');

				// ── the felt answers the right button and nothing else ───────
				// A press reaches bare felt either because it was aimed there or
				// because it MISSED what it was aimed at — and on a stalled
				// renderer a grab misses routinely, mid-drag. So a left hold here
				// must produce no wheel at all: the left button on felt is an
				// orbit, and the gesture it would interrupt is somebody's drag.
				await table.page.mouse.move(felt!.x, felt!.y);
				await table.page.mouse.down();
				await sleep(1400); // well past every hold this app has
				const onLeftHold = await table.radial();
				await table.page.mouse.up();
				await table.settle(400);
				ok(!onLeftHold, 'a left press-and-hold on bare felt opened a wheel');
				// …while the right button still reaches the table's own verbs
				const feltWheel = await stickAt(felt!);
				ok(
					feltWheel.actions.includes('reset-view'),
					`the felt wheel is missing its verbs: ${JSON.stringify(feltWheel.actions)}`
				);
				await table.page.keyboard.press('Escape');
				await table.settle(300);
				ok(!(await table.radial()), 'the felt wheel would not dismiss');

				// ── a piece's right-click is ITS wheel, never the felt's ──────
				const counter = await table.spawn('counter', {
					name: 'HP',
					maxValue: 17,
					value: 5,
					position: LANE(2)
				});
				await table.settle(1200);
				const over = await table.locate(counter);
				ok(over, 'the counter never mounted');
				await table.page.mouse.move(over!.x, over!.y);
				await table.settle(300); // let the hover register
				const counterWheel = await stickAt(over!);
				ok(
					counterWheel.actions.includes('count-up') && !counterWheel.actions.includes('reset-view'),
					`right-clicking a counter did not open the counter's own wheel: ${JSON.stringify(counterWheel.actions)}`
				);
				const valueOf = () =>
					table.page.evaluate(
						(id) => window.__tableplace!.state()?.pieces?.[id]?.value ?? null,
						counter
					);
				ok((await valueOf()) === 5, 'the right-click itself changed the counter');
				// +1 used to be the right-click itself; it is a wedge now
				await table.page.mouse.click(
					counterWheel.wedges['count-up']!.x,
					counterWheel.wedges['count-up']!.y
				);
				const healed = await eventually(valueOf, (value) => value === 6);
				ok(healed === 6, `the counter's +1 wedge did not heal it: ${JSON.stringify(healed)}`);

				await assertDraggable(table, deck, 'deck (after the sticky wheel)');
				assertClean(table, 'after the sticky wheel suite');
				await table.snap('radial-sticky');
			})
	},
	{
		/**
		 * tableplace-187: pieces open the same wheel as cards and decks, from the
		 * verb registry, and every wedge prints its key — the wheel is how you
		 * learn you no longer need it. The two piece menus it replaced are gone,
		 * so this is the only way to reach a piece's verbs by pointer.
		 *
		 * The spine is the one every spec shares: after a piece has been pressed,
		 * held, flicked and clicked, the table still raycasts and still drags.
		 */
		name: 'radial: a multi-state piece opens the wheel, prints its keys and cycles its state',
		run: (context) =>
			withTable(context, 'radial-piece', async (table) => {
				const deck = await table.seedDeck([-4, 0.4, -2]);
				const tile = await table.spawn('token', {
					name: 'Tile',
					position: LANE(1),
					states: [
						{ face: 'gen:std52/AS', name: 'one' },
						{ face: 'gen:std52/KH', name: 'two' },
						{ face: 'gen:std52/QD', name: 'three' }
					]
				});
				await table.settle(1500);
				const stateOf = () =>
					table.page.evaluate((id) => window.__tableplace!.state()?.pieces?.[id]?.state ?? 0, tile);
				const positionOf = () =>
					table.page.evaluate(
						(id) => JSON.stringify(window.__tableplace!.state()?.pieces?.[id]?.position ?? null),
						tile
					);
				const printedKeys = () =>
					table.page.evaluate(() =>
						Object.fromEntries(
							[...document.querySelectorAll('[data-radial-action]')].map((wedge) => [
								wedge.getAttribute('data-radial-action'),
								wedge.querySelector('[data-radial-key]')?.textContent?.trim() ?? null
							])
						)
					);
				ok((await stateOf()) === 0, 'the tile did not start on its first state');

				// ── right press and hold: the piece's wheel, keys printed ─────
				const wheel = await table.openRadial(tile, { button: 'right' });
				const keys = await printedKeys();
				ok(
					keys['state-next'] === 'X' && keys['state-prev'] === 'Shift + X',
					`the piece wheel does not print its keys: ${JSON.stringify(keys)}`
				);
				ok(
					!wheel.actions.includes('reset-view'),
					`the felt answered a press on the piece: ${JSON.stringify(wheel.actions)}`
				);
				// ── flick to Next state and release: the state cycles ─────────
				await flickTo(table, wheel.wedges['state-next']!);
				await table.page.mouse.up({ button: 'right' });
				const next = await eventually(stateOf, (state) => state === 1);
				ok(next === 1, `the Next state wedge did not cycle the tile: ${next}`);
				ok(!(await table.radial()), 'the wheel stayed up after the release fired a wedge');

				// ── left press and hold: the same wheel, and nothing lifts ────
				const before = await positionOf();
				const held = await table.openRadial(tile, { button: 'left', timeoutMs: 8000 });
				ok(held.actions.includes('state-next'), 'a left hold did not open the piece wheel');
				ok(
					(await positionOf()) === before,
					'the hold lifted the tile as well as opening its wheel'
				);
				await flickTo(table, held.wedges['state-next']!);
				await table.page.mouse.up();
				const third = await eventually(stateOf, (state) => state === 2);
				ok(third === 2, `the held wheel's Next state did not cycle the tile: ${third}`);

				// ── quick right-click: sticky wheel, click Previous state ─────
				const at = await table.locate(tile);
				ok(at, 'the tile moved off screen');
				await table.page.mouse.click(at!.x, at!.y, { button: 'right' });
				const sticky = await eventually(
					() => table.radial(),
					(open) => !!open
				);
				ok(!!sticky, 'a quick right-click on the tile did not leave its wheel up');
				await table.page.mouse.click(
					sticky!.wedges['state-prev']!.x,
					sticky!.wedges['state-prev']!.y
				);
				const back = await eventually(stateOf, (state) => state === 1);
				ok(back === 1, `clicking Previous state did not step the tile back: ${back}`);
				ok(!(await table.radial()), 'the sticky wheel stayed up after its wedge was clicked');

				await assertDraggable(table, tile, 'multi-state tile (after its wheel)');
				await assertDraggable(table, deck, 'deck (after a piece wheel)');
				assertClean(table, 'after the piece wheel');
				await table.snap('radial-piece');
			})
	},
	{
		/**
		 * The deck, where the wheel had to fit around a gesture that was already
		 * there: tableplace-103 gave hold-then-travel to the pile move, so the
		 * wheel now owns the long press outright and the pile move is a wedge on
		 * it. Both halves are pinned here — travel still draws into the drag and
		 * never opens a wheel; the hold opens one and draws nothing.
		 *
		 * The last section is the ticket's sharpest promise: a wedge acts on the
		 * deck the press LANDED on, even though the flick has by then carried the
		 * pointer onto a different deck. An option that fell back to the hover
		 * store would draw from the wrong pile.
		 */
		name: 'radial: deck long-press opens the wheel, travel still drags, wedges hit the pressed deck',
		run: (context) =>
			withTable(context, 'radial-deck', async (table) => {
				const build = (slug: string, position: [number, number, number]) =>
					table.page.evaluate(
						(tag, at) => {
							const cards = ['AS', 'KH', 'QD', 'JC', '10S'].map((code) => ({
								id: `card:std:${tag}-${code}`,
								faceImageUrl: `gen:std52/${code}`,
								backImageUrl: 'gen:std52/back'
							}));
							return String(
								window.__tableplace!.actions.addDeck({
									cards,
									position: at as [number, number, number]
								} as never) ?? ''
							);
						},
						slug,
						position
					);

				// pressed deck below, second deck three units UP-SCREEN of it (the
				// seat-0 camera looks from the +Z edge, so -Z is up on screen) — which
				// is exactly where the "Draw 1" wedge sits
				const pressed = await build('a', [-4, 0.4, 1]);
				const other = await build('b', [-4, 0.4, -2]);
				await table.settle(1200);

				const countOf = (id: string) =>
					table.page.evaluate(
						(deckId) => window.__tableplace!.state()?.decks?.[deckId]?.cards?.length ?? -1,
						id
					);
				const dragOwner = () => table.page.evaluate(() => window.__tableplace!.drag().isDragging);

				// ── travel, no hold: the #103 draw-into-the-drag, no wheel ────
				const startCount = await countOf(pressed);
				const startAt = await table.positionOf(pressed);
				const from = await table.locate(pressed);
				ok(from, 'the pressed deck never mounted');
				await table.page.mouse.move(from!.x, from!.y);
				await sleep(80);
				await table.page.mouse.down();
				await table.page.mouse.move(from!.x, from!.y - 40);
				const owner = await eventually(dragOwner, (id) => id !== null, 3000);
				ok(
					!(await table.radial()),
					'a press that travelled immediately opened the wheel instead of dragging'
				);
				for (let step = 1; step <= 5; step++) {
					await table.page.mouse.move(from!.x, from!.y - 40 - step * 16);
					await sleep(30);
				}
				await table.page.mouse.up();
				await table.settle(600);
				ok(
					owner?.startsWith('card:'),
					`travel off the deck did not draw a card into the drag: ${JSON.stringify(owner)}`
				);
				ok(!(await table.radial()), 'the wheel appeared during a deck drag');

				// ── the long hold: the wheel, and nothing else ────────────────
				const heldCount = await countOf(pressed);
				const wheel = await table.openRadial(pressed, { button: 'left', timeoutMs: 8000 });
				ok(
					['draw', 'flip', 'shuffle', 'ungroup', 'move'].every((slug) =>
						wheel.actions.includes(slug)
					),
					`the deck wheel is missing verbs: ${JSON.stringify(wheel.actions)}`
				);
				await table.page.mouse.up(); // released in the deadzone: a cancel
				await table.settle(700);
				ok(!(await table.radial()), 'the deck wheel stayed up after a deadzone release');
				ok(
					(await countOf(pressed)) === heldCount,
					'a long press that opened the wheel drew a card anyway'
				);
				const stillThere = await table.positionOf(pressed);
				ok(
					planarDistance(startAt, stillThere) < 0.05,
					`the long press moved the pile: ${JSON.stringify(startAt)} → ${JSON.stringify(stillThere)}`
				);
				ok(startCount > heldCount, 'the earlier drag-off draw never happened');

				// ── a wedge acts on the PRESSED deck, not the hovered one ─────
				const beforePressed = await countOf(pressed);
				const beforeOther = await countOf(other);
				await table.openRadial(pressed, { button: 'right' });
				const onOther = await table.locate(other);
				ok(onOther, 'the second deck left the screen');
				// flick up-screen onto the other deck — it becomes the hover target,
				// and the release still has to draw from the deck we pressed
				await flickTo(table, onOther!);
				const hovered = await eventually(
					() => table.page.evaluate(() => window.__tableplace!.drag().isDeckHovered),
					(id) => id === other,
					3000
				);
				ok(
					hovered === other,
					`the flick never reached the other deck — hover is ${JSON.stringify(hovered)}, ` +
						`so this run would not have proved anything`
				);
				await table.page.mouse.up({ button: 'right' });
				const drawn = await eventually(
					() => countOf(pressed),
					(n) => n === beforePressed - 1
				);
				ok(
					drawn === beforePressed - 1,
					`the wedge did not draw from the pressed deck (${beforePressed} → ${drawn})`
				);
				ok(
					(await countOf(other)) === beforeOther,
					'the wedge drew from the deck under the pointer instead of the pressed one'
				);

				await assertDraggable(table, other, 'the second deck (after the wheel)');
				assertClean(table, 'after the deck wheel suite');
				await table.snap('radial-deck');
			})
	},
	{
		/**
		 * Camera bindings: a right drag that never held still is an ORBIT since
		 * tableplace-202 gave the felt's left-drag to the selection box (the
		 * wheel still lets go of it), a middle drag is the pan, and W/A/S/D pan
		 * screen-relatively while held.
		 *
		 * The last two assertions are the ones with teeth. Typing must pan
		 * nothing — every table route binds bare letters, and a lobby name with a
		 * W in it would otherwise walk the camera off the felt. And a long held
		 * pan must leave the socket UP: the relay disconnects (it does not drop)
		 * over ~7 msg/s, so a pan that broadcast per frame instead of riding
		 * cameraStream's throttle would end the session outright.
		 */
		name: 'camera: right quick-drag orbits, middle-drag pans, WASD pans screen-relatively, typing pans nothing',
		run: (context) =>
			withTable(context, 'camera-pan', async (table) => {
				const deck = await table.seedDeck();
				await table.settle(1000);
				const eye = async () => (await table.cameraPose())!.position;
				const look = async () => (await table.cameraPose())!.direction;
				const turned = (a: number[], b: number[]) =>
					Math.hypot(...a.map((value, i) => value - (b[i] ?? 0)));
				// C fits the content from the seat's angled view: wherever that is, it is
				// where C has to bring the camera back to after all the panning below
				await table.page.keyboard.press('KeyC');
				await settleCamera(table);
				const deckEye = await eye();

				const felt = await table.page.evaluate(() => window.__tableplace!.project([0, 0.26, 4]));
				ok(felt, 'the felt press point projects off-screen');
				const sweep = async (button: 'right' | 'middle') => {
					await table.page.mouse.move(felt!.x, felt!.y);
					await sleep(60);
					await table.page.mouse.down({ button });
					// travel immediately: no still hold, so nothing may open
					for (let step = 1; step <= 10; step++) {
						await table.page.mouse.move(felt!.x + step * 18, felt!.y);
						await sleep(20);
					}
					const wheel = await table.radial();
					await table.page.mouse.up({ button });
					await table.settle(500);
					return wheel;
				};

				// ── a middle drag pans: the eye moves, the view does not turn ──
				// First, from C's settled pose. An orbit's damping tail sits unapplied on
				// an on-demand renderer until the next update, so measured after the
				// orbit below, the pan's first frame would read as a turn.
				const beforePan = await eye();
				const lookBeforePan = await look();
				await sweep('middle');
				const afterPan = await eye();
				ok(
					planarDistance(beforePan, afterPan) > 0.5,
					`the middle drag did not pan the camera: ${JSON.stringify(beforePan)} → ${JSON.stringify(afterPan)}`
				);
				const lookAfterPan = await look();
				ok(
					turned(lookBeforePan, lookAfterPan) < 0.01,
					`the middle drag turned the camera — that is an orbit, not a pan: ${JSON.stringify(lookBeforePan)} → ${JSON.stringify(lookAfterPan)} (eye ${JSON.stringify(beforePan)} → ${JSON.stringify(afterPan)})`
				);

				// ── a right drag that never holds still is an orbit ───────────
				const beforeOrbit = await look();
				ok(!(await sweep('right')), 'a right quick-drag opened the wheel instead of orbiting');
				const afterOrbit = await look();
				ok(
					turned(beforeOrbit, afterOrbit) > 0.05,
					`the right quick-drag did not orbit the camera: ${JSON.stringify(beforeOrbit)} → ${JSON.stringify(afterOrbit)}`
				);

				// back to the seat's view: W and D below are measured along its axes
				await table.page.keyboard.press('KeyC');
				await settleCamera(table);

				// ── W pans away from the viewer, D to the right ───────────────
				// Held until the page has RENDERED the pan, not for a fixed 900ms of
				// runner clock: under software GL one frame can outlast the hold, and
				// then keydown and keyup both land before the next frame — the held
				// key task never sees the key and the eye does not move at all (seen
				// on CI and reproduced on origin/feature/table-feel). A pan that is
				// really broken still fails, at the deadline instead of at 900ms.
				const holdPan = async (code: 'KeyW' | 'KeyD', moved: (at: number[]) => boolean) => {
					await table.page.keyboard.down(code);
					const deadline = Date.now() + 8000;
					try {
						await sleep(900);
						while (Date.now() < deadline && !moved(await eye())) await sleep(150);
					} finally {
						await table.page.keyboard.up(code);
					}
					await table.settle(500);
				};
				const beforeKeys = await eye();
				await holdPan('KeyW', (at) => at[2]! < beforeKeys[2]! - 0.5);
				const afterW = await eye();
				ok(
					afterW[2]! < beforeKeys[2]! - 0.5,
					`W did not pan away from the viewer: ${JSON.stringify(beforeKeys)} → ${JSON.stringify(afterW)}`
				);
				await holdPan('KeyD', (at) => at[0]! > afterW[0]! + 0.5);
				const afterD = await eye();
				ok(
					afterD[0]! > afterW[0]! + 0.5,
					`D did not pan to the right: ${JSON.stringify(afterW)} → ${JSON.stringify(afterD)}`
				);

				// ── typing pans nothing ──────────────────────────────────────
				// a real focused field, so the app's own isTyping guard is what is
				// under test rather than a mocked target
				await table.page.evaluate(() => {
					const field = document.createElement('input');
					field.id = 'e2e-typing';
					field.style.cssText = 'position:fixed;top:0;left:0;z-index:9999';
					document.body.appendChild(field);
					field.focus();
				});
				await table.settle(900); // OrbitControls damping is still easing out
				const beforeTyping = await eye();
				await table.page.keyboard.down('KeyW');
				await sleep(800);
				await table.page.keyboard.up('KeyW');
				await table.settle(400);
				const afterTyping = await eye();
				await table.page.evaluate(() => document.getElementById('e2e-typing')?.remove());
				// generous next to a real pan (~15 units in that window) but far
				// tighter than one: what is left here is the damping tail
				ok(
					planarDistance(beforeTyping, afterTyping) < 0.5,
					`typing panned the camera: ${JSON.stringify(beforeTyping)} → ${JSON.stringify(afterTyping)}`
				);

				// ── a long held pan must not disconnect the socket ────────────
				ok(await table.connected(), 'the socket was already down before the long pan');
				await table.page.mouse.move(felt!.x, felt!.y); // focus back on the table
				await table.page.keyboard.down('KeyA');
				await sleep(4000); // ~11 throttled samples; per-frame would be ~240
				await table.page.keyboard.up('KeyA');
				await table.settle(800);
				ok(
					await table.connected(),
					'a four-second held pan closed the lobby socket — the pose stream is bypassing ' +
						"cameraStream's throttle and tripping the relay's rate limit"
				);

				// the table still answers the pointer after all that camera work —
				// from the seat's own view again, which is C's job (a keybind this
				// ticket left alone, and the deck is off-screen without it)
				await table.page.keyboard.press('KeyC');
				await settleCamera(table);
				const home = await eye();
				ok(
					planarDistance(home, deckEye) < 1 && Math.abs(home[1]! - deckEye[1]!) < 0.5,
					`C did not bring the camera home after panning: ${JSON.stringify(home)} vs ${JSON.stringify(deckEye)}`
				);
				await table.dragTo(deck, 0, 0);
				await table.settle(600);
				await assertDraggable(table, deck, 'deck (after panning the camera)');
				assertClean(table, 'after the camera pan suite');
				await table.snap('camera-pan');
			})
	},
	{
		/**
		 * The felt is 60×30 and a player must be able to see all of it: at full
		 * zoom-out every corner projects inside the canvas at 16:10 and 16:9.
		 * Stacked cards ride along so a depth-precision regression at the new
		 * distance shows up as z-fighting in the screenshot.
		 */
		name: 'camera: full zoom-out frames all four felt corners at 16:10 and 16:9',
		run: (context) =>
			withTable(context, 'camera-frame-felt', async (table) => {
				// on the felt's centre: C now fits the *content*, and a deck off-centre
				// would pull the fitted view (and so the zoom-out) off the felt
				await table.seedDeck([0, 0.26, 0]);
				await table.settle(1000);
				for (const [label, width, height] of [
					['16x10', 1280, 800],
					['16x9', 1280, 720]
				] as const) {
					await table.page.setViewport({ width, height });
					await table.page.keyboard.press('KeyC');
					await settleCamera(table);
					await table.page.mouse.move(width / 2, height / 2);
					for (let i = 0; i < 40; i++) await table.page.mouse.wheel({ deltaY: 400 });
					await table.settle(1500);
					const corners = await table.page.evaluate(() =>
						[
							[-30, -15],
							[30, -15],
							[-30, 15],
							[30, 15]
						].map(([x, z]) => window.__tableplace!.project([x, 0.255, z]))
					);
					for (const c of corners) {
						ok(
							c !== null && c.x >= 0 && c.x <= width && c.y >= 0 && c.y <= height,
							`${label}: a felt corner is off-screen at full zoom-out: ${JSON.stringify(corners)}`
						);
					}
					assertClean(table, `after zooming out at ${label}`);
					await table.snap(`camera-frame-felt-${label}`);
				}
			})
	},
	{
		/**
		 * A seat used to open zoomed in on the centre, with its own edge off-screen
		 * (#179). Pieces spread over 40×25 — well past the old 25×16 close-up — and a
		 * fresh join at each common aspect must have every one of them inside the
		 * canvas without a single wheel notch — portrait included. Then C after
		 * moving the camera must refit. Every seat opens on an angled view from its
		 * own side of the table (tableplace-185): seat 0 from +z, seat 1 from −z.
		 */
		name: 'camera: joining and C fit the table content at 16:10, 16:9, 4:3 and 3:4',
		run: async (context) => {
			const lobby = nextLobby('camera-fit-content');
			const host = await openTable(context.browser, context.servers, lobby);
			try {
				const spots: [number, number][] = [
					[-20, -12.5],
					[20, -12.5],
					[-20, 12.5],
					[20, 12.5],
					[0, 0],
					[-20, 0],
					[20, 0]
				];
				for (const [x, z] of spots) await host.spawn('token', { position: [x, PIECE_REST_Y, z] });
				await host.settle(800);
				// the host is seat 0: angled, from the +z edge, looking toward -z
				await host.page.keyboard.press('KeyC');
				await settleCamera(host);
				const hostPose = (await host.cameraPose())!;
				ok(
					hostPose.direction[1]! > -0.9 &&
						hostPose.position[2]! > 5 &&
						hostPose.direction[2]! < -0.3,
					`seat 0 is not an angled view from its own side: ${JSON.stringify(hostPose)}`
				);

				for (const [label, width, height] of [
					['16x10', 1280, 800],
					['16x9', 1280, 720],
					['4x3', 1024, 768],
					['3x4', 768, 1024]
				] as const) {
					const seat = await openTable(context.browser, context.servers, lobby);
					try {
						await seat.page.setViewport({ width, height });
						await seat.page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
						await seat.page.waitForFunction('window.__tableplace?.ready === true', {
							timeout: 60_000
						});
						await seat.settle(1500);
						const project = () =>
							seat.page.evaluate(
								(pts, y) => pts.map(([x, z]) => window.__tableplace!.project([x, y, z])),
								spots,
								PIECE_REST_Y
							);
						const bad = (pts: Awaited<ReturnType<typeof project>>) =>
							pts.filter((c) => c === null || c.x < 0 || c.x > width || c.y < 0 || c.y > height);
						const joined = await project();
						ok(
							bad(joined).length === 0,
							`${label}: pieces are off-screen on join: ${JSON.stringify(joined)}`
						);
						await seat.snap(`camera-fit-join-${label}`);
						// the seat sits at the table: an angled view (tableplace-185), not top-down,
						// from its own side — the spread is centred on z = 0, so a seat-1 eye is
						// well toward -z and looks toward +z (that IS the 180°)
						const mine = await seat.page.evaluate(
							() =>
								window.__tableplace!.state()?.players?.[window.__tableplace!.actions.getMyId()!]
									?.seat
						);
						const pose = (await seat.cameraPose())!;
						ok(
							pose.direction[1]! > -0.9 && pose.direction[1]! < -0.5,
							`${label}: seat ${mine} did not open on an angled view: ${JSON.stringify(pose)}`
						);
						if (mine === 1)
							ok(
								pose.position[2]! < -5 && pose.direction[2]! > 0.3,
								`seat 1 is not looking from its own side: ${JSON.stringify(pose)}`
							);
						if (mine === 0)
							ok(
								pose.position[2]! > 5 && pose.direction[2]! < -0.3,
								`seat 0 is not looking from its own side: ${JSON.stringify(pose)}`
							);

						// C after moving the camera refits (a wheel notch in, then a pan away)
						await seat.page.mouse.move(width / 2, height / 2);
						for (let i = 0; i < 6; i++) await seat.page.mouse.wheel({ deltaY: -400 });
						await seat.page.keyboard.down('KeyD');
						await sleep(400);
						await seat.page.keyboard.up('KeyD');
						await seat.settle(1200);
						ok(
							bad(await project()).length > 0,
							`${label}: the camera did not move — the refit check would prove nothing`
						);
						await seat.page.keyboard.press('KeyC');
						await settleCamera(seat);
						const refit = await project();
						ok(
							bad(refit).length === 0,
							`${label}: C did not refit the content: ${JSON.stringify(refit)}`
						);
						assertClean(seat, `after fitting at ${label}`);
					} finally {
						await seat.close();
					}
				}
				assertClean(host, 'after the fit suite');
			} finally {
				await host.close();
			}
		}
	},
	{
		/**
		 * The camera presets (tableplace-185). The seat view is the default, P goes
		 * top-down and back, Z frames what is under the pointer or — over bare
		 * felt — what you moved last, and a double-click frames what it lands on.
		 *
		 * A preset move is a tween, never a cut: sampled every animation frame it
		 * passes through poses between the two ends. It rides the same throttled
		 * camera stream an orbit does, so counting the page's own `camera` sends
		 * proves it stays ≤ ~3 Hz while it moves and goes silent once it lands.
		 * A wheel notch mid-move cancels it, and under prefers-reduced-motion it
		 * is a cut.
		 */
		name: 'camera: seat view by default, P top-down, Z and double-click focus, tweened',
		run: (context) =>
			withTable(context, 'camera-presets', async (table) => {
				const { page } = table;
				const moved = await table.spawn('token', { position: [8, PIECE_REST_Y, -3] });
				const clicked = await table.spawn('token', { position: [-3, PIECE_REST_Y, 3] });
				await table.settle(1000);
				const pose = async () => (await table.cameraPose())!;
				const topDown = (p: { direction: number[] }) => p.direction[1]! < -0.99;
				const size = page.viewport()!;
				/** how far an entity draws from the canvas centre, as a fraction of the canvas */
				const offCentre = async (id: string) => {
					const at = await table.locate(id);
					ok(at, `${id} is off-screen`);
					return Math.max(
						Math.abs(at!.x - size.width / 2) / size.width,
						Math.abs(at!.y - size.height / 2) / size.height
					);
				};

				// ── the default is the seat view: angled, from seat 0's +z edge ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				const seat = await pose();
				ok(
					!topDown(seat) && seat.direction[1]! < -0.5 && seat.position[2]! > 5,
					`the default view is not an angled seat view: ${JSON.stringify(seat)}`
				);

				// ── P: a tweened move to top-down, sent at most ~3 Hz, then silence ──
				await page.evaluate(() => {
					const w = window as unknown as { __cameraSends?: number[] };
					w.__cameraSends = [];
					const send = WebSocket.prototype.send;
					WebSocket.prototype.send = function (data) {
						(w as unknown as { __allSends: string[] }).__allSends ??= [];
						(w as unknown as { __allSends: string[] }).__allSends.push(String(data).slice(0, 60));
						if (typeof data === 'string' && data.includes('"type":"camera"'))
							w.__cameraSends!.push(performance.now());
						return send.call(this, data);
					};
				});
				// sample the eye's tilt on every animation frame until the move lands
				const tilts = await page.evaluate(
					() =>
						new Promise<number[]>((resolve) => {
							const out: number[] = [];
							window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
							window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP' }));
							const start = performance.now();
							const tick = () => {
								const y = window.__tableplace!.camera()!.direction[1]!;
								out.push(y);
								// until it lands (or gives up): a tween is ≥ 5 frames however slow they are
								if (y > -0.99 && performance.now() - start < 15_000) requestAnimationFrame(tick);
								else resolve(out);
							};
							requestAnimationFrame(tick);
						})
				);
				const between = tilts.filter((y) => y < seat.direction[1]! - 0.02 && y > -0.99);
				ok(
					between.length > 0,
					`P cut instead of tweening — no frame between the seat tilt and top-down: ${JSON.stringify(tilts)}`
				);
				await settleCamera(table);
				const top = await pose();
				ok(topDown(top), `P did not reach top-down: ${JSON.stringify(top)}`);
				// still seat 0's way up: the eye leans (a hair) toward the +z edge
				ok(top.direction[2]! < 0, `top-down lost seat 0's way up: ${JSON.stringify(top)}`);
				const sends = await page.evaluate(() =>
					(window as unknown as { __cameraSends: number[] }).__cameraSends.slice()
				);
				ok(
					sends.length > 0,
					`the tween never reached the camera stream: ${await page.evaluate(() => JSON.stringify((window as unknown as { __allSends?: string[] }).__allSends ?? null))} connected=${await table.connected()}`
				);
				for (let i = 1; i < sends.length; i++)
					ok(
						sends[i]! - sends[i - 1]! > 250,
						`the camera stream outran its ~3 Hz throttle during the tween: ${JSON.stringify(sends)}`
					);
				await table.settle(1500);
				const after = await page.evaluate(
					() => (window as unknown as { __cameraSends: number[] }).__cameraSends.length
				);
				ok(
					after === sends.length,
					`the camera stream kept sending after the tween: ${after} vs ${sends.length}`
				);

				// ── P again: back to the seat view ──
				await page.keyboard.press('KeyP');
				await settleCamera(table);
				const back = await pose();
				ok(
					planarDistance(back.position, seat.position) < 1 &&
						Math.abs(back.position[1]! - seat.position[1]!) < 1,
					`P did not come back to the seat view: ${JSON.stringify(back)} vs ${JSON.stringify(seat)}`
				);

				// ── Z over bare felt frames what you moved last ──
				await table.dragTo(moved, 10, -4);
				await table.settle(800);
				const felt = await page.evaluate(() => window.__tableplace!.project([0, 0.26, 6]));
				ok(felt, 'the bare felt point projects off-screen');
				await page.mouse.move(felt!.x, felt!.y);
				await table.settle(300);
				const before = await offCentre(moved);
				await page.keyboard.press('KeyZ');
				await settleCamera(table);
				const focused = await pose();
				ok(
					(await offCentre(moved)) < 0.08 && (await offCentre(moved)) < before,
					`Z did not frame the last moved token (off centre ${before} → ${await offCentre(moved)}; ` +
						`token at ${JSON.stringify(await table.positionOf(moved))}, pointer over ` +
						`${JSON.stringify(await table.hits(felt!))} / ${await table.elementAt(felt!)})`
				);
				ok(!topDown(focused), 'Z from the seat view should keep its angle');

				// ── double-click frames what it lands on ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				const target = await table.locate(clicked);
				ok(target, 'the token to double-click projects off-screen');
				await page.mouse.move(target!.x, target!.y);
				await table.settle(300);
				// clear of the HUD panes, or the clicks land on a pane button instead
				ok(
					(await table.elementAt(target!)).startsWith('canvas') &&
						(await table.hits(target!)).length > 0,
					`the token to double-click is under a HUD pane: ${await table.elementAt(target!)}`
				);
				await page.mouse.click(target!.x, target!.y, { count: 2 });
				await table.settle(300);
				await settleCamera(table);
				ok(
					(await offCentre(clicked)) < 0.08,
					`double-click did not frame the token (off centre ${await offCentre(clicked)})`
				);

				// ── Z over a hovered thing frames that one, not the last moved ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				const hover = await table.locate(clicked);
				await page.mouse.move(hover!.x, hover!.y);
				await table.settle(300);
				await page.keyboard.press('KeyZ');
				await settleCamera(table);
				ok(
					(await offCentre(clicked)) < 0.08,
					`Z over a token did not frame it (off centre ${await offCentre(clicked)})`
				);

				// ── a wheel notch mid-move cancels the preset ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				// a real notch over the felt, straight behind the key: a move is at least
				// five frames long (TableCamera's per-frame step cap), so it lands mid-move
				await page.mouse.move(felt!.x, felt!.y);
				await page.keyboard.press('KeyP');
				await page.mouse.wheel({ deltaY: -100 });
				await table.settle(300);
				await settleCamera(table);
				const cancelled = await pose();
				ok(!topDown(cancelled), `a wheel notch did not cancel P: ${JSON.stringify(cancelled)}`);

				// ── prefers-reduced-motion: a cut, there on the very next task ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
				try {
					const cut = await page.evaluate(
						() =>
							new Promise<number>((resolve) => {
								window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
								window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP' }));
								setTimeout(() => resolve(window.__tableplace!.camera()!.direction[1]!), 0);
							})
					);
					ok(cut < -0.99, `under reduced motion P did not cut straight to top-down: ${cut}`);
				} finally {
					await page.emulateMediaFeatures([]);
				}

				// ── and the table still answers the pointer after all of it ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				await assertDraggable(table, clicked, 'token (after the camera presets)');
				assertClean(table, 'after the camera presets');
				await table.snap('camera-presets');
			})
	},
	{
		// acceptance criterion 4: one table carrying all four at once
		name: 'mixed table: deck + die + bag + multi-state piece',
		run: (context) =>
			withTable(context, 'mixed', async (table) => {
				const deck = await table.seedDeck();
				const die = await table.spawn('die', { sides: 10, position: LANE(0) });
				const bag = await table.spawn('bag', { position: LANE(1) });
				const token = await table.spawn('token', {
					position: LANE(2),
					states: [
						{ face: 'gen:std52/AS', name: 'front' },
						{ face: 'gen:std52/KH', name: 'back' }
					]
				});
				await table.settle(1500);
				assertClean(table, 'with a deck, a d10, a bag and a two-state token on the table');

				const entities = [
					[deck, 'deck'],
					[die, 'd10'],
					[bag, 'bag'],
					[token, 'two-state token']
				] as const;
				for (const [id, label] of entities) {
					await assertRenders(table, id, `${label} (mixed table)`);
					await assertDraggable(table, id, `${label} (mixed table)`);
				}

				// the state menu is what a multi-state piece exists for; cycling it
				// must not disturb dispatch either
				await table.page.evaluate(
					(id) => window.__tableplace!.actions.cyclePieceState(id, 1),
					token
				);
				await table.settle();
				// the loop's straight-down drag already walked the deck to the bottom
				// edge; park it back mid-table first, so the liveness drag below has
				// screen left to travel into instead of running off the canvas
				await table.dragTo(deck, 2, -2);
				await table.settle(900);
				await assertDraggable(table, deck, 'deck (after cycling a piece state)');
				assertClean(table, 'at the end of the mixed table');
				await table.snap('mixed');
			})
	},
	{
		/**
		 * tableplace-175: a token or counter with an `imageUrl` drew as the bare
		 * cream disc. The image fetched 200 with CORS, the mesh mounted and
		 * raycast — every structural probe passed — but `ImageMaterial` sizes
		 * itself off a plane's width/height, and on a circle its shader went NaN:
		 * the UVs collapsed to one corner texel, the art's cream background.
		 * Only the drawn pixel shows it, so that is what this reads.
		 *
		 * The art is served cross-origin, with `access-control-allow-origin: *`,
		 * from a host that only this page's request interception answers — the
		 * real-world case (unbrewed's CDN) without leaning on the network.
		 */
		name: 'piece art: a token and a counter draw their cross-origin image',
		run: (context) =>
			withTable(context, 'piece-art', async (table) => {
				const art = await table.page.evaluate(() => {
					const draw = (fill: string) => {
						const canvas = document.createElement('canvas');
						canvas.width = canvas.height = 1200;
						const context = canvas.getContext('2d')!;
						// a medallion on a cream field, like real token art: an image
						// that is one colour edge to edge would pass even when the UVs
						// collapse to a single texel, which is how this bug drew
						context.fillStyle = 'rgb(240, 232, 212)';
						context.fillRect(0, 0, 1200, 1200);
						context.fillStyle = fill;
						context.beginPath();
						context.arc(600, 600, 540, 0, Math.PI * 2);
						context.fill();
						return canvas.toDataURL('image/webp').split(',')[1]!;
					};
					return { blue: draw('rgb(30, 80, 235)'), green: draw('rgb(30, 205, 60)') };
				});
				// another port is another origin — a real cross-origin fetch, answered
				// with the same headers unbrewed's CDN sends. (Not request
				// interception: turning that on stops the table canvas repainting.)
				const host = createServer((request, response) => {
					const name = (request.url ?? '').replace(/^\/|\.webp$/g, '');
					const body = name in art ? art[name as keyof typeof art] : null;
					response.writeHead(body ? 200 : 404, {
						'access-control-allow-origin': '*',
						'content-type': 'image/webp'
					});
					response.end(body ? Buffer.from(body, 'base64') : undefined);
				});
				await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
				const ART = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`;
				try {
					const blue = `${ART}blue.webp`;
					const green = `${ART}green.webp`;

					const pieces = {
						token: await table.spawn('token', { position: ON_FELT(0), radius: 1, imageUrl: blue }),
						sheet: await table.spawn('token', {
							position: ON_FELT(1),
							radius: 1,
							imageUrl: `sheet:${JSON.stringify({ url: blue, cols: 1, rows: 1, index: 0 })}`
						}),
						counter: await table.spawn('counter', {
							position: ON_FELT(2),
							radius: 1,
							imageUrl: blue,
							maxValue: 10
						}),
						states: await table.spawn('token', {
							position: ON_FELT(3),
							radius: 1,
							states: [
								{ face: blue, name: 'front' },
								{ face: green, name: 'back' }
							]
						})
					};
					await table.settle(2000);
					assertClean(table, 'after spawning image-faced pieces');

					const isBlue = ([r, g, b]: number[]) => b! > r! + 60 && b! > g! + 40;
					const isGreen = ([r, g, b]: number[]) => g! > r! + 60 && g! > b! + 60;

					/**
					 * Five points on the far half of the disc's top face (−z draws
					 * toward the top of the screen) and the colour drawn at each. The
					 * near half is out: a counter's value badge rides over it. All but one
					 * must match — a stray sample is a rim or a shadow, not the art.
					 */
					const FACE_POINTS = [
						[0, -0.6],
						[0.35, -0.45],
						[-0.35, -0.45],
						[0.2, -0.75],
						[-0.2, -0.75]
					];
					const assertFace = async (
						id: string,
						label: string,
						colour: string,
						matches: (rgb: number[]) => boolean
					) => {
						const drawn = await eventually(
							async () => {
								const at = await table.positionOf(id);
								ok(at, `${label} (${id}) has no position`);
								const top = at![1]! + PIECE_THICKNESS / 2;
								const points = await table.page.evaluate(
									(x, y, z, offsets) =>
										offsets.map(([dx, dz]) => window.__tableplace!.project([x + dx!, y, z + dz!])),
									at![0]!,
									top,
									at![2]!,
									FACE_POINTS
								);
								ok(
									points.every(Boolean),
									`${label} (${id}) projects off-screen — move it into the camera frame`
								);
								const samples = await table.pixels(points as { x: number; y: number }[]);
								return samples.filter((sample) => sample.onCanvas);
							},
							(samples) => samples.filter((sample) => matches(sample.rgb)).length >= 4
						);
						ok(
							drawn.length >= 4,
							`${label} (${id}) is covered by a HUD pane — only ${drawn.length} of 5 samples reach the canvas`
						);
						ok(
							drawn.filter((sample) => matches(sample.rgb)).length >= 4,
							`${label} (${id}) does not draw its ${colour} image — the disc shows ` +
								`${JSON.stringify(drawn.map((sample) => sample.rgb))} (one flat colour everywhere is the art's corner texel smeared across the disc — the bug)`
						);
					};

					await assertFace(pieces.token, 'a token with a cross-origin imageUrl', 'blue', isBlue);
					await assertFace(pieces.sheet, 'a token with a sheet: imageUrl', 'blue', isBlue);
					await assertFace(pieces.counter, 'a counter with an imageUrl', 'blue', isBlue);
					await assertFace(pieces.states, 'a two-state token (front)', 'blue', isBlue);

					// the face follows the state: flip it and the other image draws
					await table.page.evaluate(
						(id) => window.__tableplace!.actions.cyclePieceState(id, 1),
						pieces.states
					);
					await table.settle(900);
					await assertFace(pieces.states, 'a two-state token (back)', 'green', isGreen);

					await assertDraggable(table, pieces.token, 'an image-faced token');
					assertClean(table, 'at the end of the piece-art table');
					await table.snap('piece-art');
				} finally {
					host.close();
				}
			})
	},
	{
		/**
		 * tableplace-155, the material finish: tokens, counters and pawns are
		 * lacquered chips rather than three.js's dead-matte default (bags stay
		 * cloth), and every image texture — card faces, a map overlay — filters
		 * anisotropically, which is what keeps a board legible at the seat
		 * camera's glancing angle. The screenshot is the side-by-side evidence;
		 * the probes make it a regression check. Spine as ever: nothing else
		 * stops rendering, raycasting or dragging.
		 */
		name: 'finish: chips read glossy, card faces and a map overlay stay sharp at the seat angle',
		run: (context) =>
			withTable(context, 'finish', async (table) => {
				// fine lines and small type on a light field: what blurs first when a
				// board is sampled without anisotropy
				const board = await table.page.evaluate(() => {
					const canvas = document.createElement('canvas');
					canvas.width = canvas.height = 1024;
					const context = canvas.getContext('2d')!;
					context.fillStyle = 'rgb(226, 214, 186)';
					context.fillRect(0, 0, 1024, 1024);
					context.strokeStyle = 'rgb(60, 48, 36)';
					context.lineWidth = 3;
					for (let i = 0; i <= 1024; i += 64) {
						context.beginPath();
						context.moveTo(i, 0);
						context.lineTo(i, 1024);
						context.moveTo(0, i);
						context.lineTo(1024, i);
						context.stroke();
					}
					context.fillStyle = 'rgb(40, 30, 24)';
					context.font = '20px sans-serif';
					for (let row = 0; row < 16; row++) {
						for (let col = 0; col < 16; col++) {
							context.fillText(
								`${String.fromCharCode(65 + col)}${row + 1}`,
								col * 64 + 12,
								row * 64 + 40
							);
						}
					}
					return canvas.toDataURL('image/png').split(',')[1]!;
				});
				// served cross-origin like real board art, not inlined into the lobby state
				const host = createServer((request, response) => {
					const found = request.url === '/board.png';
					response.writeHead(found ? 200 : 404, {
						'access-control-allow-origin': '*',
						'content-type': 'image/png'
					});
					response.end(found ? Buffer.from(board, 'base64') : undefined);
				});
				await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
				const boardUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/board.png`;
				try {
					// far side of the felt from seat 0: the most oblique view of it
					await table.page.evaluate(
						(imageUrl) =>
							window.__tableplace!.addOverlay({
								id: 'overlay:finish',
								position: [0, 0.255, -7],
								rotation: [0, 0, 0],
								imageUrl,
								ratio: 1,
								scale: 14
							}),
						boardUrl
					);
					const deck = await table.seedDeck([-8, 0.26, 2]);
					const pieces = {
						token: await table.spawn('token', { position: ON_FELT(0), color: '#b3372f' }),
						counter: await table.spawn('counter', { position: ON_FELT(1), maxValue: 10 }),
						pawn: await table.spawn('pawn', { position: LANE(2), color: '#2f6fb3' }),
						bag: await table.spawn('bag', { position: LANE(3) })
					};
					await table.settle(2000);
					assertClean(table, 'with a map overlay, a deck and one of each piece kind');

					type Finish = { type: string; roughness: number | null };
					const finishOf = async (id: string) =>
						((await table.describe(id))?.materials ?? []) as Finish[];
					const lit = (materials: Finish[]) =>
						materials.filter((material) => material.roughness !== null);
					for (const kind of ['token', 'counter', 'pawn'] as const) {
						const body = lit(await finishOf(pieces[kind]));
						ok(body.length > 0, `the ${kind} has no lit material to finish`);
						ok(
							body.every((material) => material.roughness! <= 0.5),
							`the ${kind} still renders matte: roughness ${JSON.stringify(body.map((m) => m.roughness))}`
						);
					}
					const cloth = lit(await finishOf(pieces.bag));
					ok(
						cloth.length > 0 && cloth.every((material) => material.roughness! >= 0.7),
						`the bag lost its cloth finish: roughness ${JSON.stringify(cloth.map((m) => m.roughness))}`
					);

					const textures = await eventually(
						() => table.page.evaluate(() => window.__tableplace!.textures()),
						(found) => found.maps.some((map) => map.src === boardUrl) && found.maps.length >= 2
					);
					ok(
						textures.target > 1,
						`textures are built with anisotropy ${textures.target} — the GPU reports none, or the scene never raised it`
					);
					const overlay = textures.maps.find((map) => map.src === boardUrl);
					ok(overlay, `the map overlay never drew its texture: ${JSON.stringify(textures.maps)}`);
					const blurred = textures.maps.filter((map) => map.anisotropy < textures.target);
					ok(
						blurred.length === 0,
						`${blurred.length} image texture(s) filter below anisotropy ${textures.target}: ` +
							JSON.stringify(blurred.map((map) => [map.src.slice(0, 60), map.anisotropy]))
					);

					await assertRenders(table, deck, 'deck (beside the finished pieces)');
					await assertDraggable(table, deck, 'deck (beside the finished pieces)');
					await assertDraggable(table, pieces.token, 'a glossy token');
					assertClean(table, 'at the end of the finish table');
					await table.snap('finish');
				} finally {
					host.close();
				}
			})
	},
	{
		/**
		 * tableplace-154, the room: the table stands in a dark room behind a
		 * wooden rim, and the grid lives on the felt only. Past the rim, every
		 * probe reads the same dark room tone — no grid line runs to the
		 * horizon — and the rim reads as wood, not felt or room. Judged from the
		 * seat view and top-down; the screenshots are the before/after evidence.
		 * Spine as ever: what is on the table still renders and drags.
		 */
		name: 'room: dark backdrop, wooden rim, grid kept on the felt',
		run: (context) =>
			withTable(context, 'room', async (table) => {
				const { page } = table;
				const deck = await table.seedDeck([-6, 0.26, 2]);
				const token = await table.spawn('token', { position: ON_FELT(2), color: '#2f6fb3' });
				await table.settle(1000);
				const size = page.viewport()!;
				await page.mouse.move(size.width / 2, size.height / 2);

				type Sample = { rgb: [number, number, number]; onCanvas: boolean };
				/** the colour at each world point that projects onto bare canvas */
				const sample = async (points: [number, number, number][]) => {
					const screen = await page.evaluate(
						(world) =>
							world.map((w) => window.__tableplace!.project(w as [number, number, number])),
						points
					);
					const inside = screen.filter(
						(p): p is { x: number; y: number } =>
							!!p && p.x > 4 && p.y > 4 && p.x < size.width - 4 && p.y < size.height - 4
					);
					return ((await table.pixels(inside)) as Sample[]).filter((s) => s.onCanvas);
				};
				const RIM_TOP = TABLE_TOP_Y + TABLE_RIM_RISE;
				const RIM_MID_X = TABLE_HALF_X + TABLE_RIM_WIDTH / 2;
				const RIM_MID_Z = TABLE_HALF_Z + TABLE_RIM_WIDTH / 2;

				/** past the rim: one dark tone, no grid lines drawn over it */
				const assertEmptyRoom = (samples: Sample[], view: string) => {
					ok(samples.length >= 2, `${view}: too few room probes land on the canvas`);
					const rgbs = samples.map((s) => s.rgb);
					for (const channel of [0, 1, 2] as const) {
						const values = rgbs.map((rgb) => rgb[channel]);
						ok(
							Math.max(...values) - Math.min(...values) <= 6,
							`${view}: the room past the rim is not one tone (a grid runs past the table?): ${JSON.stringify(rgbs)}`
						);
					}
					ok(
						rgbs.every((rgb) => Math.max(...rgb) < 50),
						`${view}: the room is not dark enough for the felt to pop: ${JSON.stringify(rgbs)}`
					);
				};
				/** the rim: warm wood, lighter than the room, not felt green */
				const assertWood = (samples: Sample[], view: string) => {
					ok(samples.length >= 2, `${view}: too few rim probes land on the canvas`);
					for (const { rgb } of samples) {
						const [r, g, b] = rgb;
						ok(
							r > g && r > b + 12 && r > 45,
							`${view}: the rim does not read as wood: ${JSON.stringify(samples.map((s) => s.rgb))}`
						);
					}
				};

				// ── seat view (the default): the far rim and the room beyond it ──
				await page.keyboard.press('KeyC');
				await settleCamera(table);
				await table.snap('room-seat-fit');
				// C fits the content; the room shows once the seat pulls back
				for (let i = 0; i < 15; i++) await page.mouse.wheel({ deltaY: 400 });
				await settleCamera(table);
				await table.snap('room-seat');
				assertEmptyRoom(
					await sample([
						[-24, TABLE_TOP_Y, -TABLE_HALF_Z - 12],
						[0, TABLE_TOP_Y, -TABLE_HALF_Z - 14],
						[24, TABLE_TOP_Y, -TABLE_HALF_Z - 12],
						[-TABLE_HALF_X - 8, TABLE_TOP_Y, -TABLE_HALF_Z],
						[TABLE_HALF_X + 8, TABLE_TOP_Y, -TABLE_HALF_Z]
					]),
					'seat view'
				);

				// ── top-down: the rim on all four sides, the room to either side ──
				await page.keyboard.press('KeyP');
				await settleCamera(table);
				for (let i = 0; i < 15; i++) await page.mouse.wheel({ deltaY: 400 });
				await settleCamera(table);
				await table.snap('room-top');
				assertWood(
					await sample([
						[-RIM_MID_X, RIM_TOP, 0],
						[RIM_MID_X, RIM_TOP, 0],
						[-10, RIM_TOP, -RIM_MID_Z],
						[10, RIM_TOP, RIM_MID_Z]
					]),
					'top-down'
				);
				// the strip beyond the far rim, between the Decks and Players panes
				assertEmptyRoom(
					await sample([
						[-1, TABLE_TOP_Y, -TABLE_HALF_Z - 3.5],
						[4, TABLE_TOP_Y, -TABLE_HALF_Z - 3.5],
						[9, TABLE_TOP_Y, -TABLE_HALF_Z - 3.5],
						[14, TABLE_TOP_Y, -TABLE_HALF_Z - 3.5]
					]),
					'top-down'
				);

				await assertRenders(table, deck, 'deck (in the room)');
				await assertDraggable(table, deck, 'deck (in the room)');
				await assertDraggable(table, token, 'token (in the room)');
				assertClean(table, 'in the room');
			})
	},
	{
		/**
		 * tableplace-183, the verb registry: /play binds no key of its own any
		 * more — every hotkey is resolved against what is under the REAL pointer
		 * and dispatched through `verbs/keyboard.ts`. Unit tests prove the table
		 * of bindings; this proves the hover the registry reads is the hover the
		 * scene actually produces, with deck-beats-card routing, digit counts,
		 * Shift chords and the ownership gate all live in one browser.
		 */
		name: 'verbs: every hotkey dispatches through the registry at the real pointer',
		run: (context) =>
			withTable(context, 'verbs', async (table) => {
				const page = table.page;
				const [mine, theirs] = await page.evaluate(() => {
					const cards = (tag: string) =>
						['AS', 'KH', 'QD', 'JC', 'TS'].map((code) => ({
							id: `card:std:${tag}-${code}`,
							faceImageUrl: `gen:std52/${code}`,
							backImageUrl: 'gen:std52/back'
						}));
					const actions = window.__tableplace!.actions;
					return [
						String(
							actions.addDeck({ cards: cards('mine'), position: [-2, 0.4, -2] } as never) ?? ''
						),
						String(
							actions.addDeck({
								deckId: 'deck:someone-else:0',
								cards: cards('theirs'),
								position: [2, 0.4, -2]
							} as never) ?? ''
						)
					];
				});
				ok(!!mine && theirs === 'deck:someone-else:0', `decks did not spawn: ${mine}, ${theirs}`);
				const tile = await table.spawn('token', {
					position: ON_FELT(2),
					states: [
						{ face: 'gen:std52/AS', name: 'front' },
						{ face: 'gen:std52/KH', name: 'back' }
					]
				});
				await table.settle(1500);
				const card = await page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					mine
				);
				ok(!!card, 'nothing came off the top of the deck');
				await table.settle(1500);
				await table.dragTo(card, -4, 1);
				await table.settle(900);

				const state = () => page.evaluate(() => window.__tableplace!.state());
				const hover = async (id: string, field: 'isHovered' | 'isDeckHovered' | null) => {
					const at = await table.locate(id);
					ok(at, `${id} is not on screen to hover`);
					await page.mouse.move(at!.x, at!.y, { steps: 6 });
					if (field) {
						const hovered = await eventually(
							() => page.evaluate((f) => window.__tableplace!.drag()[f], field),
							(value) => value === id
						);
						ok(hovered === id, `the pointer is over ${id} but ${field} is ${hovered}`);
					} else await sleep(300);
				};
				const chord = async (code: string, shift = false) => {
					if (shift) await page.keyboard.down('Shift');
					await page.keyboard.press(code as never);
					if (shift) await page.keyboard.up('Shift');
				};

				// ── a card: F flips, T taps, R taps back, Arrow Up lifts ──────
				await hover(card, 'isHovered');
				const cardNow = async () => (await state())?.cards?.[card];
				const before = await cardNow();
				await chord('KeyF');
				const flipped = await eventually(
					cardNow,
					(c) => c?.rotation?.[0] !== before?.rotation?.[0]
				);
				ok(flipped?.rotation?.[0] !== before?.rotation?.[0], 'F did not flip the hovered card');
				await chord('KeyT');
				const tapped = await eventually(
					cardNow,
					(c) => c?.rotation?.[2] !== flipped?.rotation?.[2]
				);
				ok(
					(tapped?.rotation?.[2] ?? 0) - (flipped?.rotation?.[2] ?? 0) === 90,
					`T did not tap the card 90°: ${JSON.stringify(flipped?.rotation)} → ${JSON.stringify(tapped?.rotation)}`
				);
				await chord('KeyR');
				const untapped = await eventually(
					cardNow,
					(c) => c?.rotation?.[2] === flipped?.rotation?.[2]
				);
				ok(untapped?.rotation?.[2] === flipped?.rotation?.[2], 'R did not tap the card back');
				await chord('ArrowUp');
				const lifted = await eventually(
					cardNow,
					(c) => (c?.position?.[1] ?? 0) > (untapped?.position?.[1] ?? 0)
				);
				ok(
					(lifted?.position?.[1] ?? 0) > (untapped?.position?.[1] ?? 0),
					'Arrow Up did not nudge the card higher'
				);

				// ── your deck: 2 draws two, F flips the deck (not a card), Shift+S shuffles
				await hover(mine, 'isDeckHovered');
				const deckNow = async (id: string) => (await state())?.decks?.[id];
				const count = (await deckNow(mine))?.cards?.length ?? 0;
				await chord('Digit2');
				const drawn = await eventually(
					() => deckNow(mine),
					(d) => (d?.cards?.length ?? 0) === count - 2
				);
				ok(
					drawn?.cards?.length === count - 2,
					`2 drew ${count - (drawn?.cards?.length ?? 0)}, not 2`
				);
				await table.settle(900);
				await hover(mine, 'isDeckHovered');
				const faceUp = (await deckNow(mine))?.isFaceUp ?? false;
				const cardRotation = JSON.stringify((await cardNow())?.rotation);
				await chord('KeyF');
				const turned = await eventually(
					() => deckNow(mine),
					(d) => (d?.isFaceUp ?? false) !== faceUp
				);
				ok((turned?.isFaceUp ?? false) !== faceUp, 'F over the deck did not flip the deck');
				ok(
					JSON.stringify((await cardNow())?.rotation) === cardRotation,
					'F over the deck also flipped a card — the deck must take the key'
				);
				await chord('KeyS', true);
				const shuffled = await eventually(
					() => deckNow(mine),
					(d) => !!d?.shuffledAt
				);
				ok(!!shuffled?.shuffledAt, 'Shift+S did not shuffle your own deck');

				// ── someone else's deck: the gate refuses, nothing moves ──────
				await hover(theirs, 'isDeckHovered');
				await chord('KeyS', true);
				await chord('KeyG', true);
				await table.settle(600);
				const other = await deckNow(theirs);
				ok(!!other, "Shift+G spread someone else's deck");
				ok(!other?.shuffledAt, "Shift+S shuffled someone else's deck");

				// ── a two-state piece: X steps its face, Shift+X steps back ───
				await hover(tile, null);
				const face = async () => (await state())?.pieces?.[tile]?.state ?? 0;
				await chord('KeyX');
				const stepped = await eventually(face, (s) => s === 1);
				ok(stepped === 1, `X did not step the hovered piece: state ${stepped}`);
				await chord('KeyX', true);
				const back = await eventually(face, (s) => s === 0);
				ok(back === 0, `Shift+X did not step the piece back: state ${back}`);

				// ── the Keybinds folder is the registry, row for row ──────────
				const rows = await page.evaluate(() =>
					[...document.querySelectorAll('dt')].map((dt) => dt.textContent?.trim() ?? '')
				);
				for (const row of [
					'Flip card',
					'Flip hovered deck',
					'Shuffle hovered deck',
					"Hovered piece's next state"
				])
					ok(rows.includes(row), `Keybinds is missing "${row}": ${JSON.stringify(rows)}`);

				await page.mouse.move(5, 5);
				await assertDraggable(table, mine, 'deck (after driving every verb by key)');
				assertClean(table, 'after driving the verbs by key');
				await table.snap('verbs');
			})
	},
	{
		/**
		 * tableplace-192: the zoomed preview follows whatever is under the
		 * pointer — a hand card, a table card, a deck, a piece — while Space or
		 * Alt is held, and never while something is being dragged.
		 *
		 * The hand card is the case the ticket names: the tray is its own HUD
		 * scene, so this aims through the tray's camera (`locateInHand`), holds
		 * Space with a real keyboard, and asserts the preview mesh's texture IS
		 * that card's face — then reads the pixels back, because a texture that
		 * loaded is not yet a texture that drew.
		 */
		name: 'preview: Space over a hand card zooms its face; Alt, decks, pieces; never mid-drag',
		run: (context) =>
			withTable(context, 'preview', async (table) => {
				const preview = () => table.page.evaluate(() => window.__tableplace!.preview());
				const { deck, hand, loose } = await table.page.evaluate(() => {
					const bridge = window.__tableplace!;
					const named = [
						['AS', 'Ace of Spades'],
						['7C', 'Seven of Clubs'],
						['QH', 'Queen of Hearts']
					].map(([code, name]) => ({
						id: `card:std:preview-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back',
						name
					}));
					const deck = String(
						bridge.actions.addDeck({ cards: named, position: [-4, 0.16, -2] } as never) ?? ''
					);
					// face-down: the top is the END of the array — QH, then 7C
					const hand = bridge.actions.drawFromTop(deck, 1)[0]?.id ?? '';
					const me = bridge.actions.getMyId() ?? '';
					bridge.actions.moveCardToTray(hand, me);
					const loose = bridge.actions.drawFromTop(deck, 1)[0]?.id ?? '';
					bridge.actions.flipCard(loose); // drawn face-down; turn it up
					return { deck, hand, loose };
				});
				ok(deck && hand && loose, `seeding failed: ${JSON.stringify({ deck, hand, loose })}`);
				const token = await table.spawn('token', {
					name: 'Marker',
					position: ON_FELT(2),
					states: [
						{ face: 'gen:std52/KS', name: 'Front' },
						{ face: 'gen:std52/KD', name: 'Back' }
					]
				});
				await table.settle(1500);

				// ── Space over a hand card: its face, its name ─────────────────
				const inHand = await eventually(
					() => table.page.evaluate((id) => window.__tableplace!.locateInHand(id), hand),
					(point) => !!point
				);
				ok(inHand, `the hand card ${hand} never drew in the tray`);
				ok(
					(await table.elementAt(inHand!)).startsWith('canvas'),
					`a HUD pane covers the hand card at ${JSON.stringify(inHand)}: ${await table.elementAt(inHand!)}`
				);
				await table.page.mouse.move(inHand!.x, inHand!.y, { steps: 5 });
				await sleep(300);
				ok((await preview()) === null, 'the preview opened on hover alone, before Space');

				await table.page.keyboard.down('Space');
				const zoomed = await eventually(preview, (p) => !!p && !!p.shown && p.shown === p.url);
				ok(zoomed, 'holding Space over a hand card opened no preview');
				ok(
					zoomed!.id === hand && zoomed!.face === 'gen:std52/QH',
					`the preview shows ${zoomed!.id} (${zoomed!.face}), not the hovered hand card ${hand} (gen:std52/QH)`
				);
				ok(
					zoomed!.shown === zoomed!.url,
					`the preview mesh holds ${String(zoomed!.shown).slice(0, 60)}…, not the hand card's face`
				);
				ok(
					zoomed!.caption === 'Queen of Hearts',
					`the caption reads ${JSON.stringify(zoomed!.caption)}, not the card's name`
				);
				// a card face is white paper; the felt the preview sits over is not.
				// Sampled off-centre so a pip in the middle cannot decide it.
				ok(zoomed!.at, 'the preview has no screen position');
				const { x, y } = zoomed!.at!;
				const samples = await table.pixels([
					{ x: x - 90, y: y - 150 },
					{ x: x + 90, y: y - 150 },
					{ x: x - 90, y: y + 150 },
					{ x: x + 90, y: y + 150 }
				]);
				ok(
					samples.filter((s) => Math.min(...s.rgb) > 170).length >= 3,
					`the preview area does not draw a card face: ${JSON.stringify(samples.map((s) => s.rgb))}`
				);
				await table.snap('preview-hand');
				await table.page.keyboard.up('Space');
				ok(
					(await eventually(preview, (p) => p === null)) === null,
					'releasing Space left the preview open'
				);

				// ── Alt over a face-up table card ───────────────────────────────
				const onTable = await table.locate(loose);
				ok(onTable, `the table card ${loose} never mounted`);
				await table.page.mouse.move(onTable!.x, onTable!.y, { steps: 8 });
				await sleep(300);
				await table.page.keyboard.down('Alt');
				const alt = await eventually(preview, (p) => p?.id === loose);
				ok(
					alt?.id === loose && alt.face === 'gen:std52/7C' && alt.caption === 'Seven of Clubs',
					`Alt over a face-up table card previews ${JSON.stringify(alt)}`
				);
				await table.page.keyboard.up('Alt');
				ok((await eventually(preview, (p) => p === null)) === null, 'releasing Alt left it open');

				// ── face-down deck: its back and its count, never its top card ──
				const deckAt = await table.locate(deck);
				ok(deckAt, 'the deck never mounted');
				await table.page.mouse.move(deckAt!.x, deckAt!.y, { steps: 8 });
				await sleep(300);
				await table.page.keyboard.down('Space');
				const pile = await eventually(preview, (p) => p?.id === deck);
				ok(
					pile?.id === deck && pile.face === 'gen:std52/back' && pile.caption === '1 card',
					`a face-down deck previews ${JSON.stringify(pile)} — expected its back and "1 card"`
				);
				await table.page.keyboard.up('Space');

				// ── a multi-state token: its current face and state name ────────
				const tokenAt = await table.locate(token);
				ok(tokenAt, 'the token never mounted');
				await table.page.mouse.move(tokenAt!.x, tokenAt!.y, { steps: 8 });
				await sleep(300);
				await table.page.keyboard.down('Space');
				const piece = await eventually(preview, (p) => p?.id === token);
				ok(
					piece?.id === token &&
						piece.face === 'gen:std52/KS' &&
						piece.caption === 'Marker — Front',
					`a two-state token previews ${JSON.stringify(piece)}`
				);
				await eventually(preview, (p) => !!p?.shown && p.shown === p.url);
				await table.snap('preview-token');
				await table.page.keyboard.up('Space');
				await eventually(preview, (p) => p === null);

				// ── never while dragging: Space and Alt both stay shut ──────────
				const grab = await table.locate(loose);
				ok(grab, 'the table card vanished');
				await table.page.mouse.move(grab!.x, grab!.y, { steps: 5 });
				await sleep(200);
				await table.page.mouse.down();
				await table.page.mouse.move(grab!.x, grab!.y - 30, { steps: 4 });
				await table.page.mouse.move(grab!.x, grab!.y - 60, { steps: 4 });
				const dragging = await eventually(
					() => table.page.evaluate(() => window.__tableplace!.drag().isDragging),
					(id) => id === loose
				);
				ok(dragging === loose, `the table card never lifted: dragging ${dragging}`);
				await table.page.keyboard.down('Space');
				await table.page.keyboard.down('Alt');
				await sleep(400);
				const midDrag = await preview();
				await table.page.mouse.up();
				await table.page.keyboard.up('Alt');
				await table.page.keyboard.up('Space');
				ok(midDrag === null, `the preview opened mid-drag: ${JSON.stringify(midDrag)}`);

				assertClean(table, 'after previewing hand, table, deck and piece');
			})
	},
	{
		/**
		 * The hint bar (#186): one DOM line, bottom-left, naming what the pointer
		 * can do — read from the verb registry, so hovering a deck must name draw
		 * and shuffle with the keys that really do them. It is read in the same
		 * animation frame as the hover store it follows, it never takes a pointer
		 * event, and it stays clear of the hand tray (the bottom sixth of the
		 * canvas) and the preview (the right half) at 1280x720 and at 400 wide.
		 */
		name: 'hint bar: names the verbs under the pointer, ? lists them all, never in the way',
		run: (context) =>
			withTable(context, 'hint-bar', async (table) => {
				const page = table.page;
				await page.setViewport({ width: 1280, height: 720 });
				const deck = await table.seedDeck([0, 0.26, 0]);
				ok(!!deck, 'the deck did not spawn');
				await table.settle(1500);

				/**
				 * What the bar SHOWS — only the parts on its one visible line; a part
				 * that did not fit wraps out of sight — and the hover store, read
				 * together on one animation frame.
				 */
				const sample = () =>
					page.evaluate(
						() =>
							new Promise<{ text: string; deck: string | null }>((resolve) =>
								requestAnimationFrame(() => {
									const bar = document.querySelector('[data-testid="hint-bar"]');
									const box = bar?.getBoundingClientRect();
									const shown = [...(bar?.children ?? [])].filter((part) => {
										const r = part.getBoundingClientRect();
										return !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
									});
									resolve({
										text: shown
											.map((part) => part.textContent ?? '')
											.join(' ')
											.replace(/\s+/g, ' '),
										deck: window.__tableplace!.drag().isDeckHovered
									});
								})
							)
					);

				// ── nothing hovered: ? and the camera basics ────────────────────
				await page.mouse.move(640, 120);
				await table.settle(400);
				const idle = await sample();
				ok(idle.text.includes('?'), `the idle line does not offer ?: "${idle.text}"`);
				ok(/Orbit/.test(idle.text), `the idle line has no camera basics: "${idle.text}"`);

				// ── hover the deck: the line follows on the same frame ──────────
				const at = await table.locate(deck);
				ok(at, 'the deck is not on screen to hover');
				await page.mouse.move(at!.x, at!.y, { steps: 6 });
				const hovered = await eventually(sample, (s) => s.deck === deck);
				ok(
					hovered.deck === deck,
					`the pointer is over the deck but isDeckHovered is ${hovered.deck}`
				);
				for (const [verb, key] of [
					['Draw', '1 – 9'],
					['Shuffle', 'Shift + S']
				]) {
					ok(
						hovered.text.includes(`${key} ${verb}`),
						`on the frame the deck became hovered the bar read "${hovered.text}", not "${key} ${verb}"`
					);
				}
				ok(hovered.text.startsWith('Deck'), `the bar does not name the deck: "${hovered.text}"`);

				// ── it never steals the pointer ─────────────────────────────────
				const passThrough = await page.evaluate(() => {
					const bar = document.querySelector('[data-testid="hint-bar"]') as HTMLElement;
					const box = bar.getBoundingClientRect();
					const under = document.elementFromPoint(
						box.left + box.width / 2,
						box.top + box.height / 2
					);
					return {
						events: getComputedStyle(bar).pointerEvents,
						underIsBar: !!under && bar.contains(under)
					};
				});
				ok(
					passThrough.events === 'none' && !passThrough.underIsBar,
					`the hint bar can take pointer events: ${JSON.stringify(passThrough)}`
				);

				// ── ? opens the reference, generated from the registry; Esc shuts it
				await page.mouse.move(640, 120);
				await table.settle(300);
				await page.keyboard.down('Shift');
				await page.keyboard.press('Slash');
				await page.keyboard.up('Shift');
				const reference = await eventually(
					() =>
						page.evaluate(
							() => document.querySelector('[data-testid="verb-reference"]')?.textContent ?? ''
						),
					(text) => text.length > 0,
					3000
				);
				for (const row of [
					'Shuffle hovered deck',
					'Flip card',
					'Seat view (reset camera)',
					'Cancel drag'
				]) {
					ok(reference.includes(row), `the ? reference does not list "${row}"`);
				}
				await page.keyboard.press('Escape');
				const closed = await eventually(
					() => page.evaluate(() => !document.querySelector('[data-testid="verb-reference"]')),
					(gone) => gone,
					3000
				);
				ok(closed, 'Esc did not close the ? reference');

				// ── clear of the tray and the preview, wide and narrow ──────────
				for (const [label, width, height] of [
					['1280x720', 1280, 720],
					['400w', 400, 800]
				] as const) {
					await page.setViewport({ width, height });
					await page.mouse.move(width / 2, 60);
					await table.settle(600);
					const box = await page.evaluate(() => {
						const bar = document.querySelector('[data-testid="hint-bar"]');
						const r = bar?.getBoundingClientRect();
						return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
					});
					ok(box, `${label}: the hint bar is not on the page`);
					// HUDTrayScene: the tray is the bottom sixth of the canvas;
					// HUDPreviewScene: the art is fitted into the right half
					ok(
						box!.bottom <= (height * 5) / 6 && box!.top >= 0,
						`${label}: the hint bar overlaps the hand tray: ${JSON.stringify(box)}`
					);
					ok(
						box!.right <= width / 2 && box!.left >= 0,
						`${label}: the hint bar reaches into the preview's half: ${JSON.stringify(box)}`
					);
					await table.snap(`hint-bar-${label}`);
				}

				assertClean(table, 'after hovering, opening ? and resizing');
			})
	},
	{
		/**
		 * Lock (tableplace-189): L over a piece pins it, the pin syncs to a
		 * second client, and a real drag at it then moves nothing — it toasts the
		 * key instead — while everything else on the table still drags. L again
		 * frees it, on both clients, and it drags like any other piece.
		 */
		name: 'lock: L pins a piece in place, the pin syncs, a drag leaves it where it was',
		run: async (context) => {
			const lobby = nextLobby('lock');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				const page = table.page;
				const deck = await table.seedDeck();
				const token = await table.spawn('token', { name: 'Board', position: LANE(0) });
				await table.settle(1500);

				const lockedOn = (t: Table) =>
					t.page.evaluate(
						(id) => window.__tableplace!.state()?.pieces?.[id]?.locked === true,
						token
					);
				/** hover the piece with the real mouse, then press L — the player's gesture */
				const pressL = async () => {
					const at = await table.locate(token);
					ok(at, 'the token is not on screen to hover');
					await page.mouse.move(at!.x, at!.y, { steps: 6 });
					await table.settle(300);
					await page.keyboard.press('KeyL');
				};

				// ── L pins it ───────────────────────────────────────────────────
				await pressL();
				ok(
					await eventually(
						() => lockedOn(table),
						(on) => on,
						3000
					),
					'L over the token did not lock it'
				);
				const hint = await page.evaluate(
					() => document.querySelector('[data-testid="hint-bar"]')?.textContent ?? ''
				);
				ok(/locked/.test(hint), `the hint bar does not say the token is locked: "${hint}"`);
				ok(/Unlock/.test(hint), `the hint bar does not offer L to unlock: "${hint}"`);

				// ── a real drag at it moves nothing, and says why ───────────────
				// the toast is short (it should be) and a loaded runner can spend
				// longer than its life inside dragBy, so watch for it from the start
				await page.evaluate(() => {
					const seen = window as unknown as { __lockToast?: boolean };
					seen.__lockToast = false;
					new MutationObserver(() => {
						if (document.body.textContent?.includes('press L to unlock')) seen.__lockToast = true;
					}).observe(document.body, { subtree: true, childList: true, characterData: true });
				});
				const before = await table.positionOf(token);
				await table.dragBy(token, DRAG.dx, DRAG.dy);
				await table.settle(500);
				const after = await table.positionOf(token);
				ok(
					planarDistance(before, after) < 0.01,
					`the locked token moved: ${JSON.stringify(before)} → ${JSON.stringify(after)}`
				);
				const drag = await page.evaluate(() => window.__tableplace!.drag().isDragging);
				ok(!drag, `the locked token was lifted into a drag: ${drag}`);
				const toasted = await eventually(
					() => page.evaluate(() => !!(window as unknown as { __lockToast?: boolean }).__lockToast),
					(shown) => shown,
					3000
				);
				ok(toasted, 'dragging the locked token did not toast the key that unlocks it');
				await table.snap('lock-refused');

				// everything else on the table still answers the pointer
				await assertDraggable(table, deck, 'deck (beside a locked token)');

				// ── the pin syncs, both ways ────────────────────────────────────
				// the second client only watches: every real-mouse step runs while
				// the table is the one foreground page, so a backgrounded tab's
				// throttled frames can't pass for a refused drag
				const remote = await openTable(context.browser, context.servers, lobby);
				try {
					ok(
						await eventually(
							() => lockedOn(remote),
							(on) => on,
							8000
						),
						'the second client never saw the lock'
					);
					await page.bringToFront();
					await pressL();
					ok(
						await eventually(
							() => lockedOn(table),
							(on) => !on,
							8000
						),
						`a second L did not unlock the token — under the pointer: ${JSON.stringify(
							await page.evaluate(() => {
								const game = window.__tableplace!.state();
								const locked = [
									...Object.entries(game?.pieces ?? {}),
									...Object.entries(game?.decks ?? {}),
									...Object.entries(game?.cards ?? {})
								]
									.filter(([, e]) => (e as { locked?: boolean } | null)?.locked)
									.map(([id]) => id);
								return { drag: window.__tableplace!.drag(), locked };
							})
						)}`
					);
					ok(
						await eventually(
							() => lockedOn(remote),
							(on) => !on,
							8000
						),
						'the second client never saw the unlock'
					);
					assertClean(remote, 'on the second client after lock and unlock');
				} finally {
					await remote.close();
				}

				// ── unpinned, it drags like any other piece ─────────────────────
				await page.bringToFront();
				await assertDraggable(table, token, 'the unlocked token');
				assertClean(table, 'after locking, a refused drag and unlocking');
			} finally {
				await table.close();
			}
		}
	},
	{
		/**
		 * Box select and group move (tableplace-202), at the real pointer.
		 *
		 * A left drag on bare felt draws the box and selects the three tokens it
		 * encloses — not the one outside it, and not the locked one inside it.
		 * Dragging any member then moves all three by the SAME delta, and the
		 * drag puts no more on the wire than a single drag does: members ride
		 * one patch, through the 5 Hz position throttle. Shift+click takes one
		 * out and puts it back; Esc lets go.
		 *
		 * Then the group drag is re-run under `stall` — the queued-pointer race
		 * of #163/#164 — because a group drag is a drag of several entities
		 * whose store positions all have to follow one pointer: a stalled page
		 * must still land every member by the same delta.
		 */
		name: 'box select: a felt drag selects three tokens, a drag moves all three by one delta',
		run: (context) =>
			withTable(context, 'box-select', async (table) => {
				const { page } = table;
				const tokens = [
					await table.spawn('token', { name: 'One', position: ON_FELT(0) }),
					await table.spawn('token', { name: 'Two', position: ON_FELT(1) }),
					await table.spawn('token', { name: 'Three', position: ON_FELT(2) })
				];
				const outside = await table.spawn('token', { name: 'Outside', position: ON_FELT(3) });
				const pinned = await table.spawn('token', {
					name: 'Pinned',
					position: [2, PIECE_REST_Y, 1]
				});
				await page.evaluate((id) => window.__tableplace!.actions.toggleLock('piece', id), pinned);
				await table.settle(800);

				const selected = () => page.evaluate(() => window.__tableplace!.selected());
				const positions = async () =>
					Promise.all([...tokens, outside, pinned].map((id) => table.positionOf(id)));

				// ── the box: from bare felt above-left of One to below-right of Three ──
				const at = await Promise.all(tokens.map((id) => table.locate(id)));
				ok(at.every(Boolean), `a token never mounted: ${JSON.stringify(at)}`);
				const outsideAt = await table.locate(outside);
				const margin = Math.abs(at[1]!.x - at[0]!.x) * 0.4;
				const start = {
					x: Math.min(...at.map((p) => p!.x)) - margin,
					y: Math.min(...at.map((p) => p!.y)) - margin
				};
				const end = {
					x: Math.max(...at.map((p) => p!.x)) + margin,
					y: Math.max(...at.map((p) => p!.y)) + margin
				};
				ok(outsideAt && outsideAt.x > end.x, 'the outside token is not outside the box');
				const underStart = await table.hits(start);
				ok(
					![...tokens, outside, pinned].some((id) => underStart.includes(id)),
					`the box would start on an entity, not on felt: ${underStart.join(', ')}`
				);
				ok(
					(await table.elementAt(start)).startsWith('canvas') &&
						(await table.elementAt(end)).startsWith('canvas'),
					'the box corners fall under a HUD pane'
				);
				const beforeBox = await table.cameraPose();
				await page.mouse.move(start.x, start.y);
				await sleep(80);
				await page.mouse.down();
				for (let step = 1; step <= 12; step++) {
					await page.mouse.move(
						start.x + ((end.x - start.x) * step) / 12,
						start.y + ((end.y - start.y) * step) / 12
					);
					await sleep(20);
				}
				const drawn = await page.evaluate(() => !!document.querySelector('[data-selection-box]'));
				await page.mouse.up();
				await table.settle(300);
				ok(drawn, 'no selection box was drawn while dragging on the felt');
				ok(
					!(await page.evaluate(() => !!document.querySelector('[data-selection-box]'))),
					'the selection box outlived the release'
				);
				const boxed = await selected();
				ok(
					JSON.stringify([...boxed].sort()) === JSON.stringify([...tokens].sort()),
					`the box selected ${JSON.stringify(boxed)}, not the three tokens inside it`
				);
				const afterBox = await table.cameraPose();
				ok(
					JSON.stringify(afterBox?.direction) === JSON.stringify(beforeBox?.direction),
					'a left drag on the felt still orbits the camera'
				);
				// evidence: the three selected tokens wear their rings, the others do not
				await table.snap('box-select-rings');

				// ── drag the middle one: all three move by the same delta ──
				const cdp = await page.createCDPSession();
				await cdp.send('Network.enable');
				const frames: string[] = [];
				cdp.on('Network.webSocketFrameSent', (event) => frames.push(event.response.payloadData));
				const before = await positions();
				const began = Date.now();
				await table.dragBy(tokens[1], DRAG.dx, DRAG.dy);
				const seconds = (Date.now() - began) / 1000;
				await table.settle(600);
				await cdp.detach();
				const after = await positions();
				const delta = (i: number) => [
					after[i]![0]! - before[i]![0]!,
					after[i]![2]! - before[i]![2]!
				];
				const [d0, d1, d2] = [delta(0), delta(1), delta(2)];
				ok(
					Math.hypot(d1[0]!, d1[1]!) > 0.5,
					`the grabbed token did not move: ${JSON.stringify(before[1])} → ${JSON.stringify(after[1])}`
				);
				for (const [i, d] of [d0, d2].entries())
					ok(
						Math.hypot(d[0]! - d1[0]!, d[1]! - d1[1]!) < 0.02,
						`selected token ${i === 0 ? 0 : 2} moved by ${JSON.stringify(d)}, the grabbed one by ${JSON.stringify(d1)}`
					);
				ok(
					planarDistance(before[3], after[3]) < 0.01 && planarDistance(before[4], after[4]) < 0.01,
					'a token that was not selected moved with the group'
				);
				const moves = frames.filter((frame) => frame.includes('"position"'));
				ok(
					moves.some((frame) => tokens.every((id) => frame.includes(id))),
					'no drag message carried all three tokens — the group is not riding one patch'
				);
				// the 5 Hz throttle: a leading send, one per 200 ms window, and the drop
				const budget = Math.ceil(seconds * 5) + 2;
				ok(
					moves.length <= budget,
					`a ${seconds.toFixed(2)}s group drag sent ${moves.length} position messages (budget ${budget})`
				);
				ok(await table.connected(), 'the group drag tripped the relay rate limit');
				ok((await selected()).length === 3, 'the selection did not survive the move it made');

				// ── Shift+click takes one out, and puts it back ──
				const three = await table.locate(tokens[2]);
				await page.keyboard.down('Shift');
				await page.mouse.click(three!.x, three!.y);
				await table.settle(200);
				const without = await selected();
				await page.mouse.click(three!.x, three!.y);
				await page.keyboard.up('Shift');
				await table.settle(200);
				const withAgain = await selected();
				ok(
					!without.includes(tokens[2]) && without.length === 2,
					`Shift+click did not take the token out: ${JSON.stringify(without)}`
				);
				ok(
					withAgain.includes(tokens[2]),
					`Shift+click did not put it back: ${JSON.stringify(withAgain)}`
				);
				ok(
					planarDistance(after[2], await table.positionOf(tokens[2])) < 0.01,
					'Shift+click moved the token'
				);

				// ── the same group drag on a stalled page (#163) ──
				let stalled = 0;
				let landed = false;
				for (let attempt = 0; attempt < 3 && !landed; attempt++) {
					const from = await positions();
					await table.stall({ ms: 800, everyMs: 20 });
					try {
						await table.dragBy(tokens[0], 0, -120);
					} finally {
						stalled += await table.stall(null);
					}
					await table.settle(1200);
					const to = await positions();
					const moved = [0, 1, 2].map((i) => [
						to[i]![0]! - from[i]![0]!,
						to[i]![2]! - from[i]![2]!
					]);
					if (Math.hypot(moved[0]![0]!, moved[0]![1]!) < 0.5) continue; // the press missed
					landed = true;
					for (const i of [1, 2])
						ok(
							Math.hypot(moved[i]![0]! - moved[0]![0]!, moved[i]![1]! - moved[0]![1]!) < 0.02,
							`under stalls, token ${i} moved by ${JSON.stringify(moved[i])} and the grabbed one by ${JSON.stringify(moved[0])}`
						);
				}
				ok(stalled > 0, 'the stall injection never ran');
				ok(landed, 'three stalled group drags never moved the grabbed token');

				// ── Esc lets go ──
				await page.mouse.move(end.x + 40, end.y + 40);
				await page.keyboard.press('Escape');
				await table.settle(200);
				ok((await selected()).length === 0, 'Esc did not clear the selection');

				assertClean(table, 'after box select and group moves');
				await table.snap('box-select');
			})
	},
	{
		/**
		 * Rotation steps (tableplace-200): E over a pawn, twice, turns it 90° —
		 * two steps of the default 45° — in synced state AND in what the
		 * renderer draws, which springs there through the shortest arc. Q while
		 * the pawn is held in a real drag turns the held pawn, not the table.
		 * The deck beside it still renders and drags throughout.
		 */
		name: 'rotation steps: E twice turns a pawn 90°, Q turns it mid-drag',
		run: async (context) => {
			const lobby = nextLobby('rotate');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				const page = table.page;
				const deck = await table.seedDeck();
				const pawn = await table.spawn('pawn', { name: 'Pawn', position: ON_FELT(0) });
				await table.settle(1500);
				assertClean(table, 'after spawning a pawn beside a deck');
				await assertRenders(table, pawn, 'the pawn');

				const storedYaw = () =>
					page.evaluate(
						(id) => window.__tableplace!.state()?.pieces?.[id]?.rotation?.[1] ?? null,
						pawn
					);
				const drawnYaw = () => page.evaluate((id) => window.__tableplace!.yaw(id), pawn);
				const near = (value: number | null, want: number) =>
					value !== null && Math.abs(value - want) < 0.5;

				// ── E, E: two steps of 45° ───────────────────────────────────────
				const at = await table.locate(pawn);
				ok(at, 'the pawn is not on screen to hover');
				await page.mouse.move(at!.x, at!.y, { steps: 6 });
				await table.settle(300);
				await page.keyboard.press('KeyE');
				await table.settle(200);
				await page.keyboard.press('KeyE');
				const stored = await eventually(storedYaw, (yaw) => yaw === 90, 3000);
				ok(stored === 90, `E twice did not store a 90° yaw: ${JSON.stringify(stored)}`);
				const drawn = await eventually(drawnYaw, (yaw) => near(yaw, 90));
				ok(near(drawn, 90), `E twice did not DRAW the pawn turned 90°: ${drawn}`);
				await table.snap('rotate-90');

				// ── Q while carried: the held pawn turns back a step ───────────
				const from = await table.locate(pawn);
				ok(from, 'the turned pawn left the screen');
				await page.mouse.move(from!.x, from!.y, { steps: 4 });
				await page.mouse.down();
				await page.mouse.move(from!.x, from!.y + 40, { steps: 6 });
				await table.settle(300);
				const held = await page.evaluate(() => window.__tableplace!.drag().isDragging);
				ok(held === pawn, `the pawn was not lifted into a drag: ${held}`);
				await page.keyboard.press('KeyQ');
				const turnedHeld = await eventually(storedYaw, (yaw) => yaw === 45, 3000);
				await page.mouse.move(from!.x, from!.y + 80, { steps: 6 });
				await page.mouse.up();
				ok(turnedHeld === 45, `Q mid-drag did not turn the held pawn: ${turnedHeld}`);
				const landed = await eventually(storedYaw, (yaw) => yaw === 45, 3000);
				ok(landed === 45, `the drop threw away the mid-drag turn: ${landed}`);

				// everything else still answers the pointer
				await assertDraggable(table, deck, 'deck (beside a turned pawn)');
				await assertDraggable(table, pawn, 'the turned pawn');
				assertClean(table, 'after turning a pawn by key and mid-drag');
			} finally {
				await table.close();
			}
		}
	},
	{
		/**
		 * Peek (tableplace-193): a card played face-down out of a hand records
		 * who played it, and that player's preview shows its face — captioned
		 * that only they see it — while every other client previews the back.
		 * Flipping it face up clears the mark everywhere.
		 *
		 * The play is a real drag out of the tray, because that gesture is what
		 * writes the mark; the second client is a real page, because the rule
		 * under test is "what a different viewer is drawn".
		 */
		name: 'peek: a face-down play shows its face to the player who made it and its back to the other seat',
		run: async (context) => {
			const lobby = nextLobby('peek');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				const page = table.page;
				const preview = (t: Table) => t.page.evaluate(() => window.__tableplace!.preview());
				const { deck, hand, me } = await page.evaluate(() => {
					const bridge = window.__tableplace!;
					const cards = [
						['2D', 'Two of Diamonds'],
						['QH', 'Queen of Hearts']
					].map(([code, name]) => ({
						id: `card:std:peek-${code}`,
						faceImageUrl: `gen:std52/${code}`,
						backImageUrl: 'gen:std52/back',
						name
					}));
					const deck = String(
						bridge.actions.addDeck({ cards, position: [-8, 0.16, -2] } as never) ?? ''
					);
					// face-down: the top is the END of the array — QH
					const hand = bridge.actions.drawFromTop(deck, 1)[0]?.id ?? '';
					const me = bridge.actions.getMyId() ?? '';
					bridge.actions.moveCardToTray(hand, me);
					return { deck, hand, me };
				});
				ok(deck && hand && me, `seeding failed: ${JSON.stringify({ deck, hand, me })}`);
				await table.settle(1500);

				// ── seat 0 plays the card out of the hand, face-down ───────────
				const inHand = await eventually(
					() => page.evaluate((id) => window.__tableplace!.locateInHand(id), hand),
					(point) => !!point
				);
				ok(inHand, `the hand card ${hand} never drew in the tray`);
				const dropAt = await page.evaluate((at) => window.__tableplace!.project(at), ON_FELT(1));
				ok(dropAt, 'the drop point on the felt does not project');
				ok(
					(await table.elementAt(dropAt!)).startsWith('canvas'),
					`a HUD pane covers the drop point: ${await table.elementAt(dropAt!)}`
				);
				await page.mouse.move(inHand!.x, inHand!.y, { steps: 5 });
				await sleep(200);
				await page.mouse.down();
				await page.mouse.move(dropAt!.x, dropAt!.y, { steps: 12 });
				await sleep(200);
				await page.mouse.up();
				const played = await eventually(
					() => page.evaluate((id) => window.__tableplace!.state()?.cards?.[id] ?? null, hand),
					(card) => !!card && (card.position?.[1] ?? 9) < 1
				);
				ok(played, `dragging ${hand} out of the hand left nothing on the table`);
				ok(
					played!.rotation?.[0] === 180 && played!.placedBy === me,
					`the played card is not face-down and marked as mine: ${JSON.stringify({ rotation: played!.rotation, placedBy: played!.placedBy, me })}`
				);
				await table.settle(600);

				/** hover `id` with the real mouse on `t`, hold Space, read (and shoot) the zoom, let go */
				const peekAt = async (t: Table, id: string, shot?: string) => {
					await t.page.bringToFront();
					const at = await eventually(
						() => t.locate(id),
						(point) => !!point
					);
					ok(at, `${id} never drew on this client`);
					ok(
						(await t.elementAt(at!)).startsWith('canvas'),
						`a HUD pane covers ${id} at ${JSON.stringify(at)}: ${await t.elementAt(at!)}`
					);
					await t.page.mouse.move(at!.x, at!.y, { steps: 8 });
					await sleep(300);
					await t.page.keyboard.down('Space');
					const zoomed = await eventually(
						() => preview(t),
						(p) => !!p && p.id === id && !!p.shown && p.shown === p.url
					);
					if (shot) await t.snap(shot);
					await t.page.keyboard.up('Space');
					await eventually(
						() => preview(t),
						(p) => p === null
					);
					return zoomed;
				};

				// ── seat 0: the face, and a caption that only says who sees it ─
				const mine = await peekAt(table, hand, 'peek-seat0');
				ok(
					mine?.id === hand && mine.face === 'gen:std52/QH',
					`seat 0's preview of its own face-down play is not the face: ${JSON.stringify(mine)}`
				);
				ok(
					mine!.caption === 'Queen of Hearts · Only you see this',
					`seat 0's peek caption reads ${JSON.stringify(mine!.caption)}`
				);

				// ── seat 1: the back, and not a word about the face ────────────
				// its own browser context: its own localStorage, so its own player id
				const elsewhere = await context.browser.createBrowserContext();
				// a context whose table never loaded must not outlive the spec (#243)
				const remote = await openTable(elsewhere, context.servers, lobby).catch(async (error) => {
					await elsewhere.close();
					throw error;
				});
				try {
					// a joiner is not seated anywhere in particular: take seat 1, as a
					// player at the far side of the table would
					const other = await remote.page.evaluate(() => {
						window.__tableplace!.actions.setSeat(1);
						return window.__tableplace!.actions.getMyId() ?? '';
					});
					ok(other && other !== me, `the second client is not another player: ${other}`);
					const seat = await eventually(
						() =>
							remote.page.evaluate(
								() =>
									window.__tableplace!.state()?.players?.[window.__tableplace!.actions.getMyId()!]
										?.seat
							),
						(n) => n === 1
					);
					ok(seat === 1, `the second client sat at seat ${seat}, not 1`);
					const synced = await eventually(
						() =>
							remote.page.evaluate((id) => window.__tableplace!.state()?.cards?.[id] ?? null, hand),
						(card) => card?.placedBy === me,
						// a second page still compiling its modules on a loaded runner
						20_000
					);
					ok(
						synced?.placedBy === me,
						`the second client never saw the played card marked as seat 0's: ${JSON.stringify(synced)}`
					);
					await remote.settle(1500);
					const theirs = await peekAt(remote, hand, 'peek-seat1');
					ok(
						theirs?.id === hand && theirs.face === 'gen:std52/back' && theirs.caption === '',
						`seat 1's preview of seat 0's face-down play is not its bare back: ${JSON.stringify(theirs)}`
					);

					// ── face up: public, and the mark is gone on both clients ──
					await page.evaluate((id) => window.__tableplace!.actions.flipCard(id), hand);
					const cleared = (t: Table) =>
						t.page.evaluate((id) => {
							const card = window.__tableplace!.state()?.cards?.[id];
							return !!card && card.rotation?.[0] === 0 && card.placedBy === undefined;
						}, hand);
					ok(
						await eventually(
							() => cleared(table),
							(done) => done
						),
						'flipping face up did not clear the mark on seat 0'
					);
					ok(
						await eventually(
							() => cleared(remote),
							(done) => done,
							8000
						),
						'the flip never cleared the mark on seat 1'
					);
					const faceUp = await peekAt(remote, hand);
					ok(
						faceUp?.face === 'gen:std52/QH' && faceUp.caption === 'Queen of Hearts',
						`seat 1's preview of the flipped card is ${JSON.stringify(faceUp)}`
					);
					assertClean(remote, 'on the second client after a face-down play and a flip');
				} finally {
					await remote.close();
					await elsewhere.close();
				}

				await page.bringToFront();
				assertClean(table, 'after playing face-down, peeking and flipping');
			} finally {
				await table.close();
			}
		}
	},
	{
		/**
		 * tableplace-195: the hand is a fan you hold. Its cards stay on screen
		 * however many and however narrow the window; a drag along it reorders
		 * them, and the order is synced state that comes back after a reload; a
		 * drag up and out plays one — face-down unless Shift is held, and the
		 * carried card shows the face that will land; and a table card dropped
		 * back on the fan goes into the hand.
		 */
		name: 'hand: fan fits 1/7/15 at 1280 and 400, reorder survives a reload, Shift plays face-up',
		run: async (context) => {
			const lobby = nextLobby('hand');
			const table = await openTable(context.browser, context.servers, lobby);
			try {
				let page = table.page;
				const deck = await page.evaluate(() => {
					const bridge = window.__tableplace!;
					const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A', '2'];
					const cards = ranks.map((rank, i) => ({
						id: `card:std:hand-${i}`,
						faceImageUrl: `gen:std52/${rank}${i < 13 ? 'S' : 'H'}`,
						backImageUrl: 'gen:std52/back',
						name: `card ${i}`
					}));
					return String(bridge.actions.addDeck({ cards, position: [-8, 0.16, -2] } as never) ?? '');
				});
				ok(deck, 'seeding the deck failed');

				type HandCard = { id: string; left: number; right: number; top: number; bottom: number };
				const handCards = (): Promise<HandCard[]> =>
					page.evaluate(() => window.__tableplace!.handCards());
				/** the stored order, left to right: by handOrder, as the fan sorts it */
				const storedOrder = () =>
					page.evaluate(() => {
						const bridge = window.__tableplace!;
						const me = bridge.actions.getMyId();
						const tray = (me && bridge.state()?.players?.[me]?.tray) || {};
						return Object.entries(tray)
							.filter(([, card]) => !!card)
							.sort(([, a], [, b]) => (a?.handOrder ?? 1e9) - (b?.handOrder ?? 1e9))
							.map(([id]) => id);
					});
				const draw = async (count: number) => {
					const drawn = await page.evaluate(
						(id, n) => window.__tableplace!.actions.drawToHand(id, n),
						deck,
						count
					);
					ok(drawn.ok, `drawing ${count} into the hand failed: ${JSON.stringify(drawn)}`);
				};

				// ── the fan stays inside the viewport ──────────────────────────
				// The 15-card resizes run on a stalled page (#244): a loaded CI
				// runner starved the cards' springs, which clamp to 1/30s a tick, so
				// the fan was still sliding in from the 1280 layout when this looked.
				let held = 0;
				let stalled = 0;
				for (const size of [1, 7, 15]) {
					await draw(size - held);
					held = size;
					for (const [width, height] of [
						[1280, 800],
						[400, 800]
					] as const) {
						if (size === 15) await table.stall({ ms: 800, everyMs: 20 });
						await page.setViewport({ width, height });
						// off the hand, so nothing is raised
						await page.mouse.move(width / 2, 40);
						const inside = (cards: HandCard[]) =>
							cards.length === size &&
							cards.every(
								(c) => c.left >= 0 && c.right <= width && c.top >= 0 && c.bottom <= height
							);
						// the springs have to arrive — and the newest cards finish their flight
						const cards = await eventually(handCards, inside);
						if (size === 15 && width === 400) await table.snap('hand-fan-15-at-400');
						ok(
							inside(cards),
							`a hand of ${size} does not fit ${width}×${height}: ` +
								JSON.stringify(
									cards
										.filter((c) => c.left < 0 || c.right > width || c.top < 0 || c.bottom > height)
										.map((c) => ({ ...c, id: c.id.slice(-8) }))
								) +
								` (${cards.length} drawn)`
						);
						if (size === 15) stalled += await table.stall(null);
					}
				}
				ok(
					stalled > 5,
					`the stall injector only ran ${stalled} times — the 15-card fan was not tested under load`
				);
				await page.setViewport({ width: 1280, height: 800 });
				await page.mouse.move(640, 40);
				await table.settle(900);
				await table.snap('hand-fan-15-at-1280');

				// the fan draws the stored order, left to right
				const before = await storedOrder();
				ok(before.length === 15, `the hand holds ${before.length}, not 15`);
				const drawnOrder = async () => (await handCards()).map((c) => c.id);
				ok(
					JSON.stringify(await drawnOrder()) === JSON.stringify(before),
					`the fan does not draw the stored order: ${JSON.stringify(await drawnOrder())} vs ${JSON.stringify(before)}`
				);

				// ── reorder: the first card, dragged along the fan onto the third ─
				const cards = await handCards();
				const first = cards[0]!;
				const third = cards[2]!;
				const y = (first.top + first.bottom) / 2 + 20;
				const from = { x: (first.left + first.right) / 2, y };
				// onto the third card's slot: it takes that slot, the two before shift left
				const to = { x: (third.left + third.right) / 2, y };
				ok(
					(await table.elementAt(from)).startsWith('canvas'),
					`something covers the hand at ${JSON.stringify(from)}: ${await table.elementAt(from)}`
				);
				await page.mouse.move(from.x, from.y, { steps: 4 });
				await sleep(250);
				await page.mouse.down();
				await page.mouse.move(to.x, to.y, { steps: 12 });
				await sleep(250);
				ok(
					(await page.evaluate(() => window.__tableplace!.drag().isDragging)) === null,
					'a drag along the hand lifted the card onto the table instead of reordering'
				);
				await page.mouse.up();
				const expected = [before[1], before[2], before[0], ...before.slice(3)];
				const after = await eventually(
					storedOrder,
					(order) => JSON.stringify(order) === JSON.stringify(expected)
				);
				ok(
					JSON.stringify(after) === JSON.stringify(expected),
					`dragging the first card onto the third's slot did not reorder the hand: ${JSON.stringify(after)}`
				);
				ok(
					(await page.evaluate((id) => !!window.__tableplace!.state()?.cards?.[id], before[0]!)) ===
						false,
					'the reordered card also landed on the table'
				);

				// ── reload: the order is synced state, not local ──────────────
				const readyMs = Number(process.env.E2E_READY_MS ?? 60_000);
				await page.reload({ waitUntil: 'networkidle2', timeout: readyMs });
				await page
					.waitForFunction('window.__tableplace?.ready === true', { timeout: readyMs })
					.catch(async (error) => {
						const state = await page
							.evaluate(() => ({
								bridge: !!window.__tableplace,
								ready: window.__tableplace?.ready ?? null,
								url: location.href
							}))
							.catch((e) => String(e));
						throw new Error(
							`the page never came back ready after a reload (${error}): ` +
								`${JSON.stringify(state)}; problems: ${JSON.stringify(table.appProblems())}`
						);
					});
				await table.settle(1500);
				page = table.page;
				const reloaded = await eventually(
					storedOrder,
					(order) => JSON.stringify(order) === JSON.stringify(expected),
					15_000
				);
				ok(
					JSON.stringify(reloaded) === JSON.stringify(expected),
					`the hand order did not survive a reload: ${JSON.stringify(reloaded)}`
				);
				await page.mouse.move(640, 40);
				const redrawn = await eventually(
					drawnOrder,
					(order) => JSON.stringify(order) === JSON.stringify(expected)
				);
				ok(
					JSON.stringify(redrawn) === JSON.stringify(expected),
					`after a reload the fan draws ${JSON.stringify(redrawn)}, not the stored order`
				);

				// ── Shift plays face-up, and the carried card shows it ─────────
				const middle = (await handCards())[7]!;
				const playing = middle.id;
				const pressAt = { x: (middle.left + middle.right) / 2, y: middle.bottom - 30 };
				const dropAt = await page.evaluate((at) => window.__tableplace!.project(at), ON_FELT(1));
				ok(dropAt, 'the drop point on the felt does not project');
				await page.mouse.move(pressAt.x, pressAt.y, { steps: 4 });
				await sleep(250);
				await page.mouse.down();
				// up and out of the hand: now it is a play, face-down by default
				await page.mouse.move(pressAt.x, pressAt.y - 220, { steps: 10 });
				const lifted = await eventually(
					() =>
						page.evaluate((id) => {
							const bridge = window.__tableplace!;
							return {
								dragging: bridge.drag().isDragging,
								flip: bridge.state()?.cards?.[id]?.rotation?.[0] ?? null
							};
						}, playing),
					(seen) => seen.dragging === playing
				);
				ok(
					lifted.dragging === playing && lifted.flip === 180,
					`dragging out of the hand did not carry the card face-down: ${JSON.stringify(lifted)}`
				);
				await page.keyboard.down('Shift');
				const turned = await eventually(
					() =>
						page.evaluate(
							(id) => window.__tableplace!.state()?.cards?.[id]?.rotation?.[0] ?? null,
							playing
						),
					(flip) => flip === 0
				);
				ok(turned === 0, `holding Shift did not turn the carried card face-up (x = ${turned})`);
				await page.mouse.move(dropAt!.x, dropAt!.y, { steps: 12 });
				await sleep(250);
				await page.mouse.up();
				await page.keyboard.up('Shift');
				const played = await eventually(
					() => page.evaluate((id) => window.__tableplace!.state()?.cards?.[id] ?? null, playing),
					(card) => !!card && (card.position?.[1] ?? 9) < 1
				);
				ok(
					!!played && played.rotation?.[0] === 0 && played.placedBy === undefined,
					`the Shift play did not land face-up and unmarked: ${JSON.stringify(played && { rotation: played.rotation, placedBy: played.placedBy, position: played.position })}`
				);
				ok(!(await storedOrder()).includes(playing), 'the played card is still in the hand');
				await table.settle(600);
				await table.snap('hand-played-face-up');

				// ── and a table card dropped on the fan goes back into the hand ─
				const onTable = await eventually(
					() => table.locate(playing),
					(point) => !!point
				);
				ok(onTable, 'the played card never drew on the table');
				const handAt = { x: 640, y: 800 - 50 };
				await page.mouse.move(onTable!.x, onTable!.y, { steps: 4 });
				await sleep(250);
				await page.mouse.down();
				await page.mouse.move(handAt.x, handAt.y, { steps: 14 });
				await sleep(300);
				await page.mouse.up();
				const back = await eventually(storedOrder, (order) => order.includes(playing));
				ok(
					back.includes(playing) && back.length === 15,
					`dropping the card on the hand did not take it back: ${JSON.stringify(back)}`
				);

				assertClean(table, 'after fanning, reordering, reloading and playing out of the hand');
			} finally {
				await table.close();
			}
		}
	},
	{
		/**
		 * Weight (tableplace-203): a carried piece leans against its travel, a
		 * dropped one lands with one small bounce — and the landing is never
		 * delayed by it: the drawn height is back at rest within 600 ms of the
		 * release. All of it is render-only, so it is measured off the drawn
		 * group (`pose`), timed by the page against its own pointerup. Under
		 * prefers-reduced-motion nothing leans.
		 */
		name: 'weight: a carried token leans, a dropped one is at rest within 600 ms',
		run: (context) =>
			withTable(context, 'weight', async (table) => {
				const { page } = table;
				const deck = await table.seedDeck();
				const token = await table.spawn('token', { position: ON_FELT(1) });
				await table.settle(2500);
				assertClean(table, 'with a token on the table');
				const pose = () => page.evaluate((id) => window.__tableplace!.pose(id), token);

				// press, then sweep sideways sampling the lean as it goes
				const carry = async (dx: number) => {
					const from = await table.locate(token);
					ok(from, `the token (${token}) never mounted`);
					await page.mouse.move(from!.x, from!.y);
					await sleep(80);
					await page.mouse.down();
					await sleep(80);
					let lean = 0;
					let stalled = false;
					for (let step = 1; step <= 16; step++) {
						await page.mouse.move(from!.x + (dx * step) / 16, from!.y);
						await sleep(16);
						lean = Math.max(lean, (await pose())?.leanDeg ?? 0);
						stalled ||= await page.evaluate(() => window.__tableplace!.stalling());
					}
					return { lean, stalled };
				};
				// release, with the page timing every drawn height against its own
				// pointerup — puppeteer's round trips are no clock for 600 ms
				const release = async () => {
					await page.evaluate((id) => {
						const samples: [number, number][] = [];
						(window as unknown as { __landing: typeof samples }).__landing = samples;
						window.addEventListener(
							'pointerup',
							() => {
								const up = performance.now();
								// a timer, not rAF: on a starved runner frames are seconds apart
								const tick = () => {
									const t = performance.now() - up;
									samples.push([t, window.__tableplace!.pose(id)?.y ?? NaN]);
									if (t < 900) setTimeout(tick, 15);
								};
								tick();
							},
							{ once: true, capture: true }
						);
					}, token);
					await page.mouse.up();
					return eventually(
						() =>
							page.evaluate(
								() => (window as unknown as { __landing: [number, number][] }).__landing
							),
						(samples) => (samples.at(-1)?.[0] ?? 0) >= 900
					);
				};

				// ── carried: a lean, a few degrees and capped ──
				// On a frame loop too starved to animate (a software-GL runner under
				// load: frames seconds apart) every spring snaps and weight is off by
				// design — then the assertion is that it stayed off.
				const { lean, stalled } = await carry(240);
				ok(lean <= 7.5, `the carried token leaned past its cap: ${lean.toFixed(2)}°`);
				if (stalled)
					ok(lean < 0.01, `the frame loop was stalling, yet the token leaned ${lean.toFixed(2)}°`);
				else ok(lean > 0.5, `the carried token never leaned: max ${lean.toFixed(2)}°`);

				// ── dropped: at rest height within 600 ms, level again ──
				const landing = await release();
				const rest = (await table.positionOf(token))?.[1] ?? NaN;
				ok(Number.isFinite(rest), `the dropped token has no store height`);
				const late = landing.filter(([t]) => t >= 600);
				ok(late.length > 0, `no drawn height was sampled 600 ms after the drop`);
				const off = late.find(([, y]) => Math.abs(y - rest) > 0.01);
				ok(
					!off,
					`the dropped token was not at rest (${rest}) by 600 ms: ${JSON.stringify(off)} — landing ${JSON.stringify(landing.map(([t, y]) => [Math.round(t), +y.toFixed(3)]))}`
				);
				const peak = Math.max(...landing.map(([, y]) => y - rest));
				console.log(
					`    weight: lean ${lean.toFixed(2)}°${stalled ? ' (frames stalling: weight off)' : ''}, ${landing.length} landing frames, highest ${peak.toFixed(3)} over rest`
				);
				const level = await pose();
				ok((level?.leanDeg ?? 99) < 0.1, `the dropped token is still leaning: ${level?.leanDeg}°`);

				// ── prefers-reduced-motion: no lean at all ──
				await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
				try {
					const still = (await carry(-240)).lean;
					ok(still < 0.01, `under reduced motion the carried token leaned ${still.toFixed(2)}°`);
					await release();
				} finally {
					await page.emulateMediaFeatures([]);
				}

				await assertDraggable(table, deck, 'deck (beside a weighted token)');
				assertClean(table, 'after carrying and dropping a weighted token');
			})
	},
	{
		/**
		 * tableplace-201: the action journal. Two players in two browser
		 * contexts (two localStorages, so two player ids). The first moves a
		 * piece under a real mouse; the second must see the log line — which
		 * only ever arrives as the ephemeral `journal` relay message, never as
		 * lobby state — and, after the first presses Ctrl+Z, both must see the
		 * piece back where it started. Then the refusal: once the second player
		 * has moved the piece too, the first player's undo says why and moves
		 * nothing.
		 */
		name: 'journal: a peer sees the log line, and Ctrl+Z puts the piece back for both',
		run: async (context) => {
			const lobby = nextLobby('journal');
			const table = await openTable(context.browser, context.servers, lobby);
			const peerContext = await context.browser.createBrowserContext();
			let remote: Table | null = null;
			const lines = (t: Table) =>
				t.page.evaluate(() =>
					[...document.querySelectorAll('[data-journal-line]')].map((li) => li.textContent ?? '')
				);
			const undo = async () => {
				await table.page.keyboard.down('Control');
				await table.page.keyboard.press('KeyZ');
				await table.page.keyboard.up('Control');
			};
			try {
				const deck = await table.seedDeck();
				const piece = await table.spawn('token', { name: 'Marker', position: ON_FELT(1) });
				await table.settle();
				remote = await openTable(peerContext, context.servers, lobby);
				const peer = remote;
				// the far side of the table, as a second player would sit
				await peer.page.evaluate(() => window.__tableplace!.actions.setSeat(1));
				await peer.settle(1500);
				await assertRenders(peer, piece, 'the piece (second client)');
				const home = (await table.positionOf(piece))!;

				await table.dragBy(piece, DRAG.dx, DRAG.dy);
				const moved = await eventually(
					() => peer.positionOf(piece),
					(p) => !!p && planarDistance(p, home) > 0.5
				);
				ok(
					!!moved && planarDistance(moved, home) > 0.5,
					`the second client never saw the move: ${JSON.stringify(moved)} vs ${JSON.stringify(home)}`
				);
				const seen = await eventually(
					() => lines(peer),
					(l) => l.some((line) => /moved Marker/.test(line))
				);
				ok(
					seen.some((line) => /moved Marker/.test(line)),
					`the second client's log has no line for the move: ${JSON.stringify(seen)}`
				);
				const mine = await lines(table);
				ok(
					mine.some((line) => /^\s*You\s+moved Marker/.test(line)),
					`the mover's own log does not show the move as theirs: ${JSON.stringify(mine)}`
				);

				await undo();
				for (const [who, t] of [
					['the mover', table],
					['the second client', peer]
				] as const) {
					const back = await eventually(
						() => t.positionOf(piece),
						(p) => !!p && planarDistance(p, home) < 0.05
					);
					ok(
						!!back && planarDistance(back, home) < 0.05,
						`after Ctrl+Z ${who} does not have the piece back: ${JSON.stringify(back)} vs ${JSON.stringify(home)}`
					);
				}
				const undone = await eventually(
					() => lines(peer),
					(l) => l.some((line) => /undid: moved Marker/.test(line))
				);
				ok(
					undone.some((line) => /undid: moved Marker/.test(line)),
					`the undo was not logged for the second client: ${JSON.stringify(undone)}`
				);

				// the refusal: move it again, the peer moves it after, undo is refused
				await table.dragBy(piece, DRAG.dx, DRAG.dy);
				await sleep(1200); // the move settles into one journal action
				const theirs: [number, number, number] = [home[0] + 2, home[1], home[2] - 1];
				await peer.page.evaluate(
					(id, to) => window.__tableplace!.actions.movePiece(id, to),
					piece,
					theirs
				);
				await eventually(
					() => table.positionOf(piece),
					(p) => !!p && planarDistance(p, theirs) < 0.05
				);
				await undo();
				const refusal = await eventually(
					() => table.page.evaluate(() => document.body.innerText),
					(text) => /has touched it since/.test(text),
					4000
				);
				ok(
					/has touched it since you moved Marker/.test(refusal),
					`an undo after the peer moved the piece was not refused with a reason`
				);
				await sleep(500);
				const kept = await table.positionOf(piece);
				ok(
					!!kept && planarDistance(kept, theirs) < 0.05,
					`the refused undo still moved the piece: ${JSON.stringify(kept)} vs ${JSON.stringify(theirs)}`
				);

				await assertDraggable(table, deck, 'deck (after an undo)');
				assertClean(table, 'after moving and undoing with the journal');
				assertClean(peer, 'on the second client, reading the journal');
				await table.snap('journal');
			} finally {
				await remote?.close();
				await peerContext.close();
				await table.close();
			}
		}
	},
	{
		/**
		 * tableplace-204: table sounds. Synthesised in the page, so what a spec
		 * can see is which sounds STARTED (`sounds()`), not what came out of a
		 * speaker. The gates: none before a user gesture (a programmatic move on
		 * a fresh page is silent), the first real mouse gesture arms audio and a
		 * drag then lifts and drops, and none while muted — and the mute is
		 * remembered across a reload.
		 */
		name: 'sound: silent before a gesture and while muted, lift and drop once armed',
		run: (context) =>
			withTable(context, 'sound', async (table) => {
				const { page } = table;
				const token = await table.spawn('token', { position: ON_FELT(1) });
				const deck = await table.seedDeck();
				await table.settle(2500);
				const sounds = () => page.evaluate(() => window.__tableplace!.sounds());
				const total = (s: Record<string, number | boolean>) =>
					Object.entries(s).reduce((n, [, v]) => n + (typeof v === 'number' ? v : 0), 0);

				// no gesture yet: a raised-and-lowered token makes no sound
				const armed = await sounds();
				ok(
					armed.gestured === false,
					`audio was armed before any gesture: ${JSON.stringify(armed)}`
				);
				await page.evaluate((id) => {
					const bridge = window.__tableplace!;
					bridge.actions.movePiece(id, [0, 2, 0]);
					bridge.actions.movePiece(id, [0, 0.1, 0]);
				}, token);
				await sleep(300);
				ok(
					total(await sounds()) === 0,
					`sound played before a gesture: ${JSON.stringify(await sounds())}`
				);

				// the first real gesture arms audio; a drag then lifts and drops
				await table.dragBy(token, 120, 0);
				const heard = await eventually(sounds, (s) => (s.drop as number) > 0);
				ok(heard.gestured === true, `the gesture did not arm audio: ${JSON.stringify(heard)}`);
				ok(
					(heard.lift as number) > 0 && (heard.drop as number) > 0,
					`a drag did not lift and drop: ${JSON.stringify(heard)}`
				);

				// muted: the visible toggle silences the same drag
				await page.click('[data-testid="sound-toggle"]');
				ok(
					(await page.evaluate(() => localStorage.getItem('sound:v1'))) === 'off',
					'the mute was not remembered in localStorage'
				);
				const muted = total(await sounds());
				await table.dragBy(token, -120, 0);
				await sleep(400);
				ok(
					total(await sounds()) === muted,
					`sound played while muted: ${JSON.stringify(await sounds())}`
				);

				// unmuted again: it plays
				await page.click('[data-testid="sound-toggle"]');
				await table.dragBy(token, 120, 0);
				await eventually(sounds, (s) => total(s) > muted);

				await assertDraggable(table, deck, 'deck (beside sound)');
				assertClean(table, 'after playing table sounds');
			})
	},
	{
		/**
		 * tableplace-198: ping. Two players in two browser contexts. The first
		 * double-clicks bare felt under a real mouse; the second must draw the
		 * ripple, in the pinger's seat colour, at that spot — and it only ever
		 * arrives as the ephemeral `ping` relay message, never as lobby state.
		 * Then: a double-click on a piece focuses it and pings nobody; the
		 * radial's Ping wedge on a piece pings where it lies; a ping outside
		 * the view puts an edge arrow up; and a burst is held to two a second
		 * on the sender, so the relay (and the socket) never feel it.
		 */
		name: 'ping: double-click the felt, the other player sees the ripple; off-view shows an arrow',
		run: async (context) => {
			const lobby = nextLobby('ping');
			const table = await openTable(context.browser, context.servers, lobby);
			const peerContext = await context.browser.createBrowserContext();
			let remote: Table | null = null;
			const pings = (t: Table) => t.page.evaluate(() => window.__tableplace!.pings());
			const myId = (t: Table) => t.page.evaluate(() => window.__tableplace!.actions.getMyId());
			// SEAT_COLOR in src/lib/hud/players.ts
			const SEAT_COLOR: Record<number, string> = {
				0: '#ff6b8a',
				1: '#6ee7a0',
				2: '#b98cff',
				3: '#ff8a3d'
			};
			/**
			 * Is `color` what `t` should paint `id`'s pings? Their seat's colour when
			 * `t` knows the seat; before it does, `playerColor` falls back to a
			 * palette colour hashed from the id.
			 */
			const paintsAsSeat = async (t: Table, id: string, color: string | null) => {
				const seat = await t.page.evaluate(
					(pid) => window.__tableplace!.state()?.players?.[pid]?.seat,
					id
				);
				return typeof seat === 'number'
					? color === SEAT_COLOR[seat]
					: Object.values(SEAT_COLOR).includes(color ?? '');
			};
			try {
				const piece = await table.spawn('token', { name: 'Marker', position: ON_FELT(1) });
				await table.settle();
				remote = await openTable(peerContext, context.servers, lobby);
				const peer = remote;
				await peer.page.evaluate(() => window.__tableplace!.actions.setSeat(1));
				await peer.settle(1500);
				await assertRenders(peer, piece, 'the piece (second client)');
				const [me, them] = [await myId(table), await myId(peer)];
				ok(me && them && me !== them, `the two clients are not two players: ${me} / ${them}`);

				// ── double-click bare felt: both draw it, in the pinger's colour ──
				const spot: [number, number, number] = [6, 0.26, 4];
				const felt = await table.page.evaluate((w) => window.__tableplace!.project(w), spot);
				ok(felt, 'the felt spot projects off-screen');
				await table.page.mouse.move(felt!.x, felt!.y);
				await table.settle(300);
				ok(
					(await table.elementAt(felt!)).startsWith('canvas') &&
						!(await table.hits(felt!)).includes(piece),
					`the felt spot is not bare felt: ${await table.elementAt(felt!)} / ${JSON.stringify(await table.hits(felt!))}`
				);
				await table.page.mouse.click(felt!.x, felt!.y, { count: 2 });
				const seen = await eventually(
					() => pings(peer),
					(list) => list.some((p) => p.playerId === me && p.rings > 0 && p.color),
					20_000
				);
				const theirs = seen.find((p) => p.playerId === me);
				ok(
					theirs,
					`the second client never drew the ping: ${JSON.stringify(seen)} ` +
						`(the pinger drew ${JSON.stringify(await pings(table))})`
				);
				ok(
					Math.hypot(theirs!.x - spot[0], theirs!.z - spot[2]) < 0.5,
					`the ping landed at ${theirs!.x},${theirs!.z}, not the double-clicked ${spot[0]},${spot[2]}`
				);
				ok(
					theirs!.rings > 0,
					`the second client never showed a ripple ring: ${JSON.stringify(theirs)}`
				);
				ok(
					await paintsAsSeat(peer, me!, theirs!.color),
					`the ripple is ${theirs!.color}, not the pinger's seat colour`
				);
				const own = (await pings(table)).find((p) => p.playerId === me);
				ok(
					own && own.rings > 0 && (await paintsAsSeat(table, me!, own.color)),
					`the pinger's own ripple is missing or a different colour: ${JSON.stringify(own)}`
				);
				ok(
					!(await table.page.evaluate(() => 'pings' in (window.__tableplace!.state() ?? {}))),
					'a ping leaked into lobby state'
				);
				await table.snap('ping');

				// ── a double-click on a piece focuses it and pings nobody ──
				const cameraBefore = JSON.stringify(await peer.cameraPose());
				const target = await peer.locate(piece);
				ok(target, 'the piece projects off-screen for the second client');
				await peer.page.mouse.move(target!.x, target!.y);
				await peer.settle(300);
				ok(
					(await peer.hits(target!)).includes(piece),
					`the second client's pointer is not over the piece: ${JSON.stringify(await peer.hits(target!))}`
				);
				await peer.page.mouse.click(target!.x, target!.y, { count: 2 });
				await settleCamera(peer);
				ok(
					JSON.stringify(await peer.cameraPose()) !== cameraBefore,
					'a double-click on the piece did not focus it'
				);
				await sleep(800);
				for (const [who, t] of [
					['the second client', peer],
					['the first client', table]
				] as const)
					ok(
						!(await pings(t)).some((p) => p.playerId === them),
						`a double-click on a piece pinged (${who})`
					);

				// ── a ping outside the view gets an edge arrow ──
				const far: [number, number, number] = [-TABLE_HALF_X + 2, 0.26, -TABLE_HALF_Z + 2];
				const offView = await peer.page.evaluate((w) => {
					const at = window.__tableplace!.project(w);
					return !at || at.x < 0 || at.y < 0 || at.x > innerWidth || at.y > innerHeight;
				}, far);
				ok(offView, 'the far corner is still in the focused view — pick a farther spot');
				ok(
					await table.page.evaluate((x, z) => window.__tableplace!.ping(x, z), far[0], far[2]),
					'the far ping was refused by the rate limit'
				);
				const arrowed = await eventually(
					() => pings(peer),
					(list) => list.some((p) => p.playerId === me && p.x === far[0] && p.arrow),
					20_000
				);
				ok(
					arrowed.some((p) => p.playerId === me && p.x === far[0] && p.arrow),
					`no edge arrow for the off-view ping: ${JSON.stringify(arrowed)}`
				);
				ok(
					await eventually(
						() => peer.page.evaluate(() => !document.querySelector('[data-ping-arrow]')),
						(gone) => gone,
						// frame-timed: the ripple plays from its first drawn frame, so on
						// a starved renderer it ends late — but never past PING_STALE_MS
						12_000
					),
					'the edge arrow outlived its ping'
				);

				// ── the radial on a thing: Ping pings where it lies ──
				await peer.page.keyboard.press('KeyC');
				await settleCamera(peer);
				const wheel = await peer.openRadial(piece, { button: 'right', timeoutMs: 20_000 });
				ok(wheel.wedges['ping'], `the piece's wheel has no Ping: ${wheel.actions.join(', ')}`);
				await flickTo(peer, wheel.wedges['ping']!);
				await peer.page.mouse.up({ button: 'right' });
				const wedged = await eventually(
					() => pings(table),
					(list) => list.some((p) => p.playerId === them && p.rings > 0),
					20_000
				);
				const fromWheel = wedged.find((p) => p.playerId === them);
				const at = (await table.positionOf(piece))!;
				ok(
					fromWheel && Math.hypot(fromWheel.x - at[0], fromWheel.z - at[2]) < 0.5,
					`the wheel's ping did not land on the piece: ${JSON.stringify(fromWheel)} vs ${JSON.stringify(at)}`
				);
				ok(
					await paintsAsSeat(table, them!, fromWheel!.color),
					`the second player's ping is ${fromWheel!.color}, not their seat colour`
				);

				// ── a burst is held to two a second on the sender ──
				await sleep(1100);
				const before = (await pings(peer)).filter((p) => p.playerId === me).length;
				const burst = await table.page.evaluate(() =>
					Array.from({ length: 6 }, (_, i) => window.__tableplace!.ping(i, 0))
				);
				ok(
					JSON.stringify(burst) === JSON.stringify([true, true, false, false, false, false]),
					`the burst was not limited to two: ${JSON.stringify(burst)}`
				);
				await sleep(1500);
				const after = (await pings(peer)).filter((p) => p.playerId === me).length;
				ok(after - before === 2, `the second client drew ${after - before} of the burst, not 2`);
				ok(await table.connected(), 'the relay dropped the pinger');

				assertClean(table, 'after pinging');
				assertClean(peer, 'on the second client, watching pings');
			} finally {
				await remote?.close();
				await peerContext.close();
				await table.close();
			}
		}
	},
	{
		/**
		 * Held-by (tableplace-199), two real clients in separate browser contexts
		 * (two localStorages, so two player ids). Seat 0 presses a piece and
		 * carries it without letting go. Seat 1 must see the hold arrive in the
		 * same patches as the move, draw it in seat 0's colour, and get nowhere
		 * with a drag of its own: a toast, and the piece stays where seat 0 has
		 * it. Once seat 0 lets go the hold is gone for both and seat 1 can move
		 * it. Last, a holder that disconnects mid-hold: a bare relay client takes
		 * the piece and drops its socket, and seat 1 can move it again.
		 */
		name: 'held-by: seat 0 holds a piece, and seat 1 cannot drag it until it is let go',
		run: async (context) => {
			const lobby = nextLobby('held-by');
			const table = await openTable(context.browser, context.servers, lobby);
			const peerContext = await context.browser.createBrowserContext();
			let remote: Table | null = null;
			let holder: Awaited<ReturnType<typeof relayPeer>> | null = null;
			const heldBy = (t: Table, id: string) =>
				t.page.evaluate(
					(pieceId) => window.__tableplace!.state()?.pieces?.[pieceId]?.heldBy ?? null,
					id
				);
			const marks = (t: Table) => t.page.evaluate(() => window.__tableplace!.heldMarks());
			try {
				const deck = await table.seedDeck();
				const piece = await table.spawn('token', { name: 'Marker', position: ON_FELT(1) });
				await table.settle();
				const seat0 = (await table.page.evaluate(() => window.__tableplace!.actions.getMyId()))!;
				remote = await openTable(peerContext, context.servers, lobby);
				const peer = remote;
				await peer.page.evaluate(() => window.__tableplace!.actions.setSeat(1));
				await peer.settle(1500);
				await assertRenders(peer, piece, 'the piece (seat 1)');

				// seat 0 picks the piece up and keeps the button down
				const at = await table.locate(piece);
				ok(at, 'the piece never mounted for seat 0');
				await table.page.mouse.move(at!.x, at!.y);
				await sleep(80);
				await table.page.mouse.down();
				await sleep(80);
				for (let step = 1; step <= 8; step++) {
					await table.page.mouse.move(at!.x, at!.y + step * 12);
					await sleep(30);
				}
				await sleep(400);
				ok(
					(await table.page.evaluate(() => window.__tableplace!.drag().isDragging)) === piece,
					'seat 0 never picked the piece up'
				);
				// a hand holding something is never perfectly still: keep seat 0's
				// pointer nudging while seat 1 waits, so a loaded runner that
				// coalesced the first frames still gets a carry patch through
				let nudge = 0;
				const seen = await eventually(
					async () => {
						nudge = 1 - nudge;
						await table.page.mouse.move(at!.x + nudge * 3, at!.y + 96);
						return heldBy(peer, piece);
					},
					(who) => who === seat0,
					30_000
				);
				ok(seen === seat0, `seat 1 never learned seat 0 holds the piece (heldBy ${seen})`);
				const drawn = await eventually(
					() => marks(peer),
					(m) => m.some((mark) => mark.id === piece)
				);
				const mark = drawn.find((m) => m.id === piece);
				ok(
					mark?.holder === seat0 && mark.color.toLowerCase() === '#ff6b8a',
					`seat 1 does not draw seat 0's hold in seat 0's colour: ${JSON.stringify(drawn)}`
				);
				ok(
					(await marks(table)).length === 0,
					`seat 0 draws a hold mark on its own carry: ${JSON.stringify(await marks(table))}`
				);

				// seat 1 grabs at it: refused, and the piece stays in seat 0's hand
				const held = (await table.positionOf(piece))!;
				// the toast lives 1.8 s and a loaded runner's drag gesture can outlast
				// it, so every toast seat 1 shows is recorded from before the grab
				await peer.page.evaluate(() => {
					const seen: string[] = [];
					(window as unknown as { __toasts: string[] }).__toasts = seen;
					new MutationObserver(() => {
						for (const el of document.querySelectorAll('[role="status"]'))
							if (el.textContent) seen.push(el.textContent);
					}).observe(document.body, { childList: true, subtree: true, characterData: true });
				});
				await peer.dragBy(piece, DRAG.dx, DRAG.dy);
				ok(
					(await peer.page.evaluate(() => window.__tableplace!.drag().isDragging)) === null,
					'seat 1 picked up a piece seat 0 is holding'
				);
				const toasts = await eventually(
					() => peer.page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts),
					(seen) => seen.some((text) => /is holding that/.test(text)),
					4000
				);
				ok(
					toasts.some((text) => text.includes(`${seat0} is holding that`)),
					`seat 1's refused grab did not say who is holding the piece: ${JSON.stringify(toasts)}`
				);
				await sleep(600);
				const still = (await table.positionOf(piece))!;
				ok(
					planarDistance(still, held) < 0.05 && (await heldBy(table, piece)) === seat0,
					`seat 1's grab moved the held piece: ${JSON.stringify(held)} → ${JSON.stringify(still)}`
				);

				// seat 0 lets go: the hold comes off for both, and seat 1 can move it
				await table.page.mouse.up();
				const released = await eventually(
					() => heldBy(peer, piece),
					(who) => who === null
				);
				ok(released === null, `the hold outlived the drop on seat 1 (heldBy ${released})`);
				ok((await heldBy(table, piece)) === null, 'the hold outlived the drop on seat 0');
				const cleared = await eventually(
					() => marks(peer),
					(m) => m.length === 0
				);
				ok(cleared.length === 0, `seat 1 still draws a hold: ${JSON.stringify(cleared)}`);
				await assertDraggable(peer, piece, 'the piece (seat 1, after seat 0 let go)');

				// a holder who disconnects mid-hold: their hold reads as released
				holder = await relayPeer(context.servers.relay, lobby, 'e2e-holder');
				holder.send({
					players: {
						'e2e-holder': { id: 'e2e-holder', seat: 2, joinTimestamp: Date.now(), tray: {} }
					},
					pieces: { [piece]: { heldBy: 'e2e-holder' } }
				});
				const ghost = await eventually(
					() => marks(peer),
					(m) => m.some((mark) => mark.holder === 'e2e-holder')
				);
				ok(
					ghost.some((m) => m.holder === 'e2e-holder'),
					`seat 1 never drew the relay client's hold: ${JSON.stringify(ghost)}`
				);
				holder.close();
				holder = null;
				const gone = await eventually(
					() => marks(peer),
					(m) => m.length === 0
				);
				ok(
					gone.length === 0,
					`a disconnected holder's hold is still drawn: ${JSON.stringify(gone)}`
				);
				await assertDraggable(peer, piece, 'the piece (seat 1, after its holder disconnected)');

				await assertDraggable(table, deck, 'deck (after holds came and went)');
				assertClean(table, 'after holding a piece');
				assertClean(peer, 'on seat 1, after a refused grab');
				await peer.snap('held-by');
			} finally {
				holder?.close();
				await remote?.close();
				await peerContext.close();
				await table.close();
			}
		}
	},
	{
		/**
		 * tableplace-206: the first-run checklist. A fresh browser (its own
		 * context, so nothing a spec before it did is already ticked) sees the
		 * strip with nothing done; a real F over a loose card ticks the flip
		 * item. The strip never covers the hand, the hint bar or the log, wide
		 * or narrow, and never takes the pointer. The × hides it for good in
		 * this browser — a reload keeps it hidden — and `?` brings it back with
		 * its ticks. A table whose scenario says `coach: false` hides it.
		 */
		name: 'checklist: F ticks the flip item, clear of hand, hint bar and log, dismissal remembered',
		run: async (context) => {
			const fresh = await context.browser.createBrowserContext();
			const table = await openTable(fresh, context.servers, nextLobby('checklist')).catch(
				async (error) => {
					await fresh.close();
					throw error;
				}
			);
			try {
				let page = table.page;
				await page.setViewport({ width: 1280, height: 720 });
				const strip = () =>
					page.evaluate(() => {
						const root = document.querySelector('[data-testid="coach"]');
						if (!root) return null;
						const items = [...root.querySelectorAll<HTMLElement>('[data-coach-item]')];
						return {
							items: items.map((li) => li.dataset.coachItem!),
							done: items
								.filter((li) => li.dataset.done === 'true')
								.map((li) => li.dataset.coachItem!)
						};
					});

				// ── a first visit: the strip is up, nothing ticked ─────────────
				const first = await eventually(strip, (s) => !!s);
				ok(first, 'the checklist strip is not on /play');
				ok(
					first!.items.includes('flip') && first!.items.length >= 7,
					`the strip does not list the verbs to try: ${JSON.stringify(first)}`
				);
				ok(first!.done.length === 0, `a fresh browser starts with ticks: ${JSON.stringify(first)}`);

				// ── F over a loose card ticks the flip item ────────────────────
				const deck = await table.seedDeck();
				await table.settle(1500);
				const card = await page.evaluate(
					(id) => window.__tableplace!.actions.drawFromTop(id, 1)[0]?.id ?? '',
					deck
				);
				ok(!!card, 'nothing came off the top of the deck');
				await table.settle(1500);
				await table.dragTo(card, -4, 1);
				await table.settle(900);
				const at = await table.locate(card);
				ok(at, 'the card is not on screen to hover');
				await page.mouse.move(at!.x, at!.y, { steps: 6 });
				const hovered = await eventually(
					() => page.evaluate(() => window.__tableplace!.drag().isHovered),
					(id) => id === card
				);
				ok(hovered === card, `the pointer is over ${card} but isHovered is ${hovered}`);
				const before = await table.page.evaluate(
					(id) => window.__tableplace!.state()?.cards?.[id]?.rotation?.[0],
					card
				);
				await page.keyboard.press('KeyF');
				const flipped = await eventually(
					() =>
						page.evaluate((id) => window.__tableplace!.state()?.cards?.[id]?.rotation?.[0], card),
					(r) => r !== before
				);
				ok(flipped !== before, 'F did not flip the hovered card');
				const ticked = await eventually(strip, (s) => !!s?.done.includes('flip'));
				ok(
					ticked?.done.includes('flip'),
					`flipping a card did not tick the flip item: ${JSON.stringify(ticked)}`
				);
				ok(
					ticked!.done.includes('move'),
					`dragging the card did not tick the move item: ${JSON.stringify(ticked)}`
				);
				const count = await page.evaluate(
					() => document.querySelector('[data-testid="coach-count"]')?.textContent ?? ''
				);
				ok(
					count === `${ticked!.done.length}/${ticked!.items.length}`,
					`the count reads "${count}" for ${JSON.stringify(ticked)}`
				);

				// ── clear of the hand, the hint bar and the log, wide and narrow
				for (const [label, width, height] of [
					['1280x720', 1280, 720],
					['400w', 400, 800]
				] as const) {
					await page.setViewport({ width, height });
					await page.mouse.move(width / 2, 60);
					await table.settle(600);
					const boxes = await page.evaluate(() => {
						const rect = (selector: string) => {
							const r = document.querySelector(selector)?.getBoundingClientRect();
							return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
						};
						const list = document
							.querySelector('[data-testid="coach"] ul')!
							.getBoundingClientRect();
						const under = document.elementFromPoint(
							list.left + list.width / 2,
							list.top + list.height / 2
						);
						return {
							strip: rect('[data-testid="coach"]'),
							hint: rect('[data-testid="hint-bar"]'),
							log: rect('[data-testid="journal"]'),
							takesPointer: !!under?.closest('[data-testid="coach"]')
						};
					});
					const { strip: box, hint, log } = boxes;
					ok(
						box && hint && log,
						`${label}: strip, hint bar or log missing: ${JSON.stringify(boxes)}`
					);
					type Box = NonNullable<typeof box>;
					const overlaps = (a: Box, b: Box) =>
						a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
					// HUDTrayScene: the hand is the bottom sixth of the canvas
					ok(
						box!.bottom <= (height * 5) / 6 && box!.top >= 0,
						`${label}: the strip overlaps the hand: ${JSON.stringify(box)}`
					);
					ok(
						!overlaps(box!, hint!),
						`${label}: the strip covers the hint bar: ${JSON.stringify(boxes)}`
					);
					ok(!overlaps(box!, log!), `${label}: the strip covers the log: ${JSON.stringify(boxes)}`);
					// the log grows upward to eight lines: where the columns share
					// pixels, the strip must clear a full log, not just this one
					const FULL_LOG_PX = 236;
					ok(
						box!.right <= log!.left || box!.bottom <= log!.bottom - FULL_LOG_PX,
						`${label}: a full log would reach the strip: ${JSON.stringify(boxes)}`
					);
					ok(
						box!.right <= width / 2,
						`${label}: the strip reaches into the preview's half: ${JSON.stringify(box)}`
					);
					ok(!boxes.takesPointer, `${label}: the strip takes the pointer`);
					await table.snap(`checklist-${label}`);
				}
				await page.setViewport({ width: 1280, height: 720 });
				await table.settle(400);

				// ── × hides it, and this browser remembers ──────────────────────
				await page.click('[data-testid="coach-dismiss"]');
				ok(
					await eventually(
						async () => (await strip()) === null,
						(gone) => gone,
						3000
					),
					'the × did not hide the strip'
				);
				const readyMs = Number(process.env.E2E_READY_MS ?? 60_000);
				await page.reload({ waitUntil: 'networkidle2', timeout: readyMs });
				await page.waitForFunction('window.__tableplace?.ready === true', { timeout: readyMs });
				await table.settle(1500);
				page = table.page;
				ok((await strip()) === null, 'the dismissed strip came back after a reload');

				// ── ? brings it back, ticks and all ─────────────────────────────
				await page.mouse.move(640, 120);
				await page.keyboard.down('Shift');
				await page.keyboard.press('Slash');
				await page.keyboard.up('Shift');
				await page.waitForSelector('[data-testid="coach-reopen"]', { timeout: 3000 });
				await page.click('[data-testid="coach-reopen"]');
				const back = await eventually(strip, (s) => !!s);
				ok(back, 'the ? reference did not bring the strip back');
				ok(back!.done.includes('flip'), `the ticks did not survive: ${JSON.stringify(back)}`);
				ok(
					await page.evaluate(() => !document.querySelector('[data-testid="verb-reference"]')),
					'the ? reference stayed open after bringing the strip back'
				);

				// ── a table that says coach: false hides it ─────────────────────
				await page.evaluate(() => window.__tableplace!.actions.setCoach(false));
				ok(
					await eventually(
						async () => (await strip()) === null,
						(gone) => gone,
						3000
					),
					'a table with coach: false still shows the strip'
				);
				await page.evaluate(() => window.__tableplace!.actions.setCoach(null));
				ok(await eventually(strip, (s) => !!s), 'clearing coach: false did not bring it back');

				await assertDraggable(table, deck, 'deck (beside the checklist)');
				assertClean(table, 'after ticking, dismissing and reopening the checklist');
			} finally {
				await table.close();
				await fresh.close();
			}
		}
	},
	{
		/**
		 * tableplace-197: remote pointers. Two players in two browser contexts.
		 * The first moves a real mouse over the felt; the second must draw a
		 * cursor, in the pointer's seat colour, gliding to that table point. It
		 * only ever arrives on the ephemeral `camera` message — no new message
		 * type — and orbiting while pointing stays inside that stream's ~3 Hz
		 * throttle. The cursor fades once the mouse idles, goes the moment it
		 * leaves the canvas, and the setting hides it outright.
		 */
		name: 'remote pointers: the other player sees my cursor on the felt, inside the camera budget',
		run: async (context) => {
			const lobby = nextLobby('pointers');
			const table = await openTable(context.browser, context.servers, lobby);
			const peerContext = await context.browser.createBrowserContext();
			let remote: Table | null = null;
			const pointers = (t: Table) => t.page.evaluate(() => window.__tableplace!.remotePointers());
			const myId = (t: Table) => t.page.evaluate(() => window.__tableplace!.actions.getMyId());
			// SEAT_COLOR in src/lib/hud/players.ts
			const SEAT_COLOR: Record<number, string> = {
				0: '#ff6b8a',
				1: '#6ee7a0',
				2: '#b98cff',
				3: '#ff8a3d'
			};
			const project = (t: Table, x: number, z: number) =>
				t.page.evaluate((w) => window.__tableplace!.project(w), [x, TABLE_TOP_Y, z] as [
					number,
					number,
					number
				]);
			try {
				const piece = await table.spawn('token', { name: 'Marker', position: ON_FELT(1) });
				await table.settle();
				remote = await openTable(peerContext, context.servers, lobby);
				const peer = remote;
				await peer.page.evaluate(() => window.__tableplace!.actions.setSeat(1));
				await peer.settle(1500);
				await assertRenders(peer, piece, 'the piece (second client)');
				const [me, them] = [await myId(table), await myId(peer)];
				ok(me && them && me !== them, `the two clients are not two players: ${me} / ${them}`);

				// count every message the pointing client puts on the wire, by type
				await table.page.evaluate(() => {
					const w = window as unknown as {
						__sends?: { type: string; at: number; data: string }[];
					};
					w.__sends = [];
					const send = WebSocket.prototype.send;
					WebSocket.prototype.send = function (data) {
						const type = typeof data === 'string' ? /"type":"(\w+)"/.exec(data)?.[1] : null;
						// the socket's own keepalive (a bare `{"type":"ping"}` every 30s)
						// is not the table's traffic
						if (data === '{"type":"ping"}') return send.call(this, data);
						w.__sends!.push({
							type: type ?? '?',
							at: performance.now(),
							data: String(data).slice(0, 160)
						});
						return send.call(this, data);
					};
				});
				const sends = () =>
					table.page.evaluate(
						() =>
							(window as unknown as { __sends: { type: string; at: number; data: string }[] })
								.__sends
					);

				// ── point at the felt: the other player draws it there, in my colour ──
				const spot: [number, number] = [6, 4];
				const at = await project(table, ...spot);
				ok(at, 'the felt spot projects off-screen');
				ok(
					(await table.elementAt(at!)).startsWith('canvas'),
					`the felt spot is under a pane: ${await table.elementAt(at!)}`
				);
				// a real sweep in, not a teleport — the stream gates on movement
				await table.page.mouse.move(at!.x - 120, at!.y - 60);
				await table.page.mouse.move(at!.x, at!.y, { steps: 12 });
				const seen = await eventually(
					() => pointers(peer),
					(list) =>
						list.some(
							(p) =>
								p.playerId === me && p.visible && Math.hypot(p.x - spot[0], p.z - spot[1]) < 0.5
						),
					20_000
				);
				const mine = seen.find((p) => p.playerId === me);
				ok(
					mine?.visible,
					`the second client never drew the first player's pointer: ${JSON.stringify(seen)}`
				);
				ok(
					Math.hypot(mine!.x - spot[0], mine!.z - spot[1]) < 0.5,
					`the pointer is drawn at ${mine!.x},${mine!.z}, not the pointed-at ${spot.join(',')}`
				);
				const seat = await peer.page.evaluate(
					(pid) => window.__tableplace!.state()?.players?.[pid]?.seat,
					me!
				);
				ok(
					typeof seat === 'number'
						? mine!.color === SEAT_COLOR[seat]
						: Object.values(SEAT_COLOR).includes(mine!.color ?? ''),
					`the pointer is ${mine!.color}, not the pointer's seat colour (seat ${seat})`
				);
				ok(
					!(await pointers(table)).some((p) => p.playerId === me && p.visible),
					'the first client draws its own pointer'
				);
				await peer.snap('remote-pointer');

				// it rode the camera message: nothing but `camera` went out for it
				const pointed = await sends();
				ok(
					pointed.some((m) => m.type === 'camera'),
					`pointing sent no camera sample: ${JSON.stringify(pointed)}`
				);
				ok(
					pointed.every((m) => m.type === 'camera'),
					`pointing sent something other than camera samples: ${JSON.stringify(pointed.filter((m) => m.type !== 'camera'))}`
				);
				ok(
					!(await table.page.evaluate(() => JSON.stringify(window.__tableplace!.state()))).includes(
						'"c":['
					),
					'a pointer leaked into lobby state'
				);

				// ── orbiting while pointing stays inside the camera budget ──
				await sleep(800);
				const before = (await sends()).length;
				const t0 = await table.page.evaluate(() => performance.now());
				await table.page.mouse.move(at!.x, at!.y);
				await table.page.mouse.down({ button: 'right' });
				for (let i = 0; i < 60; i++) {
					// right-drag orbits; the cursor sweeps the felt as it goes
					await table.page.mouse.move(at!.x + Math.sin(i / 6) * 140, at!.y + Math.cos(i / 9) * 50);
					await sleep(40);
				}
				await table.page.mouse.up({ button: 'right' });
				await sleep(800); // the trailing sample
				const t1 = await table.page.evaluate(() => performance.now());
				const burst = (await sends()).slice(before);
				ok(
					burst.every((m) => m.type === 'camera'),
					`orbiting while pointing sent other messages: ${JSON.stringify(burst.map((m) => m.type))}`
				);
				const rate = burst.length / ((t1 - t0) / 1000);
				ok(
					burst.length > 2 && rate <= 3.2,
					`orbit + pointer: ${burst.length} sends in ${Math.round(t1 - t0)}ms (${rate.toFixed(2)}/s) — the camera budget is ≤ ~3/s`
				);
				for (let i = 1; i < burst.length; i++)
					ok(
						burst[i]!.at - burst[i - 1]!.at > 250,
						`two camera samples ${Math.round(burst[i]!.at - burst[i - 1]!.at)}ms apart — the throttle is 350ms`
					);
				ok(await table.connected(), 'the relay dropped the pointing client');

				// ── idle: the cursor fades out after ~3s without movement ──
				// the orbit's damping tail moves the point under a still mouse; on a
				// starved renderer it runs for seconds, so let it land first
				await settleCamera(table);
				const now = await project(table, ...spot);
				await table.page.mouse.move(now!.x - 80, now!.y, { steps: 6 });
				await table.page.mouse.move(now!.x, now!.y, { steps: 6 });
				await eventually(
					() => pointers(peer),
					(list) => list.some((p) => p.playerId === me && p.visible),
					10_000
				);
				const faded = await eventually(
					() => pointers(peer),
					(list) => !list.some((p) => p.playerId === me && p.visible),
					10_000
				);
				ok(
					!faded.some((p) => p.playerId === me && p.visible),
					`the pointer did not fade after the mouse idled: ${JSON.stringify(faded)}`
				);

				// ── leaving the canvas takes it away at once ──
				await table.page.mouse.move(now!.x + 60, now!.y, { steps: 6 });
				await eventually(
					() => pointers(peer),
					(list) => list.some((p) => p.playerId === me && p.visible),
					10_000
				);
				const viewport = table.page.viewport()!;
				let off: { x: number; y: number } | null = null;
				for (const candidate of [
					{ x: viewport.width - 30, y: 30 },
					{ x: 30, y: 30 },
					{ x: viewport.width - 30, y: viewport.height - 30 },
					{ x: 30, y: viewport.height - 30 }
				])
					if (!(await table.elementAt(candidate)).startsWith('canvas')) {
						off = candidate;
						break;
					}
				ok(off, 'no DOM pane over the canvas to move the mouse onto');
				await table.page.mouse.move(off!.x, off!.y, { steps: 4 });
				const left = await eventually(
					() => pointers(peer),
					(list) => !list.some((p) => p.playerId === me && p.visible),
					// well under the idle fade: this is the leave, not the timeout
					2_500
				);
				ok(
					!left.some((p) => p.playerId === me && p.visible),
					`the pointer stayed up after the mouse left the canvas: ${JSON.stringify(left)}`
				);

				// ── the setting hides remote pointers ──
				await peer.page.evaluate(() => window.__tableplace!.setRemotePointers(false));
				await table.page.mouse.move(now!.x, now!.y, { steps: 8 });
				await sleep(1500);
				ok(
					!(await pointers(peer)).some((p) => p.playerId === me),
					'the setting is off but the second client still draws the pointer'
				);
				await peer.page.evaluate(() => window.__tableplace!.setRemotePointers(true));
				await table.page.mouse.move(now!.x + 40, now!.y, { steps: 8 });
				const back = await eventually(
					() => pointers(peer),
					(list) => list.some((p) => p.playerId === me && p.visible),
					10_000
				);
				ok(
					back.some((p) => p.playerId === me && p.visible),
					'the pointer did not come back with the setting'
				);

				await assertDraggable(peer, piece, 'the piece, under a remote pointer');
				assertClean(table, 'after pointing');
				assertClean(peer, 'on the second client, watching a pointer');
			} finally {
				await remote?.close();
				await peerContext.close();
				await table.close();
			}
		}
	}
];
