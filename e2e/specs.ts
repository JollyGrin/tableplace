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
				// C fits the content from the seat's angled view: wherever that is, it is
				// where C has to bring the camera back to after all the panning below
				await table.page.keyboard.press('KeyC');
				await settleCamera(table);
				const deckEye = await eye();

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
	}
];
