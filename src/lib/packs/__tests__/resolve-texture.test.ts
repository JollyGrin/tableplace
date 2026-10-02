/**
 * tableplace-262: the opponent seat's card art. Two ways it went missing —
 * a plain URL on a host without CORS headers handed straight to WebGL, and a
 * slice that failed once and was remembered as failed for the whole session.
 *
 * `Image` is the network here: a stub that loads or errors by URL, so the
 * real `loadTextureImage` runs (direct, then proxy) under the real resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'svelte/store';
import { parseSavedObject } from '$lib/tts/parse';
import { cellToRef, ttsToPack } from '$lib/tts/to-pack';
import { CORS_PROXY, loadTextureImage } from '$lib/utils/image-cors';
import { prewarmGameState } from '../prewarm-state';
import {
	ART_RETRY_DELAYS_MS,
	artFailed,
	makeSheetRef,
	prewarmTextureRef,
	resolveCardImage,
	resolveTextureImage,
	sheetRefCache
} from '../resolve.svelte';

const sliceCell = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('$lib/tts/slice', () => ({ sliceCell }));
// jsdom has no canvas: give the placeholder a value a test can tell from art
vi.mock('../placeholder', () => ({ namedCardImage: (name: string) => `placeholder:${name}` }));

/** which URLs the "network" answers; everything else errors, as a CORS block does */
let reachable: (url: string) => boolean = () => false;
const requested: string[] = [];

class FakeImage {
	crossOrigin = '';
	naturalWidth = 420;
	naturalHeight = 600;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	set src(url: string) {
		requested.push(url);
		queueMicrotask(() => (reachable(url) ? this.onload?.() : this.onerror?.()));
	}
}

const proxied = (url: string) => CORS_PROXY + encodeURIComponent(url);
const viaProxyOnly = (url: string) => url.startsWith(CORS_PROXY);

let seq = 0;
/** a URL no earlier test has touched — the resolver's caches are module state */
const freshUrl = (file = 'cover.png') => `https://pub-r2.example.dev/${seq++}/${file}`;

