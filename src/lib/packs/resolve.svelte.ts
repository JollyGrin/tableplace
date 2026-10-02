/**
 * Resolves face refs to renderable image URLs. See SPEC.md §4d.
 *
 * - `https://…`      → returned as-is for the DOM; for a texture, probed
 *   and routed through the CORS proxy when the host sends no CORS headers
 *   (`resolveTextureImage`)
 * - `gen:std52/<code>` → drawn to a canvas once per client, cached as a data URL.
 * - `sheet:{json}`   → sprite-sheet cell, fetched + sliced async (reactive).
 *   Only the tiny ref string ever touches the store/wire — never image data —
 *   so every client resolves the same ref to the same deterministic image.
 */
import { writable, get } from 'svelte/store';
import { sliceCell } from '$lib/tts/slice';
import { loadTextureImage } from '$lib/utils/image-cors';
import { namedCardImage } from './placeholder';
import { CARD_BACK_DEFAULT } from './standard52';

const CARD_W = 420;
const CARD_H = 600;

const RED = '#b3202e';
const BLACK = '#1c1c24';
const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/**
 * Classic pip layouts per rank in unit space:
 * x ∈ {-1,0,1} maps to pip columns, y ∈ [-1,1] top→bottom.
 * Pips on the lower half are drawn rotated 180°, as on real cards.
 */
const PIP_LAYOUTS: Record<string, [number, number][]> = {
	'2': [
		[0, -1],
		[0, 1]
	],
	'3': [
		[0, -1],
		[0, 0],
		[0, 1]
	],
	'4': [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1]
	],
	'5': [
		[-1, -1],
		[1, -1],
		[0, 0],
		[-1, 1],
		[1, 1]
	],
	'6': [
		[-1, -1],
		[1, -1],
		[-1, 0],
		[1, 0],
		[-1, 1],
		[1, 1]
	],
	'7': [
		[-1, -1],
		[1, -1],
		[0, -0.5],
		[-1, 0],
		[1, 0],
		[-1, 1],
		[1, 1]
	],
	'8': [
		[-1, -1],
		[1, -1],
		[0, -0.5],
		[-1, 0],
		[1, 0],
		[0, 0.5],
		[-1, 1],
		[1, 1]
	],
	'9': [
		[-1, -1],
		[1, -1],
		[-1, -1 / 3],
		[1, -1 / 3],
		[0, 0],
		[-1, 1 / 3],
		[1, 1 / 3],
		[-1, 1],
		[1, 1]
	],
	'10': [
		[-1, -1],
		[1, -1],
		[0, -2 / 3],
		[-1, -1 / 3],
		[1, -1 / 3],
		[-1, 1 / 3],
		[1, 1 / 3],
		[0, 2 / 3],
		[-1, 1],
		[1, 1]
	]
};

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = CARD_W;
	canvas.height = CARD_H;
	const ctx = canvas.getContext('2d');
	return ctx ? [canvas, ctx] : null;
}

function drawGlyph(
	ctx: CanvasRenderingContext2D,
	glyph: string,
	x: number,
	y: number,
	size: number,
	rotated = false
) {
	ctx.save();
	ctx.translate(x, y);
	if (rotated) ctx.rotate(Math.PI);
	ctx.font = `${size}px serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(glyph, 0, 0);
	ctx.restore();
}

function drawFace(rank: string, suit: string): string | null {
	const made = makeCanvas();
	if (!made) return null;
	const [canvas, ctx] = made;
	const glyph = SUIT_GLYPH[suit];
	const color = suit === 'H' || suit === 'D' ? RED : BLACK;

	ctx.fillStyle = '#fdfdf8';
	ctx.fillRect(0, 0, CARD_W, CARD_H);
	ctx.fillStyle = color;

	// corner indices (top-left, bottom-right rotated)
	for (const rotated of [false, true]) {
		ctx.save();
		if (rotated) {
			ctx.translate(CARD_W, CARD_H);
			ctx.rotate(Math.PI);
		}
		ctx.font = 'bold 58px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(rank, 44, 52);
		ctx.font = '48px serif';
		ctx.fillText(glyph, 44, 108);
		ctx.restore();
	}

	if (rank === 'A') {
		drawGlyph(ctx, glyph, CARD_W / 2, CARD_H / 2, 200);
	} else if (rank === 'J' || rank === 'Q' || rank === 'K') {
		ctx.font = `bold 170px Georgia, serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(rank, CARD_W / 2, CARD_H / 2 - 40);
		drawGlyph(ctx, glyph, CARD_W / 2, CARD_H / 2 + 110, 90);
	} else {
		const layout = PIP_LAYOUTS[rank] ?? [];
		for (const [ux, uy] of layout) {
			drawGlyph(ctx, glyph, CARD_W / 2 + ux * 85, CARD_H / 2 + uy * 170, 64, uy > 0);
		}
	}

	return canvas.toDataURL('image/png');
}

