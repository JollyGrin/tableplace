import { describe, expect, it } from 'vitest';
import { TEXTURE_ANISOTROPY, textureAnisotropy } from '../constants-textures';

describe('textureAnisotropy', () => {
	it('asks for the target when the GPU allows more', () => {
		expect(textureAnisotropy(16)).toBe(TEXTURE_ANISOTROPY);
	});

	it('is capped by the renderer maximum', () => {
		expect(textureAnisotropy(4)).toBe(4);
	});

	it('falls back to plain filtering without the extension', () => {
		expect(textureAnisotropy(0)).toBe(1);
	});
});
