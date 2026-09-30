import { writable } from 'svelte/store';
import { loadTextureImage } from './image-cors';

/**
 * How wide an image is for its height, as something a `$derived` can read.
 *
 * A square token (tableplace-254) is a rectangle of its art's aspect, and
 * that is only known once the image has loaded — after the piece, its rings
 * and its drop footprint have all drawn once. Each of them reads the aspect
 * from here, so they all resize together when it arrives.
 *
 * Same pattern as `sheetRefCache` (packs/resolve.svelte.ts): subscribe with
 * `$imageAspects` and pass the snapshot in. Keyed by resolved URL and loaded
 * through `loadTextureImage`, whose promise cache means this costs no second
 * fetch next to the texture's own.
 */
export const imageAspects = writable<Record<string, number>>({});

const requested = new Set<string>();

/** width / height of `url`'s image; 1 until it has loaded, and if it never does. */
export function imageAspect(url: string | null | undefined, known: Record<string, number>): number {
	if (!url) return 1;
	const aspect = known[url];
	if (aspect !== undefined) return aspect;
	if (!requested.has(url)) {
		requested.add(url);
		void loadTextureImage(url).then((image) => {
			if (!image || !(image.width > 0) || !(image.height > 0)) return;
			imageAspects.update((m) => ({ ...m, [url]: image.width / image.height }));
		});
	}
	return 1;
}
