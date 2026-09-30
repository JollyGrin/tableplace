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
