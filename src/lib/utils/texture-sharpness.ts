import { useThrelte } from '@threlte/core';
import { Texture } from 'three';
import { textureAnisotropy } from './constants-textures';

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
