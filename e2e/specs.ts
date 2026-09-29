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
import { setTimeout as sleep } from 'node:timers/promises';
import { ok, planarDistance } from './assert';
import type { Servers } from './servers';
import { openTable, type Intent, type Table, type TableOptions, type WireFrame } from './table';

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
async function assertDraggable(table: Table, id: string, label: string): Promise<void> {
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

	await table.dragBy(id, DRAG.dx, DRAG.dy);
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
 * Everything about an outbound frame that legitimately differs between two runs
 * of the same gesture, taken out: the clock (`timestamp`), the per-actor intent
 * counter (`seq`), and every number — which for a drag's positions is a mouse
 * pixel nobody can hit twice.
 *
 * Entity IDS, field KEYS, intent VERBS and message ORDER all survive, which is
 * what "identical on the wire" has to mean for the referee seam
 * (tableplace-171): a gate that added a message, a field or a verb, or that
 * withheld one, changes at least one of those on every single frame.
 */
const VOLATILE = new Set(['timestamp', 'seq']);
function wireShape(value: unknown): unknown {
	if (typeof value === 'number') return 0;
	if (Array.isArray(value)) return value.map(wireShape);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !VOLATILE.has(key))
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, wireShape(nested)])
		);
	return value;
}

const wireKey = (frames: WireFrame[]) => JSON.stringify(frames.map(wireShape));

/** the reserved key the intents ride under — `store/game/intents.ts` */
const INTENTS_KEY = '__intents';

/**
 * Outbound traffic sorted into the three things it actually is, so each can be
 * compared by the standard it can actually meet:
 *
 *  - `actions` — `update` frames carrying an intent. ONE FOR ONE AND IN ORDER:
 *    a gesture mints exactly one, so a gate that swallowed, doubled or
 *    re-ordered an action shows up here on the first frame.
 *  - `patches` — `update` frames with no verb behind them, i.e. the anonymous
 *    per-frame drag stream. Compared as a SET OF SHAPES, because how many of
 *    them the 200ms throttle coalesces depends on real mouse timing and never
 *    was reproducible. What must not change is the KINDS that appear.
 *  - `transport` — everything that is not a patch at all: the camera presence
 *    samples and the socket's `ping` keepalive, each on a timer of its own.
 *    Compared as a set of message TYPES: a gate has no business inventing one.
 */
function outbound(frames: WireFrame[]) {
	const updates = frames.filter((frame) => frame.type === 'update');
	const acted = (frame: WireFrame) => Array.isArray(frame.value?.[INTENTS_KEY]);
	const shapes = (of: WireFrame[]) =>
		[...new Set(of.map((frame) => JSON.stringify(wireShape(frame))))].sort();
	const actions = updates.filter(acted);
	return {
		actions: wireKey(actions),
		verbs: actions.flatMap((frame) =>
			(frame.value![INTENTS_KEY] as Intent[]).map((intent) => intent.verb)
		),
		patches: shapes(updates.filter((frame) => !acted(frame))),
		transport: [
			...new Set(
				frames.filter((frame) => frame.type !== 'update').map((frame) => frame.type ?? '?')
			)
		].sort()
	};
}

/** the only top-level keys an `update` message has ever had (see createWsMetaData) */
const FRAME_KEYS = ['playerId', 'timestamp', 'type', 'value'];
/** GameDTO's collections, plus the intent channel's piggyback (tableplace-169) */
const VALUE_KEYS = ['cards', 'decks', 'players', 'overlays', 'pieces', 'snapPoints', '__intents'];

