/**
 * Driving one table in one tab.
 *
 * Entities are spawned through `gameActions` (the same calls the HUD panes
 * make) but *moved with a real mouse*, because the bug this harness exists for
 * lives in the raycast between the two: dispatch is what breaks, not state. An
 * assertion that only round-tripped the store would have passed on the broken
 * build.
 */

import type { Browser, ConsoleMessage, Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Servers } from './servers';

export type Problem = { kind: 'console' | 'pageerror' | 'requestfailed'; text: string };
export type ScreenPoint = { x: number; y: number };
export type Intent = { seq: number; seat: string; verb: string; args: unknown[] };
/** a refusal the referee voiced on this client (tableplace-171) */
export type Refusal = { verb: string; reason: string };
/**
 * One message this client actually put on the socket — captured at
 * `WebSocket.prototype.send` itself (see `TableOptions.wire`), not reported by
 * the app about itself, which is the whole point when the property under test is
 * "nothing crossed the wire".
 */
export type WireFrame = {
	type?: string;
	playerId?: string;
	timestamp?: number;
	value?: Record<string, unknown>;
	/** the raw payload, kept when it was not JSON at all */
	raw?: string;
};

export type Table = {
	page: Page;
	/** everything the page complained about since it opened */
	problems: Problem[];
	/** the subset that is genuinely the app's fault (see IGNORED) */
	appProblems: () => Problem[];
	spawn: (kind: string, options?: Record<string, unknown>) => Promise<string>;
	/** this client's player id — the `<owner>` segment of everything it spawns */
	myId: () => Promise<string>;
	/**
	 * A standard 52-card deck, procedurally faced — no network.
	 *
	 * `owner` puts that id in the `card:<owner>:…` segment, which is where
	 * ownership lives (see `dev/stub-validator.ts`). Cards default to a shared
	 * `std` owner belonging to nobody, which is what every pre-gate spec wants;
	 * a spec about the referee passes a real player id so the deck has a seat.
	 */
	seedDeck: (options?: { owner?: string }) => Promise<string>;
	locate: (id: string) => Promise<ScreenPoint | null>;
	/** what the shared raycaster hits at a screen point — [] means dispatch is dead */
	hits: (point: ScreenPoint) => Promise<string[]>;
	/** the DOM element on top at a screen point — the table canvas, or a HUD pane covering it */
	elementAt: (point: ScreenPoint) => Promise<string>;
	/**
	 * The radial menu as it is on screen right now — its wedge slugs and where
	 * each one draws — or null while no wheel is up.
	 *
	 * Read from the DOM rather than from a store: the wedges are laid out at the
	 * same angles the selection maths picks by, so flicking at a wedge's own
	 * pixel is exactly the gesture a player makes, and "is the menu up" is the
	 * same question for a spec as for a player.
	 */
	radial: () => Promise<{ actions: string[]; wedges: Record<string, ScreenPoint> } | null>;
	/** press a button on an entity, hold still until the wheel opens, and leave it open */
	openRadial: (
		id: string,
		options?: { button?: 'left' | 'right'; timeoutMs?: number }
	) => Promise<{ actions: string[]; wedges: Record<string, ScreenPoint> }>;
	/** the live table camera — what a pan is measured with */
	cameraPose: () => Promise<{ position: number[]; direction: number[] } | null>;
	/** is the lobby socket still open (the relay drops rate-limit offenders) */
	connected: () => Promise<boolean>;
	/**
	 * The named actions this client has seen, its own and its peers', oldest
	 * first — the intent channel (tableplace-169). `{seq, seat}` is stamped by
	 * whoever acted, so two clients in one lobby must report identical lists.
	 */
	intents: () => Promise<Intent[]>;
	/** drop the log, so a spec compares only the gesture it is about to make */
	clearIntents: () => Promise<void>;
	/**
	 * Turn the dev stub validator on or off (tableplace-171) — the toy rule "you
	 * may only act on entities your own seat owns". Off is the shipped default,
	 * and a spec that never touches this is testing an ungated table, which is
	 * how every pre-existing spec keeps proving pass-through.
	 */
	setStubValidator: (on: boolean) => Promise<void>;
	/** every refusal the referee voiced here, oldest first, with the reason */
	refusals: () => Promise<Refusal[]>;
	clearRefusals: () => Promise<void>;
	/** the toast texts on screen right now — the player-facing half of a refusal */
	toasts: () => Promise<string[]>;
	/**
	 * Everything this client has put on the socket, in order — empty unless the
	 * table was opened with `{ wire: true }`. Bracket a gesture with `clearWire`.
	 */
	wire: () => Promise<WireFrame[]>;
	clearWire: () => Promise<void>;
	/** how an entity is rendered right now; null if it never mounted */
	describe: (
		id: string
	) => Promise<{ meshes: number; materials: unknown[]; size: [number, number, number] } | null>;
	dragBy: (id: string, dx: number, dy: number) => Promise<void>;
	/**
	 * drag an entity and release it over a table-plane world position;
	 * `alt` holds the Alt key through the whole gesture — the release's
	 * pointerup then carries `altKey`, which is what the app reads for the
	 * no-snap drop (see TableScene's onPointerUp)
	 */
	dragTo: (
		id: string,
		worldX: number,
		worldZ: number,
		options?: { alt?: boolean }
	) => Promise<void>;
	positionOf: (id: string) => Promise<number[] | null>;
	settle: (ms?: number) => Promise<void>;
	/**
	 * Hold the page's main thread for `ms` at a time, freeing it for `everyMs`
	 * in between — the long frame gaps a shared CI runner produces, on demand.
	 * `null` stops it and returns how many stalls were injected, so a spec can
	 * prove the injection was live rather than assume it.
	 */
	stall: (options: { ms: number; everyMs?: number } | null) => Promise<number>;
	/**
	 * capture the page to e2e/screenshots/<name>.png — the visual-polish
	 * train's evidence artifact — failing if the frame is silently blank
	 */
	snap: (name: string) => Promise<string>;
	close: () => Promise<void>;
};

