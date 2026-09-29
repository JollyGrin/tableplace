import { useThrelte } from '@threlte/core';
import { Texture } from 'three';

/**
 * Anisotropic filtering asked of every loaded image texture. Card faces and
 * map overlays are seen at the seat camera's glancing angle, where the
 * default of 1 (plain trilinear) smears them; 8 is where the sharpening
 * plateaus on common GPUs. The renderer's own maximum still caps it.
 */
export const TEXTURE_ANISOTROPY = 8;

/** The anisotropy to use on a renderer that supports at most `max` (0 = none). */
export function textureAnisotropy(max: number): number {
	return Math.max(1, Math.min(TEXTURE_ANISOTROPY, max));
}

/**
 * Sharpens every texture the scene loads from here on. `ImageMaterial`
 * (cards, decks, overlays) and `PieceFace` build their textures inside
 * loaders that take no per-texture options, so the one shared seam is the
 * default every `Texture` is constructed with. Call it at the top of the
 * scene root, before any textured child mounts. Textures that set their own
 * anisotropy (the felt wordmark, the counter dial) keep it.
 */
export function useTextureSharpness(): void {
	const { renderer } = useThrelte();
	Texture.DEFAULT_ANISOTROPY = textureAnisotropy(renderer.capabilities.getMaxAnisotropy());
}