async function withTable(
	context: { browser: Browser; servers: Servers },
	name: string,
	body: (table: Table) => Promise<void>,
	options: TableOptions = {}
): Promise<void> {
	const table = await openTable(context.browser, context.servers, nextLobby(name), options);
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
		name: 'deck gestures: tap draws, drag draws into the drag, the wheel moves the pile',
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
				const dragOwner = () => table.page.evaluate(() => window.__tableplace!.drag().isDragging);

				// ── tap: one card to the felt, deck stays put ─────────────────
				const start = await deckCount();
				const tapAt = await table.locate(deck);
				ok(tapAt, 'the deck never mounted — nothing to tap');
				await table.page.mouse.click(tapAt!.x, tapAt!.y);
				// polled: the count is store truth, but a loaded runner can lag
				// processing the click itself
				const afterTap = await eventually(deckCount, (count) => count === start - 1);
				ok(
					afterTap === start - 1 && (await looseCards()).length === 1,
					`a tap did not draw exactly one card: deck ${start} → ${afterTap}, ` +
						`${(await looseCards()).length} loose`
				);

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
		 * here with a real pointer: a counter's value, a bag's count and a deck's
		 * card count wear their badges with no hover anywhere; a plain piece's
		 * name badge mounts under the pointer and unmounts when it leaves; and a
		 * real click on the counter kicks the value-change pulse (the badge's
		 * scale springs toward 1.6, then settles back to rest).
		 */
		name: 'badges: hover-only labels, always-on counts, and the value pulse',
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
					[counter, 'the counter'],
					[bag, 'the bag'],
					[deck, 'the deck']
				] as const) {
					ok(!!(await badge(id)), `${label} (${id}) has no badge mounted without hover`);
				}

				// hover-only: the plain token wears its name only under the pointer
				ok(!(await badge(token)), 'the plain token mounted a badge with no pointer near it');
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

				// the pulse: a real click deals 1 damage (counter-input's plain-click
				// branch; shift-click is the heal) and the badge scale kicks toward
				// 1.6 before springing back to rest. The kick is watched FIRST — it
				// is instant on the value change, so waiting on the value and then
				// looking for the kick could miss a fast pulse entirely.
				const at = await table.locate(counter);
				ok(at, 'the counter never mounted — nothing to click');
				await table.page.mouse.click(at!.x, at!.y);
				const kicked = await eventually(
					() => badge(counter),
					(b) => !!b && b.scale > 1.15,
					5000
				);
				ok(
					!!kicked && kicked.scale > 1.15,
					`the value change never kicked the badge pulse: ${JSON.stringify(kicked)}`
				);
				const value = await eventually(
					() =>
						table.page.evaluate(
							(id) => window.__tableplace!.state()?.pieces?.[id]?.value ?? null,
							counter
						),
					(v) => v === 4
				);
				ok(value === 4, `the click did not damage the counter to 4: ${JSON.stringify(value)}`);
				const rested = await eventually(
					() => badge(counter),
					(b) => !!b && Math.abs(b.scale - 1) < 0.05
				);
				ok(
					!!rested && Math.abs(rested.scale - 1) < 0.05,
					`the pulse never settled back to rest: ${JSON.stringify(rested)}`
				);

				// badges must not have cost the table its raycast
				await assertDraggable(table, counter, 'the counter (wearing its badge)');
				await assertDraggable(table, deck, 'deck (with badges on the table)');
				assertClean(table, 'at the end of the badge suite');

				// the train's visual evidence: counter, bag and deck badges always-on,
				// and the token hovered so its name badge is in the frame too
				const pose = await table.locate(token);
				if (pose) await table.page.mouse.move(pose.x, pose.y);
				await table.snap('badges');
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
		 * The last section is the promise this ticket makes to Piece.svelte: a
		 * piece still owns its own right-click (a counter heals), and the felt
		 * behind it must not answer for it with a table wheel.
		 */
		name: 'radial: quick right-click sticks, Escape and click-away cancel, pieces keep theirs',
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

				// ── a piece still owns its right-click, and the felt behind it
				//    must not open a table wheel over the top of it ────────────
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
				await table.page.mouse.click(over!.x, over!.y, { button: 'right' });
				await table.settle(600);
				ok(!(await table.radial()), 'right-clicking a counter opened the radial menu over it');
				const healed = await eventually(
					() =>
						table.page.evaluate(
							(id) => window.__tableplace!.state()?.pieces?.[id]?.value ?? null,
							counter
						),
					(value) => value === 6
				);
				ok(
					healed === 6,
					`the counter's own right-click stopped healing: ${JSON.stringify(healed)}`
				);

				await assertDraggable(table, deck, 'deck (after the sticky wheel)');
				assertClean(table, 'after the sticky wheel suite');
				await table.snap('radial-sticky');
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
				// seat-0 camera looks straight down, so -Z is up on screen) — which
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
		 * Camera bindings, before and after this ticket: a right drag that never
		 * held still is still a pan (the wheel let go of it), and W/A/S/D pan
		 * screen-relatively while held.
		 *
		 * The last two assertions are the ones with teeth. Typing must pan
		 * nothing — every table route binds bare letters, and a lobby name with a
		 * W in it would otherwise walk the camera off the felt. And a long held
		 * pan must leave the socket UP: the relay disconnects (it does not drop)
		 * over ~7 msg/s, so a pan that broadcast per frame instead of riding
		 * cameraStream's throttle would end the session outright.
		 */
		name: 'camera: right quick-drag pans, WASD pans screen-relatively, typing pans nothing',
		run: (context) =>
			withTable(context, 'camera-pan', async (table) => {
				const deck = await table.seedDeck();
				await table.settle(1000);
				const eye = async () => (await table.cameraPose())!.position;

				// ── a right drag that never holds still is a pan ──────────────
				const felt = await table.page.evaluate(() => window.__tableplace!.project([0, 0.26, 4]));
				ok(felt, 'the felt press point projects off-screen');
				const beforeDrag = await eye();
				await table.page.mouse.move(felt!.x, felt!.y);
				await sleep(60);
				await table.page.mouse.down({ button: 'right' });
				// travel immediately: no still hold, so nothing may open
				for (let step = 1; step <= 10; step++) {
					await table.page.mouse.move(felt!.x + step * 18, felt!.y);
					await sleep(20);
				}
				ok(!(await table.radial()), 'a right quick-drag opened the wheel instead of panning');
				await table.page.mouse.up({ button: 'right' });
				await table.settle(500);
				const afterDrag = await eye();
				ok(
					planarDistance(beforeDrag, afterDrag) > 0.5,
					`the right quick-drag did not pan the camera: ${JSON.stringify(beforeDrag)} → ${JSON.stringify(afterDrag)}`
				);

				// ── W pans away from the viewer, D to the right ───────────────
				const beforeKeys = await eye();
				await table.page.keyboard.down('KeyW');
				await sleep(900);
				await table.page.keyboard.up('KeyW');
				await table.settle(500);
				const afterW = await eye();
				ok(
					afterW[2]! < beforeKeys[2]! - 0.5,
					`W did not pan away from the viewer: ${JSON.stringify(beforeKeys)} → ${JSON.stringify(afterW)}`
				);
				await table.page.keyboard.down('KeyD');
				await sleep(900);
				await table.page.keyboard.up('KeyD');
				await table.settle(500);
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
				await table.settle(1200);
				const home = await eye();
				ok(
					planarDistance(home, [0, 25, 0]) < 0.5,
					`C did not bring the camera home after panning: ${JSON.stringify(home)}`
				);
				await table.dragTo(deck, 0, 0);
				await table.settle(600);
				await assertDraggable(table, deck, 'deck (after panning the camera)');
				assertClean(table, 'after the camera pan suite');
				await table.snap('camera-pan');
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
		 * The intent channel (tableplace-169): every named action has to reach
		 * BOTH clients, in the same order, carrying the same `{seq, seat, verb,
		 * args}` — the patch alone was never enough to say what happened.
		 *
		 * Two browser contexts, not two tabs: tabs share localStorage and would
		 * therefore share `myPlayerId`, which makes them one player the relay
		 * excludes from its own broadcast (see `TableOptions.isolated`). The
		 * gesture list is deliberately mixed — a mouse drag whose patch goes
		 * through the position throttle, two immediate deck verbs, and one action
		 * from the *other* client, because an observer wired to only one of the
		 * two apply paths is blind to half the game.
		 */
		name: 'intents: two clients see the same verbs in the same order',
		run: async (context) => {
			const lobby = nextLobby('intents');
			const host = await openTable(context.browser, context.servers, lobby);
			try {
				const deck = await host.seedDeck();
				const token = await host.spawn('token', { name: 'Scout', position: LANE(1) });
				await host.settle(1200);

				const guest = await openTable(context.browser, context.servers, lobby, {
					isolated: true
				});
				try {
					await guest.settle(1500); // join, sync, prewarm the seeded deck's faces
					// the guest acts on the token below, so it has to have arrived —
					// a fixed sleep here would read a slow sync as a lost intent
					ok(
						await eventually(
							() => guest.positionOf(token),
							(position) => !!position
						),
						'the seeded token never reached the second client — nothing to act on'
					);
					const seats = await Promise.all([
						host.page.evaluate(() => window.__tableplace!.actions.getMyId() ?? ''),
						guest.page.evaluate(() => window.__tableplace!.actions.getMyId() ?? '')
					]);
					ok(
						seats[0] && seats[1] && seats[0] !== seats[1],
						`the two clients are the same player (${seats[0]} / ${seats[1]}) — ` +
							`the relay excludes a sender from its own broadcast, so neither would ` +
							`ever receive the other`
					);

					// everything up to here is setup — join handshakes, the seeded
					// deck, seat rows. The comparison is about the scripted gesture.
					await host.clearIntents();
					await guest.clearIntents();

					// a card off the top, then flipped: two collections in one patch,
					// then a rotation-only one
					const card = await host.page.evaluate((deckId) => {
						const before = new Set(Object.keys(window.__tableplace!.state()?.cards ?? {}));
						window.__tableplace!.actions.drawFromTop(deckId, 1);
						return (
							Object.keys(window.__tableplace!.state()?.cards ?? {}).find(
								(id) => !before.has(id)
							) ?? ''
						);
					}, deck);
					ok(card, 'drawFromTop put no new card on the table to flip');
					await host.settle(500);
					await host.page.evaluate((id) => window.__tableplace!.actions.flipCard(id), card);
					await host.settle(500);
					await host.page.evaluate((id) => window.__tableplace!.actions.shuffleDeck(id), deck);
					await host.settle(500);
					// a real mouse drag: its landing patch carries a position, so it
					// goes through the 200ms coalescing throttle on its way out
					await host.dragBy(token, 0, 130);
					await host.settle(900);
					// and one from the other side, so this is not a one-way street
					await guest.page.evaluate(
						(id) => window.__tableplace!.actions.rotatePiece(id, 90),
						token
					);
					await guest.settle(900);

					const EXPECTED = ['drawFromTop', 'flipCard', 'shuffleDeck', 'moveEntity', 'rotatePiece'];
					const key = (intents: Intent[]) =>
						JSON.stringify(intents.map((i) => [i.seat, i.seq, i.verb, i.args]));

					let hostSaw: Intent[] = [];
					let guestSaw: Intent[] = [];
					await eventually(
						async () => {
							[hostSaw, guestSaw] = await Promise.all([host.intents(), guest.intents()]);
							return hostSaw.length >= EXPECTED.length && key(hostSaw) === key(guestSaw);
						},
						(matched) => matched,
						12_000
					);

					ok(
						key(hostSaw) === key(guestSaw),
						`the two clients disagree about what happened:\n  host  ${key(hostSaw)}\n  guest ${key(guestSaw)}`
					);
					ok(
						JSON.stringify(hostSaw.map((i) => i.verb)) === JSON.stringify(EXPECTED),
						`the scripted gesture did not read as ${JSON.stringify(EXPECTED)}: ` +
							`${JSON.stringify(hostSaw.map((i) => i.verb))}`
					);
					// the verb is only half of it — an engine needs what it was aimed at
					ok(
						hostSaw[1]?.args?.[0] === card && hostSaw[2]?.args?.[0] === deck,
						`the arguments did not survive the wire: ${JSON.stringify(hostSaw.slice(1, 3))}`
					);
					// four from the host, the last from the guest — and numbered by
					// whoever acted, on their own counter, rather than renumbered on
					// arrival (which is what lets both clients agree on the list at all)
					const hostSeqs = hostSaw.slice(0, 4).map((i) => i.seq);
					ok(
						hostSaw.slice(0, 4).every((i) => i.seat === seats[0]) &&
							hostSeqs.every((seq, n) => n === 0 || seq > hostSeqs[n - 1]!) &&
							hostSaw[4]?.seat === seats[1],
						`the intents are not attributed to the seat that acted: ` +
							`${JSON.stringify(hostSaw.map((i) => [i.seat, i.seq]))}`
					);
					// and none of it leaked into game state on either client
					const leaked = await Promise.all(
						[host, guest].map((table) =>
							table.page.evaluate(() => Object.keys(window.__tableplace!.state() ?? {}))
						)
					);
					ok(
						!leaked.flat().includes('__intents'),
						`the piggybacked intents were merged into game state: ${JSON.stringify(leaked)}`
					);

					assertClean(host, 'on the acting client after the scripted gesture');
					assertClean(guest, 'on the watching client after the scripted gesture');
				} finally {
					await guest.close();
				}
			} finally {
				await host.close();
			}
		}
	},
	{
		/**
		 * The referee seam's headline requirement (tableplace-171): a table with no
		 * validator registered must behave EXACTLY as it did before the gate
		 * existed. Games with no rules engine pay nothing.
		 *
		 * Proven at the wire rather than asserted. The same scripted gesture — two
		 * flips, two rotations and two real mouse drags over fixed entities — runs
		 * three times against a live relay while CDP records what actually left the
		 * socket: ungated, with the stub validator on (which allows everything the
		 * acting seat owns), and ungated again. All three must produce the same
		 * frames, in the same order, carrying the same collections, fields, ids and
		 * verbs. The third leg is not redundant: without it, a match between the
		 * first two could just mean the recording is insensitive.
		 *
		 * The frame-shape assertion is the other half. A gate that leaked anything
		 * of itself onto the wire — a verdict, a flag, a second message — would put
		 * a key here that a pre-gate build never sent, and the allowlists below are
		 * exactly what #169 left behind.
		 */
		name: 'gate: pass-through — an ungated gesture is identical on the wire',
		run: (context) =>
			withTable(
				context,
				'gate-passthrough',
				async (table) => {
					const owner = await table.myId();
					ok(owner, 'the table never rolled a player id — nothing owns anything');
					// owned by this seat, so the stub validator allows every leg below:
					// what is under test is the COST of a referee, not its rulings.
					//
					// Spaced out on purpose. The relay DISCONNECTS a client that sustains
					// more than ~7 messages a second, and a seed + spawn + draw fired back
					// to back on top of the join handshake trips it often enough to matter —
					// after which nothing this client sends reaches the socket at all, which
					// looks exactly like the silence a gate spec exists to prove.
					const deck = await table.seedDeck({ owner });
					await table.settle(500);
					const token = await table.spawn('token', { name: 'Scout', position: LANE(1) });
					await table.settle(500);
					const card = await table.page.evaluate((deckId) => {
						const before = new Set(Object.keys(window.__tableplace!.state()?.cards ?? {}));
						window.__tableplace!.actions.drawFromTop(deckId, 1);
						return (
							Object.keys(window.__tableplace!.state()?.cards ?? {}).find(
								(id) => !before.has(id)
							) ?? ''
						);
					}, deck);
					ok(card, 'drawFromTop put no card on the table to flip');
					await table.settle(1000);
					// and if the limit tripped anyway, say so here rather than three
					// assertions later as an inexplicably empty recording
					ok(
						await table.connected(),
						'the lobby socket closed during setup — nothing this client sends from here ' +
							'on reaches the wire, so the comparison below would be vacuous. The page ' +
							`said:\n  ${table.problems.map((p) => `[${p.kind}] ${p.text}`).join('\n  ')}`
					);

					/**
					 * Fixed entities and self-cancelling amounts, so the gesture leaves the
					 * table where it found it and can be replayed verbatim. Deliberately
					 * mixed: two immediate verbs (sent straight out) and two mouse drags
					 * (whose landing patches go through the 200ms coalescing throttle).
					 */
					const gesture = async () => {
						for (const angle of [90, -90]) {
							await table.page.evaluate(
								(id, by) => window.__tableplace!.actions.rotatePiece(id, by),
								token,
								angle
							);
							await table.settle(400);
						}
						for (let flip = 0; flip < 2; flip++) {
							await table.page.evaluate((id) => window.__tableplace!.actions.flipCard(id), card);
							await table.settle(400);
						}
						await table.dragBy(token, 0, 120);
						await table.settle(700);
						await table.dragBy(token, 0, -120);
						await table.settle(700);
					};

					const legs: {
						label: string;
						sent: ReturnType<typeof outbound>;
						recorded: WireFrame[];
					}[] = [];
					for (const [label, stub] of [
						['ungated', false],
						['stub validator on', true],
						['ungated again', false]
					] as const) {
						await table.setStubValidator(stub);
						await table.clearWire();
						await gesture();
						const recorded = await table.wire();
						legs.push({ label, sent: outbound(recorded), recorded });
					}
					await table.setStubValidator(false);

					const EXPECTED = [
						'rotatePiece',
						'rotatePiece',
						'flipCard',
						'flipCard',
						'moveEntity',
						'moveEntity'
					];
					const base = legs[0]!;
					ok(
						JSON.stringify(base.sent.verbs) === JSON.stringify(EXPECTED),
						`the ungated gesture did not reach the socket as ${JSON.stringify(EXPECTED)} — ` +
							`the comparison below would be comparing the wrong thing: ` +
							`${JSON.stringify(base.sent.verbs)}\n  ` +
							`socket open: ${await table.connected()}; ` +
							`${base.recorded.length} frame(s) recorded at all:\n  ` +
							base.recorded.map((frame) => JSON.stringify(frame)).join('\n  ')
					);
					ok(
						base.sent.patches.length > 0,
						'no drag-stream traffic was recorded at all — the comparison below would be vacuous'
					);
					// nothing but the presence stream and the socket's own keepalive rides
					// outside the patch channel — a gate that invented a message shows here
					ok(
						base.sent.transport.every((type) => type === 'camera' || type === 'ping'),
						`an outbound message type no pre-gate build sent: ${JSON.stringify(base.sent.transport)}`
					);
					for (const leg of legs.slice(1)) {
						for (const [what, mine, theirs] of [
							['ACTIONS', leg.sent.actions, base.sent.actions],
							[
								'unnamed patch KINDS',
								JSON.stringify(leg.sent.patches),
								JSON.stringify(base.sent.patches)
							]
						] as const) {
							ok(
								mine === theirs,
								`"${leg.label}" put different ${what} on the wire than "${base.label}" — ` +
									`the gate is not free:\n  ${base.label} ${theirs}\n  ${leg.label} ${mine}`
							);
						}
					}

					// and nothing of the gate itself is on the wire in the ungated case.
					// Only the patch channel is in scope: a `camera` frame's value is a
					// pose (`{p, t}`), not a GameDTO patch, and never was.
					const patches = (await table.wire()).filter((frame) => frame.type === 'update');
					const strayFrame = patches.find((frame) =>
						Object.keys(frame).some((key) => !FRAME_KEYS.includes(key))
					);
					ok(
						!strayFrame,
						`an outbound message carries a key no pre-gate build sent: ` +
							`${JSON.stringify(Object.keys(strayFrame ?? {}))}`
					);
					const strayValue = patches
						.flatMap((frame) => Object.keys(frame.value ?? {}))
						.find((key) => !VALUE_KEYS.includes(key));
					ok(
						!strayValue,
						`an outbound patch carries a collection no pre-gate build sent: ${strayValue}`
					);

					// an allowing referee refuses nothing, and says nothing
					const refusals = await table.refusals();
					ok(
						refusals.length === 0,
						`the referee refused an action on the acting seat's own entities: ${JSON.stringify(refusals)}`
					);
					assertClean(table, 'after the same gesture ran gated and ungated');
				},
				// what leaves the socket IS the assertion here, so the recorder is armed
				// before the page ever opens one (see TableOptions.wire)
				{ wire: true }
			)
	},
	{
		/**
		 * The gate ruling (tableplace-171), from both sides of the wire.
		 *
		 * With the stub validator on — one toy rule, "you may only act on entities
		 * your own seat owns" — the guest reaches for the host's token and the
		 * host's card. What must happen locally is a snap-back for the drag, a
		 * no-op for the flip and a toast carrying the validator's own reason. What
		 * must happen everywhere else is NOTHING: no patch, no broadcast, no minted
		 * intent, so the host's state and intent log are untouched and the guest's
		 * own socket carries not one frame naming either entity.
		 *
		 * That last assertion is the load-bearing one, and it is why this reads the
		 * wire directly: a drag streams positions per frame, so a gate that only
		 * ruled on the DROP would have shown the host the whole gesture before
		 * undoing it. The peer must be unable to tell it was attempted at all.
		 *
		 * Two browser contexts, not two tabs — see `TableOptions.isolated`.
		 */
		name: 'gate: the referee refuses another seat, and the peer never hears of it',
		run: async (context) => {
			const lobby = nextLobby('gate-deny');
			const host = await openTable(context.browser, context.servers, lobby);
			try {
				const hostId = await host.myId();
				ok(hostId, 'the host never rolled a player id — nothing would own the deck');
				const deck = await host.seedDeck({ owner: hostId });
				const hostToken = await host.spawn('token', { name: 'Sentry', position: LANE(1) });
				const hostCard = await host.page.evaluate((deckId) => {
					const before = new Set(Object.keys(window.__tableplace!.state()?.cards ?? {}));
					window.__tableplace!.actions.drawFromTop(deckId, 1);
					return (
						Object.keys(window.__tableplace!.state()?.cards ?? {}).find((id) => !before.has(id)) ??
						''
					);
				}, deck);
				ok(hostCard, 'drawFromTop put no host-owned card on the table to reach for');
				await host.settle(1200);

				// `wire: true` on the guest only: it is the acting client, and what has to
				// be provable is that ITS socket stayed silent
				const guest = await openTable(context.browser, context.servers, lobby, {
					isolated: true,
					wire: true
				});
				try {
					await guest.settle(1500); // join, sync, prewarm the seeded deck's faces
					const guestId = await guest.myId();
					ok(
						guestId && guestId !== hostId,
						`the two clients are the same player (${hostId} / ${guestId}) — the relay ` +
							`excludes a sender from its own broadcast, so neither would receive the other`
					);
					// the guest has to actually HAVE the host's entities before it can be
					// refused them; a fixed sleep would read a slow sync as a lost patch
					ok(
						await eventually(
							async () => (await guest.positionOf(hostToken)) && (await guest.positionOf(hostCard)),
							(arrived) => !!arrived
						),
						"the host's token and card never reached the guest — nothing to reach for"
					);

					await guest.setStubValidator(true);
					ok(
						await guest.page.evaluate(() => window.__tableplace!.stubValidatorEnabled()),
						'the stub validator did not install — is this a dev build?'
					);
					await guest.clearRefusals();
					await Promise.all([host.clearIntents(), guest.clearIntents()]);
					await guest.clearWire();

					const tokenBefore = await guest.positionOf(hostToken);
					const hostTokenBefore = await host.positionOf(hostToken);
					const hostCardBefore = await host.page.evaluate(
						(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
						hostCard
					);

					// ─── a refused drag: it lifts, follows the pointer, and snaps back ───
					await guest.dragBy(hostToken, 0, 130);
					const tokenAfter = await eventually(
						() => guest.positionOf(hostToken),
						(position) => planarDistance(tokenBefore, position) < 0.1
					);
					ok(
						planarDistance(tokenBefore, tokenAfter) < 0.1,
						`the refused drag did not snap back: ${JSON.stringify(tokenBefore)} → ` +
							`${JSON.stringify(tokenAfter)}`
					);
					ok(
						(await guest.page.evaluate(() => window.__tableplace!.drag().isDragging)) === null,
						'the refused drag never let go of the token'
					);

					// ─── a refused instantaneous verb: it simply does not apply ───
					await guest.page.evaluate((id) => window.__tableplace!.actions.flipCard(id), hostCard);
					await guest.settle(700);
					const guestCardRotation = await guest.page.evaluate(
						(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
						hostCard
					);
					ok(
						JSON.stringify(guestCardRotation) === JSON.stringify(hostCardBefore),
						`the refused flip turned the card anyway: ${JSON.stringify(hostCardBefore)} → ` +
							`${JSON.stringify(guestCardRotation)}`
					);

					// ─── the player was told why, in the validator's own words ───
					const refusals = await guest.refusals();
					ok(
						refusals.length === 2 &&
							refusals[0]?.verb === 'moveEntity' &&
							refusals[1]?.verb === 'flipCard',
						`the referee did not refuse exactly the drag and the flip: ${JSON.stringify(refusals)}`
					);
					const reason = refusals[0]!.reason;
					ok(
						/yours/.test(reason),
						`the refusal carries no reason a player could read: ${JSON.stringify(reason)}`
					);
					const shown = await guest.toasts();
					ok(
						shown.some((text) => text.includes(reason)),
						`the reason never reached the screen — toasts say ${JSON.stringify(shown)}, ` +
							`expected one carrying ${JSON.stringify(reason)}`
					);

					// ─── and the host heard none of it ───
					const hostTokenAfter = await host.positionOf(hostToken);
					ok(
						planarDistance(hostTokenBefore, hostTokenAfter) < 0.001,
						`the host's token moved for a refused drag: ${JSON.stringify(hostTokenBefore)} → ` +
							`${JSON.stringify(hostTokenAfter)}`
					);
					const hostCardAfter = await host.page.evaluate(
						(id) => window.__tableplace!.state()?.cards?.[id]?.rotation ?? null,
						hostCard
					);
					ok(
						JSON.stringify(hostCardAfter) === JSON.stringify(hostCardBefore),
						`the host's card turned for a refused flip: ${JSON.stringify(hostCardAfter)}`
					);
					const hostSaw = await host.intents();
					ok(
						hostSaw.length === 0,
						`the host was told about refused actions: ${JSON.stringify(hostSaw)}`
					);
					// the wire itself, not a report about it: not one frame the guest sent
					// may so much as name the entities it was refused
					const leaked = (await guest.wire()).filter(
						(frame) =>
							JSON.stringify(frame).includes(hostToken) || JSON.stringify(frame).includes(hostCard)
					);
					ok(
						leaked.length === 0,
						`the guest put ${leaked.length} frame(s) naming a refused entity on the socket:\n  ` +
							leaked.map((frame) => JSON.stringify(frame)).join('\n  ')
					);
					// and no minted intent stayed behind locally either
					const guestSaw = await guest.intents();
					ok(
						guestSaw.length === 0,
						`a refused action minted an intent on the acting client: ${JSON.stringify(guestSaw)}`
					);

					// ─── its own entities still work exactly as in #169's specs ───
					const guestToken = await guest.spawn('token', { name: 'Runner', position: LANE(2) });
					await guest.settle(900);
					await guest.dragBy(guestToken, 0, 130);
					await guest.settle(900);
					const moved = await guest.positionOf(guestToken);
					ok(
						planarDistance(LANE(2), moved) > 0.5,
						`the guest could not move its own token: ${JSON.stringify(moved)}`
					);
					const delivered = await eventually(
						() => host.intents(),
						(seen) => seen.some((intent) => intent.verb === 'moveEntity'),
						12_000
					);
					ok(
						JSON.stringify(delivered.map((i) => i.verb)) ===
							JSON.stringify(['addPiece', 'moveEntity']),
						`the allowed gesture did not reach the host as ["addPiece","moveEntity"]: ` +
							`${JSON.stringify(delivered.map((i) => i.verb))}`
					);
					ok(
						delivered.every((intent) => intent.seat === guestId),
						`the delivered intents are not attributed to the guest: ` +
							`${JSON.stringify(delivered.map((i) => i.seat))}`
					);
					ok(
						!!(await host.positionOf(guestToken)),
						"the guest's own token never reached the host at all"
					);

					assertClean(host, 'on the watching client after the referee refused the guest');
					assertClean(guest, 'on the refused client');
				} finally {
					await guest.close();
				}
			} finally {
				await host.close();
			}
		}
	}
];