/** gitignored; CI uploads it as the `e2e-screenshots` artifact */
const SCREENSHOT_DIR = fileURLToPath(new URL('./screenshots/', import.meta.url));

/**
 * Noise that is the *environment*, never the app: SwiftShader's warnings, and a
 * favicon a dev server has no answer for. Deliberately short — anything else
 * failing is a real failure, which is the entire point of the harness.
 */
const IGNORED = [
	/GroupMarkerNotSet/i,
	/SwiftShader/i,
	/Automatic fallback to software WebGL/i,
	/favicon/i,
	/\[vite\] connect/i
];

function ignorable(text: string): boolean {
	return IGNORED.some((pattern) => pattern.test(text));
}

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export type TableOptions = {
	/**
	 * Open in a browser context of its own — a genuinely SECOND player.
	 *
	 * Every page in one browser shares an origin and therefore shares
	 * localStorage, including the `myPlayerId` the app rolls on first visit. Two
	 * plain tabs in one lobby are consequently the same player as far as the
	 * relay is concerned, and the relay excludes a sender from its own broadcast
	 * — so neither tab ever receives the other's patches, only the merged `sync`
	 * they get on joining. A spec about live traffic between two clients has to
	 * separate their storage, which is what a fresh context does.
	 */
	isolated?: boolean;
	/**
	 * Record every outbound websocket frame, readable through `wire()`.
	 *
	 * Opt-in, and armed here rather than on demand for two reasons: enabling the
	 * CDP network domain is overhead the specs that measure frame timings under
	 * SwiftShader should not carry, and turning it on *after* the socket is
	 * already open races — a recorder attached late was observed capturing an
	 * entire gesture as nothing at all, which is indistinguishable from the
	 * silence the gate specs are trying to prove.
	 */
	wire?: boolean;
};