function drawBack(): string | null {
	const made = makeCanvas();
	if (!made) return null;
	const [canvas, ctx] = made;

	ctx.fillStyle = '#fdfdf8';
	ctx.fillRect(0, 0, CARD_W, CARD_H);
	ctx.fillStyle = '#28406b';
	ctx.fillRect(16, 16, CARD_W - 32, CARD_H - 32);

	// diagonal lattice
	ctx.strokeStyle = 'rgba(253, 253, 248, 0.35)';
	ctx.lineWidth = 3;
	ctx.save();
	ctx.beginPath();
	ctx.rect(16, 16, CARD_W - 32, CARD_H - 32);
	ctx.clip();
	for (let i = -CARD_H; i < CARD_W + CARD_H; i += 34) {
		ctx.moveTo(i, 0);
		ctx.lineTo(i + CARD_H, CARD_H);
		ctx.moveTo(i, CARD_H);
		ctx.lineTo(i + CARD_H, 0);
	}
	ctx.stroke();
	ctx.restore();

	return canvas.toDataURL('image/png');
}

const cache = new Map<string, string>();

function resolveGen(ref: string): string {
	const cached = cache.get(ref);
	if (cached) return cached;

	const code = ref.startsWith('gen:std52/') ? ref.slice('gen:std52/'.length) : null;
	let url: string | null = null;
	if (code === 'back') url = drawBack();
	else if (code) url = drawFace(code.slice(0, -1), code.slice(-1));

	if (!url) return ref; // SSR / no canvas: pass through harmlessly
	cache.set(ref, url);
	return url;
}

/**
 * `sheet:` refs resolve asynchronously (fetch + slice); results land in a
 * reactive map so any $derived that called resolveCardImage re-runs when
 * the slice completes. Game state carries only the tiny ref string —
 * data URLs never touch the store or the wire (SPEC §4d).
 */
type SheetRefPayload = {
	url: string;
	cols: number;
	rows: number;
	index: number;
	/** card name for the placeholder fallback when the sheet is dead */
	name?: string;
	/** back cells fall back to the generated card back, not a named proxy */
	back?: boolean;
};

/**
 * Art that did not load is not final (tableplace-262): the placeholder is
 * committed so the table stays playable, and the ref is tried again on a
 * backoff — a fresh guest has nothing cached, so one dropped proxy request
 * would otherwise cost them the art for the whole session. Once the delays
 * run out the next sync (`prewarmTextureRef`) starts them over.
 */
export const ART_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];

type ArtJob = {
	/** the renderable URL, or null when the art is unreachable right now */
	load: () => Promise<string | null>;
	/** what draws in the meantime, and for good if it never loads */
	fallback: () => string;
	/** for the log line */
	source: string;
};

const inflight = new Map<string, Promise<string>>();
/** refs currently showing their fallback → how many attempts have failed */
const failures = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Resolved refs as a CLASSIC writable store — `sheet:` refs, and the plain
 * off-origin URLs `resolveTextureImage` probes. Components subscribe
 * with `$sheetRefCache` and pass the snapshot into resolveCardImage —
 * store subscription is Svelte's most battle-tested reactivity channel,
 * so a commit is guaranteed to re-render every subscriber.
 */
export const sheetRefCache = writable<Record<string, string>>({});

function commitSheetResult(ref: string, url: string) {
	// a retry that fails again commits the same placeholder: not a re-render
	if (get(sheetRefCache)[ref] === url) return;
	sheetRefCache.update((m) => ({ ...m, [ref]: url }));
}

export function makeSheetRef(payload: SheetRefPayload): string {
	return `sheet:${JSON.stringify(payload)}`;
}

function parseSheetRef(ref: string): SheetRefPayload | null {
	try {
		return JSON.parse(ref.slice('sheet:'.length)) as SheetRefPayload;
	} catch (error) {
		console.warn('[resolve] unparseable sheet ref', ref.slice(0, 120), error);
		return null;
	}
}

type ArtFallback = {
	/** card name for the placeholder when the art is dead */
	name?: string;
	/** backs fall back to the generated card back, not a named proxy */
	back?: boolean;
};

function fallbackArt(fallback: ArtFallback): string {
	return fallback.back ? resolveGen(CARD_BACK_DEFAULT) : namedCardImage(fallback.name ?? '');
}

async function runArtJob(ref: string, job: ArtJob): Promise<string> {
	let url: string | null = null;
	try {
		url = await job.load();
		if (url === null) console.warn('[resolve] art unreachable, using fallback:', job.source);
	} catch (error) {
		console.warn('[resolve] art failed, using fallback:', job.source, error);
	}
	if (url !== null) {
		failures.delete(ref);
		commitSheetResult(ref, url);
		return url;
	}
	const failed = (failures.get(ref) ?? 0) + 1;
	failures.set(ref, failed);
	const result = job.fallback();
	commitSheetResult(ref, result);
	const delay = ART_RETRY_DELAYS_MS[failed - 1];
	if (delay !== undefined) {
		retryTimers.set(
			ref,
			setTimeout(() => {
				retryTimers.delete(ref);
				void startArtJob(ref, job);
			}, delay)
		);
	}
	return result;
}

