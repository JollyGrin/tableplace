/**
 * The one place the URL's debug/deeplink params are read (#181).
 *
 * A game is created in a lobby and joined by a `?lobby=` deeplink, so a player
 * landing there has no use for global/dev controls (pack library, preset
 * seeding, fps graph…). `?debug` brings them back. Call these once at
 * component init and branch on the result — flipping it later would mount or
 * unmount tweakpane blades, which can take the whole pane down.
 */

const params = (): URLSearchParams =>
	typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search);

/** `?debug`, `?debug=1`, `&debug=true` — anything but an explicit `0`/`false` */
export function isDebug(): boolean {
	const value = params().get('debug');
	return value !== null && value !== '0' && value !== 'false';
}

/** joined an existing game by link: `?lobby=` is present */
export function isDeeplinked(): boolean {
	return !!params().get('lobby');
}

/** global/dev-only controls show off a deeplink, or when `?debug` asks for them */
export function showGlobalControls(): boolean {
	return !isDeeplinked() || isDebug();
}