export async function openTable(
	browser: Browser,
	servers: Servers,
	lobby: string,
	options: TableOptions = {}
): Promise<Table> {
	const context = options.isolated ? await browser.createBrowserContext() : null;
	const page = await (context ?? browser).newPage();
	const problems: Problem[] = [];

	/**
	 * See `TableOptions.wire`. Installed before ANY page script runs, by wrapping
	 * `WebSocket.prototype.send` itself: everything the app sends goes through
	 * that one function, so there is nothing for a message to slip past — which is
	 * the property a spec asserting "not one frame left" actually needs.
	 */
	if (options.wire) {
		await page.evaluateOnNewDocument(() => {
			const log: string[] = [];
			(window as unknown as { __wire: string[] }).__wire = log;
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (this: WebSocket, data: never) {
				log.push(String(data));
				return send.call(this, data);
			};
		});
	}

	page.on('console', (message: ConsoleMessage) => {
		if (message.type() === 'error') problems.push({ kind: 'console', text: message.text() });
	});
	page.on('pageerror', (error) => {
		const failure = error as Error;
		problems.push({ kind: 'pageerror', text: `${failure.message}\n${failure.stack ?? ''}` });
	});
	page.on('requestfailed', (request) => {
		problems.push({
			kind: 'requestfailed',
			text: `${request.url()} — ${request.failure()?.errorText ?? 'failed'}`
		});
	});

	/**
	 * `E2E_CPU_THROTTLE=8` slows the renderer's main thread by that factor.
	 *
	 * The failures worth chasing here are timing ones: pointermove delivery is
	 * rAF-aligned, so on a machine that cannot keep up, input a hand delivered
	 * in one order can reach the page in another. A CI runner under SwiftShader
	 * is such a machine; a developer's laptop is not, which is how a gesture bug
	 * reaches CI green-locally. This knob makes the difference reproducible on
	 * demand, and is off unless asked for — no spec's own timings change.
	 */
	const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 0);
	if (throttle > 1) {
		const cdp = await page.createCDPSession();
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
	}

	// before ANY script runs: the module-level fallback in connection.ts reads
	// localStorage at import time, and it defaults to the PUBLIC relay
	await page.evaluateOnNewDocument((relay: string) => {
		localStorage.setItem('serverurl', relay);
	}, servers.relay);

	const url =
		`${servers.web}/play?lobby=${encodeURIComponent(lobby)}` +
		`&server=${encodeURIComponent(servers.relay)}`;
	// Two waits, sized for what each actually has to survive.
	//
	// `domcontentloaded`, NOT `networkidle2`. Idle is the wrong question to ask a
	// vite dev server: it streams hundreds of unbundled modules and holds an HMR
	// socket open, so "fewer than two requests in flight for 500ms" is a race
	// against the runner's mood rather than a fact about the page, and on a busy
	// runner it stops resolving at all — a timeout that reads as a broken app.
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

	// The bridge is the real wait, and the slow one, so it gets the big budget.
	// It is also an EXACT signal rather than a heuristic: the bridge mounts inside
	// the Canvas, the Canvas mounts only once the lobby socket is open, and
	// `ready` additionally holds until the environment-lighting recompile storm
	// has passed — so this one line is the load assertion and the connection
	// assertion both.
	//
	// Four minutes because of the SECOND table in a two-client spec. It is a
	// second software WebGL context inside one Chrome, with a cold HTTP cache
	// re-fetching every dev module and warming every shader again, and the two
	// contexts starve each other while it does: on a CI runner that reliably
	// takes over two minutes. A table that is genuinely broken still fails here,
	// just later — and `ready` never flipping is the loudest failure the harness
	// has, so buying it room costs nothing but wall clock on a red run.
	await page.waitForFunction('window.__tableplace?.ready === true', { timeout: 240_000 });

	const settle = (ms = 700) => sleep(ms);
	await settle(600);

	const spawn = (kind: string, options: Record<string, unknown> = {}) =>
		page.evaluate(
			(k, o) => window.__tableplace!.actions.addPiece(k as never, o as never),
			kind,
			options
		) as Promise<string>;

	const myId = () =>
		page.evaluate(() => String(window.__tableplace!.actions.getMyId() ?? '')) as Promise<string>;

	/**
	 * A standard 52-card deck. The card list is built here rather than imported
	 * so the harness only ever leans on the app's public action surface — and
	 * `gen:` faces are canvas-drawn, so seeding one fetches nothing.
	 */
	const seedDeck = (options: { owner?: string } = {}) =>
		page.evaluate(
			(suits, ranks, owner) => {
				const cards = suits.flatMap((suit) =>
					ranks.map((rank) => ({
						id: `card:${owner}:${rank}${suit}`,
						faceImageUrl: `gen:std52/${rank}${suit}`,
						backImageUrl: 'gen:std52/back'
					}))
				);
				return String(window.__tableplace!.actions.addDeck({ cards } as never) ?? '');
			},
			SUITS,
			RANKS,
			options.owner ?? 'std'
		);

	const setStubValidator = (on: boolean) =>
		page.evaluate((enable) => {
			if (enable) window.__tableplace!.enableStubValidator();
			else window.__tableplace!.disableStubValidator();
		}, on);

	const refusals = () => page.evaluate(() => window.__tableplace!.refusals()) as Promise<Refusal[]>;
	const clearRefusals = () => page.evaluate(() => window.__tableplace!.clearRefusals());

	/**
	 * svelte-french-toast stamps `role="status"` on every toast it raises (its
	 * `ariaProps` default), so this reads what a screen reader would — no test
	 * hook in the app, and no coupling to the library's class names.
	 */
	const toasts = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('[role="status"]')].map((node) =>
				(node.textContent ?? '').trim()
			)
		);

	const wire = async (): Promise<WireFrame[]> => {
		const sent = await page.evaluate(
			() => (window as unknown as { __wire?: string[] }).__wire?.slice() ?? null
		);
		// "not installed" and "installed, nothing sent" are opposite answers and a
		// spec asserting silence must never confuse them
		if (!sent)
			throw new Error(
				'the outbound-frame recorder is not installed on this page — open the table ' +
					'with { wire: true }'
			);
		return sent.map((payload) => {
			try {
				return JSON.parse(payload) as WireFrame;
			} catch {
				// a non-JSON frame is still a frame that left, and a spec asserting
				// that nothing did has to see it
				return { raw: payload };
			}
		});
	};

	const clearWire = () =>
		page.evaluate(() => {
			(window as unknown as { __wire?: string[] }).__wire?.splice(0);
		});

	const locate = (id: string) =>
		page.evaluate((entityId) => window.__tableplace!.locate(entityId), id);

	const hits = (point: ScreenPoint) =>
		page.evaluate((screen) => window.__tableplace!.hits(screen), point);

	const elementAt = (point: ScreenPoint) =>
		page.evaluate((screen) => {
			const element = document.elementFromPoint(screen.x, screen.y);
			return element ? `${element.tagName.toLowerCase()}.${element.className}`.trim() : 'nothing';
		}, point);

	const describe = (id: string) =>
		page.evaluate((entityId) => window.__tableplace!.describe(entityId), id);

	const stall = (options: { ms: number; everyMs?: number } | null) =>
		page.evaluate((injection) => window.__tableplace!.stall(injection), options);

	const radial = () =>
		page.evaluate(() => {
			const wedges = [...document.querySelectorAll('[data-radial-action]')];
			if (!wedges.length) return null;
			const at: Record<string, { x: number; y: number }> = {};
			const actions: string[] = [];
			for (const wedge of wedges) {
				const slug = wedge.getAttribute('data-radial-action') ?? '';
				const box = wedge.getBoundingClientRect();
				actions.push(slug);
				at[slug] = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
			}
			return { actions, wedges: at };
		});

	/**
	 * Press and hold until the wheel is up.
	 *
	 * Polled rather than slept for the same reason the deck's arm cue is (see
	 * dragFromTo): the hold runs on the page's timers, and on a choked
	 * SwiftShader main thread wall-clock time and page time drift apart. The
	 * pointer is left DOWN — the caller decides what the release means.
	 */
	const openRadial = async (
		id: string,
		options: { button?: 'left' | 'right'; timeoutMs?: number } = {}
	) => {
		const at = await locate(id);
		if (!at) throw new Error(`cannot locate ${id} on screen`);
		const cover = await elementAt(at);
		if (!cover.startsWith('canvas')) {
			throw new Error(
				`${id} draws where the HUD covers the table (${cover}) — move it clear of the panes`
			);
		}
		const button = options.button ?? 'right';
		await page.mouse.move(at.x, at.y);
		await sleep(80);
		await page.mouse.down({ button });
		const deadline = Date.now() + (options.timeoutMs ?? 6000);
		while (Date.now() < deadline) {
			await sleep(100);
			const open = await radial();
			if (open) return open;
		}
		await page.mouse.up({ button });
		throw new Error(`the radial menu never opened on ${id} after a ${button}-button hold`);
	};

	const cameraPose = () => page.evaluate(() => window.__tableplace!.camera());
	const connected = () => page.evaluate(() => window.__tableplace!.connected());
	const intents = () => page.evaluate(() => window.__tableplace!.intents()) as Promise<Intent[]>;
	const clearIntents = () => page.evaluate(() => window.__tableplace!.clearIntents());

	const positionOf = (id: string) =>
		page.evaluate((entityId) => {
			const state = window.__tableplace!.state();
			const entity =
				state?.pieces?.[entityId] ?? state?.decks?.[entityId] ?? state?.cards?.[entityId];
			return (entity as { position?: number[] } | undefined)?.position ?? null;
		}, id);

	/**
	 * A real press–move–release. The intermediate moves matter twice over: a
	 * clickable piece only lifts once the pointer has travelled past
	 * DRAG_THRESHOLD_PX, and the position the drop commits comes from the
	 * interactivity context's raycast on the last move.
	 *
	 * A DECK does not travel this way at all — see `grabMoveTo`. Dragging one
	 * draws off its top, which is the whole point of the gesture; the pile
	 * itself moves through its wheel.
	 */
	/** press on the entity, walk the pointer to a screen point, release there */
	const dragFromTo = async (
		id: string,
		from: ScreenPoint,
		to: ScreenPoint,
		options: { alt?: boolean } = {}
	) => {
		// A HUD pane over the entity swallows the press, and the failure looks
		// exactly like a dead table — which cost an hour of chasing a bag that was
		// never broken. Fail on the real reason instead: put the entity somewhere
		// the panes don't cover.
		const cover = await elementAt(from);
		if (!cover.startsWith('canvas')) {
			throw new Error(
				`${id} draws at (${Math.round(from.x)}, ${Math.round(from.y)}), where the HUD covers the table (${cover}) — move it clear of the panes`
			);
		}
		// held for the whole gesture: puppeteer stamps keyboard modifiers onto
		// every mouse event it dispatches, so the release's pointerup carries
		// altKey exactly like a user holding Alt
		if (options.alt) await page.keyboard.down('Alt');
		try {
			await page.mouse.move(from.x, from.y);
			await sleep(80);
			await page.mouse.down();
			await sleep(80);
			for (let step = 1; step <= 12; step++) {
				await page.mouse.move(
					from.x + ((to.x - from.x) * step) / 12,
					from.y + ((to.y - from.y) * step) / 12
				);
				await sleep(20);
			}
			await sleep(150);
			await page.mouse.up();
		} finally {
			if (options.alt) await page.keyboard.up('Alt');
		}
		await sleep(400);
	};

	/**
	 * Move a whole pile: the gesture a player makes since tableplace-161 gave
	 * the deck's long press to its wheel.
	 *
	 * Press and hold until the wheel is up, flick to "Move pile" and release —
	 * the pile then follows the pointer with no button held — walk it to the
	 * target and click it down. The placing click commits through the same drop
	 * resolver a dragged card does, so snapping, stacking and surface rest all
	 * behave exactly as they did when this was a drag.
	 *
	 * Every wait here is on OBSERVED page state (the wheel is up; the drag store
	 * names this deck) rather than on wall-clock: page time and the runner's
	 * clock come apart under software GL, which is what made the old arm-cue
	 * hold flaky enough to need the same treatment.
	 */
	const grabMoveTo = async (id: string, to: ScreenPoint) => {
		const wheel = await openRadial(id, { button: 'left', timeoutMs: 8000 });
		const wedge = wheel.wedges.move;
		if (!wedge) {
			await page.mouse.up();
			throw new Error(
				`the deck wheel has no "Move pile" wedge — it offers ${JSON.stringify(wheel.actions)}`
			);
		}
		await page.mouse.move(wedge.x, wedge.y, { steps: 8 });
		await sleep(120);
		await page.mouse.up(); // the flick fires the wedge: the pile is now carried
		const carried = await page.evaluate(
			(deckId) =>
				new Promise<boolean>((resolve) => {
					const deadline = Date.now() + 3000;
					const tick = () => {
						if (window.__tableplace!.drag().isDragging === deckId) return resolve(true);
						if (Date.now() > deadline) return resolve(false);
						setTimeout(tick, 50);
					};
					tick();
				}),
			id
		);
		if (!carried) throw new Error(`"Move pile" did not pick ${id} up`);
		await page.mouse.move(to.x, to.y, { steps: 12 });
		await sleep(150);
		await page.mouse.click(to.x, to.y); // and down it goes
		await sleep(400);
	};

	const dragBy = async (id: string, dx: number, dy: number) => {
		const from = await locate(id);
		if (!from) throw new Error(`cannot locate ${id} on screen`);
		const to = { x: from.x + dx, y: from.y + dy };
		if (id.startsWith('deck:')) return grabMoveTo(id, to);
		await dragFromTo(id, from, to);
	};

	/**
	 * Release over a table-plane world position: the drop commits wherever the
	 * pointer's raycast hits the table, so the target pixel is the projection
	 * of that spot on the felt — where a snap grid can then pull it from.
	 */
	const dragTo = async (
		id: string,
		worldX: number,
		worldZ: number,
		options: { alt?: boolean } = {}
	) => {
		const from = await locate(id);
		if (!from) throw new Error(`cannot locate ${id} on screen`);
		const to = await page.evaluate(
			(x, z) => window.__tableplace!.project([x, 0.26, z]),
			worldX,
			worldZ
		);
		if (!to) throw new Error(`world (${worldX}, ${worldZ}) projects off-screen`);
		// a pile travels by its wheel, not by being dragged (see grabMoveTo)
		if (id.startsWith('deck:')) return grabMoveTo(id, to);
		await dragFromTo(id, from, to, options);
	};

	/**
	 * One PNG per spec, written after a settle so the springs are done posing.
	 *
	 * The flat-color guard exists because SwiftShader's failure mode is not an
	 * error but an empty frame: the harness's structural assertions (mesh
	 * counts, raycasts) all keep passing while the canvas draws nothing. So the
	 * check reads pixels back from the PNG that was actually written — not from
	 * the live canvas, whose drawing buffer may not even be preserved — by
	 * loading it into the page and sampling a grid of points inside the table
	 * canvas's own box. Points the HUD panes cover are skipped: a pane's chrome
	 * would count as "variation" over a canvas that rendered nothing at all.
	 */
	const snap = async (name: string) => {
		await settle();
		mkdirSync(SCREENSHOT_DIR, { recursive: true });
		const file = join(SCREENSHOT_DIR, `${name}.png`);
		const png = new Uint8Array(await page.screenshot({ type: 'png' }));
		await writeFile(file, png);

		const sampled = await page.evaluate(
			async (dataUrl) => {
				const image = new Image();
				await new Promise<void>((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject(new Error('the captured PNG did not decode'));
					image.src = dataUrl;
				});
				const surface = document.createElement('canvas');
				surface.width = image.width;
				surface.height = image.height;
				const context = surface.getContext('2d');
				if (!context) return { points: 0, spread: 0 };
				context.drawImage(image, 0, 0);

				// the WebGL table is the biggest canvas on the page — the HUD's
				// Tweakpane panes each carry small canvases of their own
				const table = [...document.querySelectorAll('canvas')].sort(
					(a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
				)[0];
				const box = table?.getBoundingClientRect();
				if (!table || !box || !box.width || !box.height) return { points: 0, spread: 0 };
				// the screenshot is in device pixels; the box is in CSS pixels
				const scaleX = image.width / window.innerWidth;
				const scaleY = image.height / window.innerHeight;

				const low = [255, 255, 255];
				const high = [0, 0, 0];
				let points = 0;
				const STEPS = 8;
				for (let row = 1; row < STEPS; row++) {
					for (let column = 1; column < STEPS; column++) {
						const cssX = box.left + (box.width * column) / STEPS;
						const cssY = box.top + (box.height * row) / STEPS;
						if (document.elementFromPoint(cssX, cssY) !== table) continue;
						const pixel = context.getImageData(
							Math.round(cssX * scaleX),
							Math.round(cssY * scaleY),
							1,
							1
						).data;
						points++;
						for (const channel of [0, 1, 2]) {
							low[channel] = Math.min(low[channel]!, pixel[channel]!);
							high[channel] = Math.max(high[channel]!, pixel[channel]!);
						}
					}
				}
				// how far apart the sampled pixels are, on the widest RGB channel.
				// A blank canvas shows the page background through: measured ≤5
				// even with a HUD pane's drop shadow grazing a sample, while the
				// felt's own shading alone spans ≥29 — so 16 splits them cleanly
				// without caring what color anything is.
				const spread = Math.max(high[0]! - low[0]!, high[1]! - low[1]!, high[2]! - low[2]!);
				return { points, spread };
			},
			`data:image/png;base64,${Buffer.from(png).toString('base64')}`
		);

		if (sampled.points === 0) {
			throw new Error(`screenshot ${name}.png: found no table canvas pixels to sample`);
		}
		if (sampled.spread < 16) {
			throw new Error(
				`screenshot ${name}.png is one flat color across ${sampled.points} sampled canvas ` +
					`points (RGB spread ${sampled.spread}) — SwiftShader rendered a blank frame. ` +
					`The PNG is at ${file}.`
			);
		}
		return file;
	};

	return {
		page,
		problems,
		appProblems: () => problems.filter((problem) => !ignorable(problem.text)),
		spawn,
		myId,
		seedDeck,
		locate,
		hits,
		elementAt,
		radial,
		openRadial,
		cameraPose,
		connected,
		intents,
		clearIntents,
		setStubValidator,
		refusals,
		clearRefusals,
		toasts,
		wire,
		clearWire,
		describe,
		dragBy,
		dragTo,
		positionOf,
		settle,
		stall,
		snap,
		close: async () => {
			await page.close();
			await context?.close();
		}
	};
}