beforeEach(() => {
	vi.stubGlobal('Image', FakeImage);
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
	requested.length = 0;
	reachable = () => false;
	sliceCell.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** let the image stub's microtasks and the resolver's promise chain run */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('a plain off-origin URL as a texture', () => {
	it('a TTS UniqueBack:false deck back is a plain URL — and never reaches WebGL raw', async () => {
		const fixture = JSON.parse(
			readFileSync(join(__dirname, '../../../../tts-unmatched-greviousdeck.json'), 'utf-8')
		);
		const back = ttsToPack(parseSavedObject(fixture)).decks[0]!.back!;
		// the shape that broke: not a sheet: ref, so nothing proxied it
		expect(back).toMatch(/^https:\/\//);
		expect(cellToRef({ url: back, cols: 1, rows: 1, index: 0 }, { back: true })).toBe(back);

		reachable = viaProxyOnly; // the host sends no CORS headers
		// pending, not the raw URL: WebGL would fail on it
		expect(resolveTextureImage(back, undefined, { back: true })).toBe('');
		await flush();
		expect(requested).toEqual([back, proxied(back)]);
		expect(resolveTextureImage(back, get(sheetRefCache))).toBe(proxied(back));
		expect(artFailed(back)).toBe(false);
	});

	it('resolves to the URL itself when the host does send CORS headers', async () => {
		const url = freshUrl();
		reachable = () => true;
		expect(resolveTextureImage(url)).toBe('');
		await flush();
		expect(resolveTextureImage(url)).toBe(url);
		expect(requested).toEqual([url]);
	});

	it('leaves same-origin, relative, data: and gen: refs alone', () => {
		expect(resolveTextureImage(`${location.origin}/art/card.png`)).toBe(
			`${location.origin}/art/card.png`
		);
		expect(resolveTextureImage('/local.jpg')).toBe('/local.jpg');
		expect(resolveTextureImage('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
		expect(resolveTextureImage('')).toBe('');
		expect(resolveTextureImage(undefined)).toBe('');
		expect(requested).toEqual([]);
	});

	it('resolveCardImage still passes a plain URL through — an <img> needs no CORS', () => {
		const url = freshUrl();
		expect(resolveCardImage(url)).toBe(url);
		expect(requested).toEqual([]);
	});

	it('falls back to a named placeholder when neither address loads, then heals on retry', async () => {
		const url = freshUrl('face.png');
		expect(resolveTextureImage(url, undefined, { name: 'Feint' })).toBe('');
		await flush();
		expect(resolveTextureImage(url)).toBe('placeholder:Feint');
		expect(artFailed(url)).toBe(true);

		reachable = viaProxyOnly; // the proxy comes back
		await vi.advanceTimersByTimeAsync(ART_RETRY_DELAYS_MS[0]!);
		expect(resolveTextureImage(url)).toBe(proxied(url));
		expect(artFailed(url)).toBe(false);
	});

	it('honours the localStorage corsproxy override', async () => {
		const url = freshUrl();
		localStorage.setItem('corsproxy', 'http://127.0.0.1:9/?url=');
		try {
			reachable = (candidate) => candidate.startsWith('http://127.0.0.1:9/');
			resolveTextureImage(url);
			await flush();
			expect(resolveTextureImage(url)).toBe(`http://127.0.0.1:9/?url=${encodeURIComponent(url)}`);
		} finally {
			localStorage.removeItem('corsproxy');
		}
	});
});

describe('loadTextureImage', () => {
	it('does not remember a failure: the next call fetches again', async () => {
		const url = freshUrl();
		const first = loadTextureImage(url);
		await flush();
		expect(await first).toBeNull();

		reachable = viaProxyOnly;
		const second = loadTextureImage(url);
		await flush();
		expect(await second).toMatchObject({ url: proxied(url) });
		// and a success IS remembered
		expect(loadTextureImage(url)).toBe(second);
	});
});

describe('a failed slice is not final', () => {
	const sheetRef = (name: string) =>
		makeSheetRef({ url: freshUrl('sheet.jpg'), cols: 10, rows: 2, index: 3, name });

	it('shows the placeholder, then retries on the backoff until the art lands', async () => {
		const ref = sheetRef('Skirmish');
		sliceCell.mockResolvedValue(null);

		expect(resolveCardImage(ref)).toBe('');
		await flush();
		expect(resolveCardImage(ref)).toBe('placeholder:Skirmish');
		expect(artFailed(ref)).toBe(true);
		expect(sliceCell).toHaveBeenCalledTimes(1);

		// rendering the placeholder again is not a new attempt
		resolveCardImage(ref);
		await flush();
		expect(sliceCell).toHaveBeenCalledTimes(1);

		// second attempt fails too, and the next one waits longer
		await vi.advanceTimersByTimeAsync(ART_RETRY_DELAYS_MS[0]!);
		expect(sliceCell).toHaveBeenCalledTimes(2);
		expect(resolveCardImage(ref)).toBe('placeholder:Skirmish');

		sliceCell.mockResolvedValue('data:image/jpeg;base64,ART');
		await vi.advanceTimersByTimeAsync(ART_RETRY_DELAYS_MS[1]! - 1);
		expect(sliceCell).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(sliceCell).toHaveBeenCalledTimes(3);
		expect(resolveCardImage(ref)).toBe('data:image/jpeg;base64,ART');
		expect(artFailed(ref)).toBe(false);

		// healed: nothing left on a timer
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sliceCell).toHaveBeenCalledTimes(3);
	});

	it('gives up after the last delay — until the next sync starts it over', async () => {
		const ref = sheetRef('Regroup');
		sliceCell.mockResolvedValue(null);
		resolveCardImage(ref);
		await flush();
		for (const delay of ART_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
		const attempts = 1 + ART_RETRY_DELAYS_MS.length;
		expect(sliceCell).toHaveBeenCalledTimes(attempts);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sliceCell).toHaveBeenCalledTimes(attempts);

		// a sync prewarms every ref in the state: the dead one is tried again, now
		sliceCell.mockResolvedValue('data:image/jpeg;base64,BACK');
		const report = vi.fn();
		await prewarmGameState(
			{ cards: { 'card:seat1:regroup': { faceImageUrl: ref } } } as never,
			report
		);
		expect(sliceCell).toHaveBeenCalledTimes(attempts + 1);
		expect(resolveCardImage(ref)).toBe('data:image/jpeg;base64,BACK');
		expect(report).toHaveBeenCalledWith({ total: 1, failed: 0 });
	});

	it('a prewarm that lands on a placeholder is reported as failed', async () => {
		const ref = sheetRef('Wily Fighting');
		const back = freshUrl();
		sliceCell.mockResolvedValue(null);
		const report = vi.fn();
		await prewarmGameState(
			{
				decks: {
					'deck:seat1:main': {
						deckBackImageUrl: back,
						cards: [{ id: 'card:seat1:wily', name: 'Wily Fighting', faceImageUrl: ref }]
					}
				}
			} as never,
			report
		);
		expect(report).toHaveBeenCalledWith({ total: 2, failed: 2 });
		// a deck back falls back to the generated back, not a named proxy
		expect(get(sheetRefCache)[back]).toBe(resolveCardImage('gen:std52/back'));
		expect(get(sheetRefCache)[ref]).toBe('placeholder:Wily Fighting');
	});

	it('an attempt already running is shared, not doubled', async () => {
		const ref = sheetRef('Feint');
		let land: (url: string | null) => void = () => {};
		sliceCell.mockReturnValue(new Promise((resolve) => (land = resolve)));
		resolveCardImage(ref);
		const warm = prewarmTextureRef(ref);
		resolveCardImage(ref);
		land('data:image/jpeg;base64,ONE');
		expect(await warm).toBe('data:image/jpeg;base64,ONE');
		expect(sliceCell).toHaveBeenCalledTimes(1);
	});
});
