/**
 * Spec versions for the tbpp/tbps document formats, and the reader policy
 * that makes old files keep working.
 *
 * Two version fields exist and they answer different questions:
 *
 * - `tbpp` / `tbps` — the in-band format discriminator. Identifies *which
 *   format* a file is, and gates the container shape (tbps 1 vs 2 are
 *   genuinely different layouts).
 * - `specVersion` — semver of the spec revision the document was authored
 *   against. Fine-grained enough to tell an additive change from a breaking
 *   one, and to fetch the exact schema from its release tag.
 *
 * Schema-side metadata alone is not enough: a file that has escaped into the
 * wild has to say what it was written against, or nothing downstream can
 * decide whether it is safe to read.
 */

/**
 * Bump on any change to the pack schema. See docs/packs.md § Spec versioning.
 *
 * 1.8.0 — decks, pieces and overlays can carry `locked` (spawn pinned in
 * place: no drag, flip, turn or group until `L` unpins it; the TTS importer
 * maps `Locked` onto it, tableplace-189). Additive: every earlier 1.x pack is
 * still valid.
 *
 * 1.7.0 — pieces can carry `reach` (how many snap-point links the piece
 * usually travels; advisory reach rings, tableplace-190). Additive: every
 * earlier 1.x pack is still valid.
 *
 * 1.6.0 — added the `model` piece kind with its `model:<kit>/<name>` catalog
 * ref (the fourth face-ref scheme), and optional `rotation` (yaw degrees) on
 * every piece. Additive: every earlier 1.x pack is still valid.
 *
 * 1.5.0 — pieces can carry `snap: false` (the per-piece snap opt-out),
 * additive: every earlier 1.x pack is still valid.
 * 1.4.0 — added per-card `orientation` (`'portrait' | 'landscape'`) to deck
 * cards and bag card items, additive: every earlier 1.x pack is still valid.
 *
 * 1.3.0 — added the `bag` piece kind (`contents`/`drawMode`/`infinite`),
 * additive: every earlier 1.x pack is still valid.
 */
export const PACK_SPEC_VERSION = '1.8.0';

/**
 * The scenario spec is deliberately 0.x: it is unstable and carries no
 * compatibility promise (issue #39), and semver's 0.x rule — where the minor
 * is the breaking component — says exactly that.
 *
 * Which means, while this is 0.x, an **additive** change bumps the PATCH, not
 * the minor. `breakingRank` below ranks 0.x by minor, so bumping the minor for
 * a new optional field claims a break that did not happen, and every 0.1.x
 * build then refuses files it could have read perfectly well. (The general
 * "additive → minor" convention in docs/packs.md § Release convention is the
 * 1.x rule; it inverts under 0.x.)
 *
 * 0.1.14 — top-level `rotationStep` (degrees, 0 < step ≤ 360): how far Q
 * and E turn a card, deck or piece on the table, seeded into the synced
 * `state.table` (tableplace-200). One optional field — additive, so PATCH.
 *
 * 0.1.13 — `state.cards` can carry `placedBy` (the player who laid the card
 * face-down out of their hand, who alone previews its face — a UI rule, not
 * secrecy, tableplace-193). A scenario keeps it only when it names a seat
 * placeholder, and claiming that seat hands it to the claiming player.
 * Optional field on an existing shape — additive, so PATCH.
 *
 * 0.1.12 — placements can carry `locked` (lay any content down pinned, or
 * `false` to unpin what the pack pins), and `state.cards`, `state.decks`,
 * `state.pieces` and `state.overlays` can carry `locked` (tableplace-189).
 * Optional fields on existing shapes — additive, so PATCH.
 *
 * 0.1.11 — snap points can carry `links` (ids of connected points — an
 * optional board graph) and `tags` (free-form labels), and `state.pieces` can
 * carry `reach` (tableplace-190). Optional fields on existing shapes —
 * additive, so PATCH.
 *
 * 0.1.10 — `state.cards` (deck cards and hand cards too) can carry `name`,
 * the zoomed preview's caption (tableplace-192). One optional field —
 * additive, so PATCH.
 *
 * 0.1.9 — `state.pieces` can be `kind: 'model'` and carry the `model:` catalog
 * ref (tableplace-135). A widened union plus one optional field — additive, so
 * PATCH, not minor, per the 0.x rule above.
 *
 * 0.1.8 — snap points 2.0: optional elevation (`y`), the `kind: 'grid'`
 * variant (`pitch`/`cols`/`rows`/`yawStep`), and `snap: false` on pieces. All
 * optional fields on existing shapes — additive, so PATCH, not minor (two
 * workers have bumped 0.x wrong before; `check-schemas.ts` will not catch it).
 * 0.1.7 — `state.cards` (and bag card items) can carry `orientation`,
 * additive — so a PATCH bump, per the 0.x rule above.
 *
 * 0.1.6 — `state.pieces` can carry the bag fields (this schema is generated
 * from `Partial<GameDTO>`), additive.
 */
export const SCENARIO_SPEC_VERSION = '0.1.14';

export type Semver = { major: number; minor: number; patch: number };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(value: string): Semver | null {
	const m = SEMVER.exec(value);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * The component that changes on a breaking change. Under semver, 0.x releases
 * may break on every minor, so for them the breaking component is `0.<minor>`.
 */
function breakingRank(v: Semver): [number, number] {
	return v.major === 0 ? [0, v.minor] : [v.major, 0];
}

/** `a` is newer than `b` in the component that is allowed to break. */
function isBreakingNewer(a: Semver, b: Semver): boolean {
	const [aMajor, aMinor] = breakingRank(a);
	const [bMajor, bMinor] = breakingRank(b);
	return aMajor !== bMajor ? aMajor > bMajor : aMinor > bMinor;
}

/**
 * Validate a document's declared `specVersion` against what this build reads.
 *
 * The policy, and why:
 * - **absent** — the file predates spec versioning. Accepted: refusing it would
 *   break every file exported before this field existed.
 * - **older** — accepted. Keeping old files readable is the point.
 * - **newer, same breaking component** — accepted. Those changes are additive
 *   by the release convention, and unknown fields are ignored on import.
 * - **newer breaking component** — rejected, because the file may rely on a
 *   field that was removed, renamed, or tightened out from under this build.
 *
 * Throws an Error naming the version and where to find its schema.
 */
export function assertReadableSpecVersion(
	declared: unknown,
	supported: string,
	format: 'pack' | 'scenario'
): void {
	if (declared === undefined || declared === null) return;
	if (typeof declared !== 'string') {
		throw new Error(`specVersion must be a semver string like "${supported}"`);
	}
	const version = parseSemver(declared);
	if (!version) {
		throw new Error(
			`specVersion ${JSON.stringify(declared)} is not a semver version like "${supported}"`
		);
	}
	const current = parseSemver(supported);
	if (current && isBreakingNewer(version, current)) {
		throw new Error(
			`This file declares ${format} spec ${declared}, which is newer than the ${supported} ` +
				`this build reads. Fetch the matching schema at the tag spec/${format}/v${declared}, ` +
				`or re-export the file from a current build.`
		);
	}
}
