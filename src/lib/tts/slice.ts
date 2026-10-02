/**
 * Sprite-sheet slicing for TTS imports: fetch a sheet image once,
 * cut cells into data URLs. Browser-only (canvas + Image).
 *
 * Failure modes are expected and non-fatal: dead URLs (link rot) and
 * hosts without CORS headers both resolve to `null`, and the importer
 * substitutes named placeholder faces.
 */

import { corsProxied } from '$lib/utils/image-cors';
import type { SheetCell } from './parse';

/**
 * `corsProxied` is a CORS-adding pass-through proxy (already run for
 * unbrewed). Many hosts serve images without CORS headers (the-unmatched.club's R2, pinimg) —
 * fine for plain <img> display, but slicing/WebGL requires pixel access.
 * Direct load is always tried first: Steam's CDN and imgur serve open
 * CORS and need no proxy.
 */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImageFrom(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous'; // required to keep the canvas untainted
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
	const cached = imageCache.get(url);
	if (cached) return cached;
	const promise = loadImageFrom(url)
		.then((img) => img ?? loadImageFrom(corsProxied(url)))
		.then((img) => {
			// only a loaded sheet is kept: a failed one is fetched again by the
			// next slice, which is what lets a retry succeed (tableplace-262)
			if (!img) imageCache.delete(url);
			return img;
		});
	imageCache.set(url, promise);
	return promise;
}

const cellCache = new Map<string, string>();

/** Persistent cell cache (IndexedDB): sliced cells survive page reloads,
 *  so refreshes render instantly and never depend on flaky upstream hosts. */
const DB_NAME = 'tableplace-sheets';
const STORE = 'cells';

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => resolve(null);
	});
}
/** never let a wedged IndexedDB open hang the whole art pipeline */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([promise, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

const dbPromise: Promise<IDBDatabase | null> | null =
	typeof indexedDB !== 'undefined' ? withTimeout(openDb(), 1500, null) : null;

async function idbGet(key: string): Promise<string | null> {
	const db = await (dbPromise ?? Promise.resolve(null));
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
			req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

async function idbPut(key: string, value: string): Promise<void> {
	const db = await (dbPromise ?? Promise.resolve(null));
	if (!db) return;
	try {
		db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
	} catch {
		// quota/private-mode failures are non-fatal — memory cache still works
	}
}

/**
 * Resolve a sheet cell to a data URL, or null if the sheet is
 * unreachable/CORS-blocked. Cells are cached in memory and IndexedDB.
 */
export async function sliceCell(cell: SheetCell): Promise<string | null> {
	const key = `${cell.url}#${cell.cols}x${cell.rows}@${cell.index}`;
	const cached = cellCache.get(key);
	if (cached) return cached;

	const persisted = await idbGet(key);
	if (persisted) {
		cellCache.set(key, persisted);
		return persisted;
	}

	const img = await loadImage(cell.url);
	if (!img) return null;

	const cw = img.naturalWidth / cell.cols;
	const ch = img.naturalHeight / cell.rows;
	const sx = (cell.index % cell.cols) * cw;
	const sy = Math.floor(cell.index / cell.cols) * ch;

	const canvas = document.createElement('canvas');
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);

	try {
		const url = canvas.toDataURL('image/jpeg', 0.85);
		cellCache.set(key, url);
		void idbPut(key, url);
		return url;
	} catch {
		return null; // tainted canvas (host without CORS) — caller falls back
	}
}
