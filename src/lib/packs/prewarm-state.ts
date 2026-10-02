import type { GameDTO } from '$lib/store/game/types';
import { artFailed, isOffOriginUrl, prewarmTextureRef } from './resolve.svelte';
import { ensureModelCatalog } from '$lib/models/catalog-store';
import { prewarmModelRef } from '$lib/models/loader';

type ArtFallback = { name?: string; back?: boolean };

function collectRefs(state: Partial<GameDTO> | undefined): Map<string, ArtFallback> {
	const refs = new Map<string, ArtFallback>();
	if (!state) return refs;
	// the two async schemes: sheets slice, models fetch GLBs — both are warmed
	// so an incoming sync paints deterministically instead of healing piecemeal
	const push = (value?: string | null) => {
		if (value?.startsWith('sheet:') || value?.startsWith('model:')) refs.set(value, {});
	};
	// card art is a texture, so a plain off-origin URL is async too: it is
	// probed, and proxied when its host sends no CORS headers (tableplace-262).
	// A piece's image is not — PieceFace does its own CORS fallback.
	const pushCard = (value: string | null | undefined, fallback: ArtFallback) => {
		if (isOffOriginUrl(value)) refs.set(value, fallback);
		else push(value);
	};

	for (const card of Object.values(state.cards ?? {})) {
		pushCard(card?.faceImageUrl, { name: card?.name });
		pushCard(card?.backImageUrl, { back: true });
	}
	for (const deck of Object.values(state.decks ?? {})) {
		pushCard(deck?.deckBackImageUrl, { back: true });
		for (const card of deck?.cards ?? []) {
			pushCard(card?.faceImageUrl, { name: card?.name });
			pushCard(card?.backImageUrl, { back: true });
		}
	}
	for (const piece of Object.values(state.pieces ?? {})) {
		push(piece?.imageUrl);
		push(piece?.model);
		// every state, not just the current one: cycling must not wait on a fetch
		for (const pieceState of piece?.states ?? []) push(pieceState?.face);
	}
	for (const player of Object.values(state.players ?? {})) {
		for (const card of Object.values(player?.tray ?? {})) {
			pushCard(card?.faceImageUrl, { name: card?.name });
			pushCard(card?.backImageUrl, { back: true });
		}
	}
	return refs;
}

/**
 * Resolve every async art ref present in a (synced) game state, then invoke
 * the callback once all slices are committed. Used on incoming syncs so
 * a re-render sweep can repaint everything deterministically — no
 * reliance on per-component reactive healing.
 */
export async function prewarmGameState(
	state: Partial<GameDTO> | undefined,
	onWarm?: (report: { total: number; failed: number }) => void
): Promise<void> {
	const art = collectRefs(state);
	const refs = [...art.keys()];
	if (refs.length === 0) return;
	console.log(`[prewarm] resolving ${refs.length} art refs…`);
	const catalog = refs.some((ref) => ref.startsWith('model:')) ? await ensureModelCatalog() : null;
	const results = await Promise.allSettled(
		refs.map((ref) =>
			ref.startsWith('model:')
				? prewarmModelRef(catalog, ref)
				: prewarmTextureRef(ref, art.get(ref))
		)
	);
	// art showing its placeholder counts as failed, though it may yet heal:
	// the resolver keeps retrying it (see ART_RETRY_DELAYS_MS)
	const failed = results.filter(
		(r, i) =>
			r.status === 'rejected' ||
			(r.status === 'fulfilled' && (r.value === '' || r.value === false)) ||
			artFailed(refs[i]!)
	).length;
	console.log(`[prewarm] done: ${refs.length - failed}/${refs.length} resolved`);
	onWarm?.({ total: refs.length, failed });
}
