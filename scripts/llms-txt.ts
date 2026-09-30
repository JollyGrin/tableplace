/**
 * Compose `static/llms.txt` — the single self-contained document a third party
 * (human or LLM, no repo access) reads to author an importable `.tbpp.json` or
 * `.tbps.json`.
 *
 * Prose lives in `llms.template.md`; every fact that could drift is injected:
 * the two JSON Schemas, the world-coordinate constants (read from
 * `constants-*.ts`), and the worked examples (read from
 * `src/lib/formats/examples.ts`, which the contract test also validates).
 */

import { EXAMPLE_PACK, EXAMPLE_PACK_URL, EXAMPLE_SCENARIO } from '../src/lib/formats/examples';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	CARD_WIDTH,
	CARD_HEIGHT,
	CARD_THICKNESS,
	CARD_REST_Y,
	CARD_STACK_RADIUS,
	DECK_HEIGHT_PER_CARD,
	DECK_MIN_HEIGHT,
	DECK_MAX_HEIGHT
} from '../src/lib/utils/constants-cards';
import {
	TABLE_HALF_X,
	TABLE_HALF_Z,
	TABLE_TOP_Y,
	EDGE_MARGIN
} from '../src/lib/utils/constants-table';
import {
	PIECE_THICKNESS,
	PIECE_REST_Y,
	PIECE_DEFAULT_RADIUS,
	PIECE_RADIUS,
	COUNTER_MAX_DEFAULT,
	DIE_SIDES,
	DIE_SIDES_DEFAULT,
	BAG_HEIGHT
} from '../src/lib/utils/constants-pieces';
import { SNAP_RADIUS_DEFAULT } from '../src/lib/utils/constants-snap';
import {
	TBPP_VERSION,
	PACK_SCHEMA_URL,
	PIECE_KINDS,
	BAG_ITEM_KINDS,
	BAG_DRAW_MODES,
	CARD_ORIENTATIONS
} from '../src/lib/packs/file';
import { TOKEN_SHAPES } from '../src/lib/primitives/token-shape';
import { TBPS_VERSION, TBPS_SUPPORTED, SCENARIO_SCHEMA_URL } from '../src/lib/scenario/file';
import { PACK_SPEC_VERSION, SCENARIO_SPEC_VERSION } from '../src/lib/formats/spec-version';

/**
 * World-coordinate constants an outside generator needs in order to place
 * things. Values are imported; only the notes are written here.
 */
const CONSTANTS: [name: string, value: number | string, note: string][] = [
	['TABLE_HALF_X', TABLE_HALF_X, 'table extends x ∈ [-30, 30] — the long axis'],
	['TABLE_HALF_Z', TABLE_HALF_Z, 'table extends z ∈ [-15, 15] — the short axis'],
	['TABLE_TOP_Y', TABLE_TOP_Y, 'y of the felt surface; everything rests on or above it'],
	['EDGE_MARGIN', EDGE_MARGIN, 'keep placements this far inside the edge so they stay grabbable'],
	['CARD_WIDTH', CARD_WIDTH, 'card size along x'],
	[
		'CARD_HEIGHT',
		CARD_HEIGHT,
		'card size along z (cards lie flat — "height" is depth on the table)'
	],
	['CARD_THICKNESS', CARD_THICKNESS, 'card size along y'],
	['CARD_REST_Y', CARD_REST_Y, 'y of a single card lying on the table'],
	['CARD_STACK_RADIUS', CARD_STACK_RADIUS, 'cards closer than this in xz count as one stack'],
	['DECK_HEIGHT_PER_CARD', DECK_HEIGHT_PER_CARD, 'a deck grows this tall per card…'],
	['DECK_MIN_HEIGHT', DECK_MIN_HEIGHT, '…clamped to this floor…'],
	['DECK_MAX_HEIGHT', DECK_MAX_HEIGHT, '…and this ceiling. Deck y of 0.4 is a safe default.'],
	['PIECE_THICKNESS', PIECE_THICKNESS, 'thickness of a token/counter disc'],
	['PIECE_REST_Y', PIECE_REST_Y, 'y of a piece centre resting on the table'],
	['PIECE_DEFAULT_RADIUS', PIECE_DEFAULT_RADIUS, 'footprint radius when a piece omits `radius`'],
	['PIECE_RADIUS.token', PIECE_RADIUS.token, 'default radius per kind — token'],
	['PIECE_RADIUS.pawn', PIECE_RADIUS.pawn, 'default radius per kind — pawn'],
	['PIECE_RADIUS.counter', PIECE_RADIUS.counter, 'default radius per kind — counter'],
	['PIECE_RADIUS.die', PIECE_RADIUS.die, 'default radius per kind — die (its circumradius)'],
	['PIECE_RADIUS.bag', PIECE_RADIUS.bag, 'default radius per kind — bag'],
	['COUNTER_MAX_DEFAULT', COUNTER_MAX_DEFAULT, 'starting max for a counter with no `maxValue`'],
	['DIE_SIDES', DIE_SIDES.join(', '), 'die shapes that exist; any other `sides` is rejected'],
	['DIE_SIDES_DEFAULT', DIE_SIDES_DEFAULT, 'faces a die gets when it omits `sides`'],
	['BAG_HEIGHT', BAG_HEIGHT, 'height of the bag pouch, drawn up from the felt'],
	['SNAP_RADIUS_DEFAULT', SNAP_RADIUS_DEFAULT, 'catch radius of a snap point that omits `radius`']
];