/** One attempt at a ref, shared by everyone who asks while it is running. */
function startArtJob(ref: string, job: ArtJob): Promise<string> {
	const running = inflight.get(ref);
	if (running) return running;
	const timer = retryTimers.get(ref);
	if (timer !== undefined) {
		clearTimeout(timer);
		retryTimers.delete(ref);
	}
	const promise = runArtJob(ref, job).finally(() => inflight.delete(ref));
	inflight.set(ref, promise);
	return promise;
}

function sheetJob(payload: SheetRefPayload): ArtJob {
	return {
		load: () => sliceCell(payload),
		fallback: () => fallbackArt(payload),
		source: payload.url
	};
}

function textureJob(url: string, fallback: ArtFallback): ArtJob {
	return {
		load: async () => (await loadTextureImage(url))?.url ?? null,
		fallback: () => fallbackArt(fallback),
		source: url
	};
}

/**
 * Is this ref showing a placeholder because its art did not load? It may
 * still heal — see `ART_RETRY_DELAYS_MS`.
 */
export function artFailed(ref: string): boolean {
	return failures.has(ref);
}

/**
 * A plain image URL on another origin. WebGL needs CORS headers an `<img>`
 * does not, and hosts that matter here (the-unmatched.club's R2) send none —
 * so these cannot be handed to a texture loader as they are.
 */
export function isOffOriginUrl(ref: string | undefined | null): ref is string {
	if (!ref || !/^https?:\/\//i.test(ref)) return false;
	if (typeof location === 'undefined') return true;
	return !ref.startsWith(`${location.origin}/`);
}

/**
 * Resolve a ref ahead of rendering — used on incoming syncs so a joining
 * client paints deterministically, and by the importer so local imports
 * paint synchronously on first render. A ref that failed before is tried
 * again, from the top of the backoff. Returns what was committed: the art,
 * or its fallback ('' only if even the fallback can't draw — no canvas).
 */
export async function prewarmTextureRef(ref: string, fallback: ArtFallback = {}): Promise<string> {
	const sheet = ref.startsWith('sheet:');
	if (!sheet && (!isOffOriginUrl(ref) || typeof Image === 'undefined')) return ref;
	const running = inflight.get(ref);
	if (running) return running;
	const existing = get(sheetRefCache)[ref];
	if (existing !== undefined && !failures.has(ref)) return existing;
	failures.delete(ref);
	if (!sheet) return startArtJob(ref, textureJob(ref, fallback));
	const payload = parseSheetRef(ref);
	if (!payload) {
		commitSheetResult(ref, '');
		return '';
	}
	return startArtJob(ref, sheetJob(payload));
}

/** `prewarmTextureRef` for a `sheet:` ref — the importer's name for it. */
export const prewarmSheetRef = (ref: string): Promise<string> => prewarmTextureRef(ref);

function resolveSheet(ref: string, cache?: Record<string, string>): string {
	const map = cache ?? get(sheetRefCache);
	const cached = map[ref];
	if (cached !== undefined) return cached;

	if (!inflight.has(ref)) {
		const payload = parseSheetRef(ref);
		if (!payload) commitSheetResult(ref, '');
		else void startArtJob(ref, sheetJob(payload));
	}
	return ''; // pending — the store commit re-renders subscribers when it lands
}

/**
 * Resolve a face ref to an image URL. Unknown refs pass through, and so do
 * plain URLs — right for an `<img>`, which needs no CORS headers. Anything
 * that becomes a WebGL texture wants `resolveTextureImage` instead.
 */
export function resolveCardImage(
	ref: string | undefined | null,
	sheetCache?: Record<string, string>
): string {
	if (!ref) return '';
	if (ref.startsWith('gen:')) return resolveGen(ref);
	if (ref.startsWith('sheet:')) return resolveSheet(ref, sheetCache);
	return ref;
}

/**
 * `resolveCardImage` for a texture (tableplace-262). A plain off-origin URL
 * is probed first and resolves to whichever address WebGL can actually read —
 * the URL itself, or the same image through the CORS proxy — and to the
 * `fallback` placeholder when neither loads. Async like a sheet ref: '' while
 * the probe runs, then a `sheetRefCache` commit re-renders the caller.
 */
export function resolveTextureImage(
	ref: string | undefined | null,
	sheetCache?: Record<string, string>,
	fallback: ArtFallback = {}
): string {
	if (!isOffOriginUrl(ref)) return resolveCardImage(ref, sheetCache);
	if (typeof Image === 'undefined') return ref; // SSR: pass through harmlessly
	const cached = (sheetCache ?? get(sheetRefCache))[ref];
	if (cached !== undefined) return cached;
	if (!inflight.has(ref)) void startArtJob(ref, textureJob(ref, fallback));
	return '';
}
