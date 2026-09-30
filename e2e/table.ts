/**
 * Driving one table in one tab.
 *
 * Entities are spawned through `gameActions` (the same calls the HUD panes
 * make) but *moved with a real mouse*, because the bug this harness exists for
 * lives in the raycast between the two: dispatch is what breaks, not state. An
 * assertion that only round-tripped the store would have passed on the broken
 * build.
 */

import type { Browser, BrowserContext, ConsoleMessage, HTTPRequest, Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Servers } from './servers';

export type Problem = { kind: 'console' | 'pageerror' | 'requestfailed'; text: string };
export type ScreenPoint = { x: number; y: number };

export type Table = {
	page: Page;
	/** everything the page complained about since it opened */
	problems: Problem[];
	/** the subset that is genuinely the app's fault (see IGNORED) */
	appProblems: () => Problem[];
	spawn: (kind: string, options?: Record<string, unknown>) => Promise<string>;
	/** a standard 52-card deck, procedurally faced — no network */
	seedDeck: (position?: [number, number, number]) => Promise<string>;
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
	 * The colour actually drawn at each screen point — a 3×3 average read back
	 * from a real screenshot, plus whether the table canvas (not a HUD pane) is
	 * what sits there. For "did the image land", which no structural probe can
	 * answer: a material whose shader goes NaN still mounts, still has a map,
	 * and still raycasts (tableplace-175).
	 */
	pixels: (
		points: ScreenPoint[]
	) => Promise<{ rgb: [number, number, number]; onCanvas: boolean }[]>;
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

/**
 * Hold every other open page's `requestAnimationFrame` until the returned
 * release runs. The page's JS, timers and sockets keep running. Only drawing
 * stops, and the release hands every held callback to the real rAF.
 *
 * Why (#243): every page shares one GPU process, and under SwiftShader that
 * process is a CPU rasteriser. A table that is already open draws a frame on
 * every rAF, because background throttling is off (see `browser.ts`). A second
 * seat in a fresh `BrowserContext` starts with a cold shader-program cache, and
 * its synchronous compiles queue behind those frames. On a 16 GB VPS the
 * seat-1 load in that state never reached networkidle2, even with 180 s. With
 * seat 0 not drawing, it loaded in 34 s, and a lone fresh context took 48 s.
 * The load was blocked by the other page, so a longer timeout would not fix it.
 *
 * Not CDP's `Page.setWebLifecycleState: frozen`. Chrome treats a frozen page as
 * one entering the Back-Forward Cache: it closes the page's sockets (the relay
 * and vite's HMR) and logs that as a console error.
 */
async function holdOthers(page: Page): Promise<() => Promise<void>> {
	const others = (await page.browser().pages()).filter((other) => other !== page);
	const held: Page[] = [];
	for (const other of others) {
		const holding = await other
			.evaluate(() => {
				const w = window as unknown as { __e2eReleaseFrames?: () => void };
				if (w.__e2eReleaseFrames) return false;
				const raf = window.requestAnimationFrame;
				const caf = window.cancelAnimationFrame;
				const queued = new Map<number, FrameRequestCallback>();
				// negative ids never collide with the real rAF's positive ones
				let next = 0;
				window.requestAnimationFrame = (callback) => {
					queued.set(--next, callback);
					return next;
				};
				window.cancelAnimationFrame = (id) => {
					if (!queued.delete(id)) caf.call(window, id);
				};
				w.__e2eReleaseFrames = () => {
					window.requestAnimationFrame = raf;
					window.cancelAnimationFrame = caf;
					delete w.__e2eReleaseFrames;
					for (const callback of queued.values()) raf.call(window, callback);
					queued.clear();
				};
				return true;
			})
			// a page closing underneath us has nothing left to draw
			.catch(() => false);
		if (holding) held.push(other);
	}
	return async () => {
		for (const other of held) {
			await other
				.evaluate(() =>
					(window as unknown as { __e2eReleaseFrames?: () => void }).__e2eReleaseFrames?.()
				)
				.catch(() => {});
		}
	};
}

/**
 * Navigate to the table and wait for the bridge. Other pages draw nothing for the
 * whole load (see `holdOthers`). If the load fails, close the page before
 * throwing.
 *
 * The close matters. A `goto` that times out does not stop the page: it keeps
 * loading, mounts the table and then renders it without end. CI run 36628906362
 * shows the cascade: peek's second seat timed out, and then weight, journal and
 * ping each failed their *first* `goto` at exactly 60 s. Weight opens only one
 * page.
 *
 * The error names the phase, how long it took and which requests were still
 * open, so a slow host and a request that never finishes look different. A
 * request can also show as open only because the renderer's main thread is
 * blocked and has not handled the response yet.
 */
async function load(page: Page, url: string): Promise<void> {
	const readyMs = Number(process.env.E2E_READY_MS ?? 60_000);
	const open = new Set<HTTPRequest>();
	const track = (request: HTTPRequest) => open.add(request);
	const settle = (request: HTTPRequest) => open.delete(request);
	page.on('request', track);
	page.on('requestfinished', settle);
	page.on('requestfailed', settle);

	const release = await holdOthers(page);
	const started = Date.now();
	let phase = 'goto (networkidle2)';
	try {
		await page.goto(url, { waitUntil: 'networkidle2', timeout: readyMs });
		const loaded = Date.now() - started;
		phase = 'window.__tableplace.ready';
		// the bridge mounts inside the Canvas, which mounts only once the socket is
		// open — so waiting on it is also the connection assertion
		await page.waitForFunction('window.__tableplace?.ready === true', { timeout: readyMs });
		if (process.env.E2E_VERBOSE === '1') {
			console.log(`    load: goto ${loaded}ms, ready ${Date.now() - started}ms`);
		}
	} catch (error) {
		const pending = [...open].map((request) => request.url().replace(/^https?:\/\/[^/]+/, ''));
		await page.close().catch(() => {});
		throw new Error(
			`table load stalled in ${phase} after ${Date.now() - started}ms ` +
				`(E2E_READY_MS=${readyMs}); ${pending.length} request(s) still open` +
				(pending.length ? `:\n  ${pending.slice(0, 20).join('\n  ')}` : ''),
			{ cause: error }
		);
	} finally {
		await release();
		page.off('request', track);
		page.off('requestfinished', settle);
		page.off('requestfailed', settle);
	}
}

/**
 * Pages opened on the same `Browser` share one localStorage — and so one
 * `myPlayerId`: they are the same player looking twice. Pass a fresh
 * `BrowserContext` to seat a genuinely different player.
 */
export async function openTable(
	browser: Browser | BrowserContext,
	servers: Servers,
	lobby: string
): Promise<Table> {
	const page = await browser.newPage();
	const problems: Problem[] = [];

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
	await load(page, url);

	const settle = (ms = 700) => sleep(ms);
	await settle(600);

	const spawn = (kind: string, options: Record<string, unknown> = {}) =>
		page.evaluate(
			(k, o) => window.__tableplace!.actions.addPiece(k as never, o as never),
			kind,
			options
		) as Promise<string>;

	/**
	 * A standard 52-card deck. The card list is built here rather than imported
	 * so the harness only ever leans on the app's public action surface — and
	 * `gen:` faces are canvas-drawn, so seeding one fetches nothing.
	 */
	const seedDeck = (position?: [number, number, number]) =>
		page.evaluate(
			(suits, ranks, at) => {
				const cards = suits.flatMap((suit) =>
					ranks.map((rank) => ({
						id: `card:std:${rank}${suit}`,
						faceImageUrl: `gen:std52/${rank}${suit}`,
						backImageUrl: 'gen:std52/back'
					}))
				);
				return String(window.__tableplace!.actions.addDeck({ cards, position: at } as never) ?? '');
			},
			SUITS,
			RANKS,
			position
		);

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

	const pixels = async (points: ScreenPoint[]) => {
		const png = Buffer.from(await page.screenshot({ type: 'png' }));
		return page.evaluate(
			async (dataUrl, targets) => {
				const image = new Image();
				await new Promise<void>((resolve, reject) => {
					image.onload = () => resolve();
					image.onerror = () => reject(new Error('the captured PNG did not decode'));
					image.src = dataUrl;
				});
				const surface = document.createElement('canvas');
				surface.width = image.width;
				surface.height = image.height;
				const context = surface.getContext('2d')!;
				context.drawImage(image, 0, 0);
				const table = [...document.querySelectorAll('canvas')].sort(
					(a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
				)[0];
				// the screenshot is in device pixels; the points are CSS pixels
				const scaleX = image.width / window.innerWidth;
				const scaleY = image.height / window.innerHeight;
				return targets.map((point) => {
					const data = context.getImageData(
						Math.round(point.x * scaleX) - 1,
						Math.round(point.y * scaleY) - 1,
						3,
						3
					).data;
					const rgb: [number, number, number] = [0, 0, 0];
					for (let i = 0; i < data.length; i += 4) {
						for (const channel of [0, 1, 2] as const) rgb[channel] += data[i + channel]! / 9;
					}
					return {
						rgb: rgb.map(Math.round) as [number, number, number],
						onCanvas: document.elementFromPoint(point.x, point.y) === table
					};
				});
			},
			`data:image/png;base64,${png.toString('base64')}`,
			points
		);
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
		seedDeck,
		locate,
		hits,
		elementAt,
		radial,
		openRadial,
		cameraPose,
		connected,
		describe,
		dragBy,
		dragTo,
		positionOf,
		settle,
		stall,
		pixels,
		snap,
		close: () => page.close()
	};
}