function constantsTable(): string {
	const rows = CONSTANTS.map(([name, value, note]) => `| \`${name}\` | ${value} | ${note} |`);
	return ['| Constant | Value | Meaning |', '| --- | --- | --- |', ...rows].join('\n');
}

/**
 * Injected JSON arrives already wrapped in its fence: a ```json fence holding
 * a `{{PLACEHOLDER}}` would not be valid JSON, and prettier formats fenced
 * code blocks it recognises when it checks the template.
 */
const fence = (body: string) => '```json\n' + body.trimEnd() + '\n```';
const jsonBlock = (value: unknown) => fence(JSON.stringify(value, null, '\t'));

/**
 * Render a closed set of string literals as prose — `` `"a"`, `"b"` or `"c"` ``
 * — built from the same runtime array the parser validates `kind`/`drawMode`/
 * etc. against, so a value added there can't ship without appearing here too.
 * `notes` adds an optional parenthetical per value, e.g. marking a default.
 */
function enumProse(values: readonly string[], notes: Partial<Record<string, string>> = {}): string {
	const parts = values.map((v) => {
		const note = notes[v];
		return note ? `\`"${v}"\` (${note})` : `\`"${v}"\``;
	});
	if (parts.length < 2) return parts.join('');
	return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * Substitute `{{KEY}}` placeholders. Throws on an unknown or unfilled
 * placeholder so a typo fails the build rather than shipping a literal
 * `{{TYPO}}` into the published contract.
 */
function fill(template: string, values: Record<string, string>): string {
	const out = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		if (!(key in values)) throw new Error(`llms.template.md references unknown key {{${key}}}`);
		return values[key];
	});
	const leftover = /\{\{(\w+)\}\}/.exec(out);
	if (leftover) throw new Error(`unfilled placeholder ${leftover[0]} in llms.txt`);
	return out;
}

export function renderLlmsTxt(packSchemaJson: string, scenarioSchemaJson: string): string {
	const template = readFileSync(resolve(import.meta.dirname, 'llms.template.md'), 'utf-8');
	return fill(template, {
		PACK_SCHEMA: fence(packSchemaJson),
		SCENARIO_SCHEMA: fence(scenarioSchemaJson),
		PACK_EXAMPLE: jsonBlock(EXAMPLE_PACK),
		SCENARIO_EXAMPLE: jsonBlock(EXAMPLE_SCENARIO),
		EXAMPLE_PACK_URL,
		CONSTANTS_TABLE: constantsTable(),
		TBPP_VERSION: String(TBPP_VERSION),
		TBPS_VERSION: String(TBPS_VERSION),
		TBPS_SUPPORTED: TBPS_SUPPORTED.join(' and '),
		PACK_SPEC_VERSION,
		SCENARIO_SPEC_VERSION,
		PACK_SCHEMA_URL,
		SCENARIO_SCHEMA_URL,
		PIECE_KINDS: enumProse(PIECE_KINDS),
		TOKEN_SHAPES: enumProse(TOKEN_SHAPES, { disc: 'the default' }),
		CARD_ORIENTATIONS: enumProse(CARD_ORIENTATIONS, { portrait: 'default' }),
		BAG_PIECE_ITEM_KINDS: enumProse(BAG_ITEM_KINDS.filter((k) => k !== 'card')),
		BAG_DRAW_MODES: enumProse(BAG_DRAW_MODES, {
			random: 'the default: a blind draw',
			lifo: 'last in, first out — a stack',
			fifo: 'a queue'
		})
	});
}
