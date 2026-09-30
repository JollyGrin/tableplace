/**
 * The printed top face of a counter (tableplace-191): its name, its value in
 * large numerals, `of max` when it has one, and — with a max — an arc round
 * the rim showing value/max. Drawn onto a canvas that becomes the face's
 * texture, so the counter reads from the seat without a floating pill.
 *
 * Pure rendering of the counter's existing fields; nothing here knows what the
 * number means to a game.
 */

/** Canvas edge in px. Big enough that the numerals stay crisp at the seat view. */
export const DIAL_TEXTURE_PX = 512;

/** Rim arc colours: full → half → quarter */
export const DIAL_ARC_COLORS = { high: '#3d9a68', mid: '#d89b1d', low: '#bb4430' } as const;

export type DialFace = {
	name: string;
	value: number;
	maxValue?: number;
	/** an image sits under the face: draw a scrim, not an opaque plate */
	overImage?: boolean;
};

/** value/max clamped to 0…1, or null for a counter with no (usable) max */
export function dialFraction(value: number, maxValue: number | undefined): number | null {
	if (maxValue == null || !(maxValue > 0)) return null;
	return Math.min(1, Math.max(0, value / maxValue));
}

/** The arc shifts colour at half and at a quarter */
export function dialArcColor(fraction: number): string {
	if (fraction > 0.5) return DIAL_ARC_COLORS.high;
	if (fraction > 0.25) return DIAL_ARC_COLORS.mid;
	return DIAL_ARC_COLORS.low;
}

/**
 * The identity of what the face shows: the texture is redrawn only when this
 * changes, never per frame.
 */
export function dialKey(face: DialFace): string {
	return JSON.stringify([face.name, face.value, face.maxValue ?? null, !!face.overImage]);
}

/** Largest font (px, ≤ `max`) at which `text` fits in `width` */
function fitFont(
	context: CanvasRenderingContext2D,
	text: string,
	weight: string,
	family: string,
	max: number,
	width: number
): number {
	let size = max;
	for (; size > 10; size -= 2) {
		context.font = `${weight} ${size}px ${family}`;
		if (context.measureText(text).width <= width) break;
	}
	return size;
}

const SANS = 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Paint `face` onto a square canvas of edge `size`. */
export function drawCounterDial(context: CanvasRenderingContext2D, size: number, face: DialFace) {
	const c = size / 2;
	const u = size / 256; // everything below is laid out on a 256 grid
	context.clearRect(0, 0, size, size);

	const disc = (r: number, fill: string) => {
		context.beginPath();
		context.arc(c, c, r * u, 0, Math.PI * 2);
		context.fillStyle = fill;
		context.fill();
	};

	// rim track, then the plate the text sits on. Over an image the plate is a
	// light wash and the text carries its own halo instead: a plate opaque
	// enough to read on by itself hides the art (tableplace-246 — at 0.72 an
	// image counter drew as a grey disc).
	disc(127, face.overImage ? 'rgba(22,19,15,0.55)' : '#16130f');
	disc(106, face.overImage ? 'rgba(251,248,238,0.25)' : '#fbf8ee');

	const fraction = dialFraction(face.value, face.maxValue);
	if (fraction != null && fraction > 0) {
		context.beginPath();
		context.arc(c, c, 116.5 * u, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
		context.strokeStyle = dialArcColor(fraction);
		context.lineWidth = 15 * u;
		context.lineCap = fraction < 1 ? 'round' : 'butt';
		context.stroke();
	}

	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.lineJoin = 'round';
	/** over an image, a cream halo keeps each glyph legible on any art */
	const print = (text: string, y: number, fill: string) => {
		if (face.overImage) {
			context.strokeStyle = 'rgba(251,248,238,0.9)';
			context.lineWidth = 8 * u;
			context.strokeText(text, c, y);
		}
		context.fillStyle = fill;
		context.fillText(text, c, y);
	};

	const hasMax = fraction != null;
	const name = face.name.trim().toUpperCase();
	if (name) {
		fitFont(context, name, '700', SANS, 30 * u, 150 * u);
		print(name, (hasMax ? 72 : 78) * u, '#1f2a22');
	}

	const value = String(face.value);
	fitFont(context, value, '700', SANS, (hasMax ? 104 : 116) * u, 170 * u);
	print(value, (name ? (hasMax ? 140 : 150) : 128) * u, '#1f2a22');

	if (hasMax) {
		const of = `of ${face.maxValue}`;
		fitFont(context, of, '600', SANS, 26 * u, 120 * u);
		print(of, 202 * u, '#47604f');
	}
}
