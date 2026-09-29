# tbpp & tbps — the table.place file formats

table.place has two native file formats, both plain JSON:

| Format                              | Filename           | What it is                                                                                                     |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| **tbpp** — table.place **pack**     | `<name>.tbpp.json` | A content library: decks (piles of cards), pieces, board overlays. What _exists_.                              |
| **tbps** — table.place **scenario** | `<name>.tbps.json` | An arrangement: where things start, which seat owns what, initial counter values. What the _table looks like_. |

"Deck" keeps its everyday meaning — one pile of cards _inside_ a pack. A pack can hold several decks (draw pile, discard, tokens-as-cards…).

The compound `.tbpp.json` / `.tbps.json` suffix keeps the brand while staying `.json` to every tool: GitHub renders them, editors validate them via the `$schema` line, `jq` doesn't care.

## In-band discriminators

Files get renamed and piped, so the _content_ identifies the format, not the filename. Every pack file carries `"tbpp": 1` and every scenario file carries `"tbps": 1` or `"tbps": 2` at the top level — the value is the format version. Parsers reject files without their marker (with one legacy exception, below) and files from a future version, with readable errors either way.

## Validation

JSON Schemas are generated from the TypeScript types (`bun run schemas` → `static/`) and served by the deployed site:

- `https://table.place/pack.schema.json`
- `https://table.place/scenario.schema.json`

Add the `$schema` line to a hand-written file and VS Code gives you autocomplete and inline validation for free. The app's own parsers (`parsePackFile` / `parseScenarioFile`) validate independently at import time and point at the offending field (`decks[0].cards[3].face must be a non-empty string`). Both import surfaces — the pack file picker and scenario load in `/setup` — surface those messages as toasts rather than console errors.

Generation runs as part of `bun run build`, and CI (`bun run schemas:check`) fails if regeneration produces different content than what is committed, or if a schema changed without a spec-version bump — see [Spec versioning](#spec-versioning) below. The published schemas therefore cannot drift from the types.

The schema plus this doc is the whole authoring contract — the format is deliberately small enough to hand-write, generate from a spreadsheet, or ask an LLM for.

### For third parties and LLMs

`static/llms.txt` (served at `https://table.place/llms.txt`) is a single self-contained document generated from the same sources: both schemas inlined, the face-ref grammar, the world-coordinate constants, and a worked example of each format. Someone with no access to this repo should be able to read that one URL and emit a file that imports cleanly. It is generated — edit `scripts/llms.template.md`, not the output.

The worked examples live in `src/lib/formats/examples.ts` and are driven through the real import/spawn path by `src/lib/formats/__tests__/contract.test.ts`, so a published example that stopped working fails CI.

## Stability

**tbpp (packs) is a stated contract.** Decks, pieces and overlays are implemented and round-tripped in CI. Write against it.

**tbps (scenarios) is unstable and carries no compatibility promise.** Its schema is generated from live internal types (`Partial<GameDTO>` in particular) that are still churning; it is published so the current shape is visible, not as a guarantee. See issue #39 — freezing a public scenario contract is deferred until the schema settles, and publishing the generated shape here does not freeze it.

## tbpp — packs

A pack file is a `GamePackDef` (`src/lib/packs/types.ts`) plus the discriminator:

```json
{
	"$schema": "https://table.place/pack.schema.json",
	"tbpp": 1,
	"specVersion": "1.0.0",
	"id": "my-proto",
	"name": "My Prototype",
	"scope": "player",
	"decks": [
		{
			"slot": "main",
			"name": "Draw Pile",
			"back": "https://example.com/cards/back.png",
			"cards": [
				{ "code": "strike", "name": "Strike", "face": "https://example.com/cards/strike.png" },
				{ "code": "guard", "name": "Guard", "face": "https://example.com/cards/guard.png" }
			]
		}
	]
}
```

Field notes:

- **`id`** — stable identity for the pack (`standard-52`, `imported:<slug>`…).
- **`scope`** — `'table'` (the shared game: board, communal decks; loaded once per lobby by the host) or `'player'` (what one player brings, spawned per seat — a deck-builder export is a player pack). See SPEC.md §4d.
- **`decks[].slot`** — stable id within the pack; **`cards[].code`** — stable id within the deck, and **unique within it**: spawning builds table entity ids as `card:<owner>:<slot>-<code>`, so two cards sharing a code collapse into one entity. /create allocates every code through `allocateCode` (`src/routes/create/bulk-sheet.ts`) — a taken `AS` becomes `AS-2`, then `AS-3`. Both survive re-exports, so external tools can reference cards as `<pack>/<slot>/<code>`.
- **`cards[].orientation`** (optional) — `'portrait'` (default) or `'landscape'`. A landscape card (e.g. a Sorcery TCG site) rests turned 90° everywhere it renders — board, hand tray, hold-space preview — while its synced rotation stays orientation-relative, so tapping it stands it upright and tapping again lays it back down. The face image itself stays portrait; the renderers turn the card, not the art. This is the tbpp analog of TTS's `SidewaysCard`, and the importer maps that flag onto this field.
- **`pieces`** (optional) — tokens, pawns, counters, dice, bags, and models: `{ kind: 'token'|'pawn'|'counter'|'die'|'bag'|'model', name, color?, imageUrl?, model?, states?, state?, radius?, maxValue?, sides?, contents?, drawMode?, infinite?, snap?, reach?, position: [x, z], rotation? }`. See [Multi-state pieces](#multi-state-pieces) for `states` and [Bags](#bags--a-hidden-blind-draw-pool) for a container's fields. `sides` is dice-only and must be one of 4, 6, 8, 10, 12, 20 — the shapes the primitive library builds; a die's `radius` is its circumradius, and its numbers are drawn procedurally, so a die references no image and is never a multi-state piece. `model` is model-only: a `model:<kit>/<name>` catalog ref (see [Face refs](#face-refs)). `rotation` (optional, default 0) is the piece's table yaw in **degrees** — it maps onto the piece DTO's `rotation[1]` slot, and matters most for model sections, which are the first kind to render it. `snap` (default `true`) is the per-piece snap opt-out: `false` makes the piece drop as if Alt were held, so it ignores snap points and grids — a big room section should snap to the grid, a loose prop shouldn't. `reach` (optional, a whole number ≥ 0) is how many snap-point links the piece usually travels — see [links and reach](#links-tags-and-reach--an-optional-board-graph); advisory only.
- **`overlays`** (optional) — board/map images: `{ imageUrl, ratio, scale }` (`ratio` = width/height).
- **`source`** (optional) — provenance stamp written by converters (currently only `"tts"`). Native packs omit it.

### Multi-state pieces

A piece can carry several faces and be flipped between them in play — a double-sided tile, an upgrade token, a damaged/undamaged marker. This is the analog of Tabletop Simulator's `States`.

```json
{
	"kind": "token",
	"name": "Brazier",
	"imageUrl": "https://example.com/img/brazier-lit.png",
	"states": [
		{ "face": "https://example.com/img/brazier-lit.png", "name": "Lit" },
		{ "face": "https://example.com/img/brazier-embers.png", "name": "Embers" },
		{ "face": "https://example.com/img/brazier-out.png", "name": "Out" }
	],
	"position": [0, 0]
}
```

**`states[0]` is the base face.** The array is the piece's _complete_ ordered set of faces, not extra ones bolted onto `imageUrl`: a piece with `states` renders `states[n].face`, and starts at `n = 0` unless a scenario placement's `state` says otherwise. `imageUrl` is then a fallback for consumers that ignore states, and every exporter here writes it equal to `states[0].face` — a reader that only knows `imageUrl` still shows the right image.

`face` is a face ref like any other (the three image schemes below all work, and may be mixed within one piece — `model:` is geometry, not an image, and never goes in a state); `name` is optional and labels the state on hover. Only `token` and `counter` pieces render an image today, so states on a `pawn` change its label but not its shape.

A piece may also carry **`state`** — the index it _spawns_ showing, when that isn't the base face (a TTS import puts the state the mod was saved in here). A scenario placement's `state` overrides it.

In play, `X` over a hovered piece shows the next state (`Shift+X` the previous); right-click or press-and-hold opens the piece's radial menu, where _Next state_ and _Previous state_ are wedges printed with those keys. The current index lives on the piece in game state (`PieceDTO.state`), so it syncs to every client like any other mutation and survives a scenario save/load.

### Bags — a hidden, blind-draw pool

A piece of `kind: 'bag'` is a container: a pouch on the table holding a pool nobody can look into. Clicking it (or its radial menu's _Draw_ wedge, or "Draw one" in the Pieces pane) pulls **one** item out and drops it beside the bag; dragging a card or a piece onto the bag puts it back. It is the tbpp analog of TTS's `Bag` / `Infinite_Bag`.

```json
{
	"kind": "bag",
	"name": "Tile Bag",
	"color": "#7c2d12",
	"drawMode": "random",
	"infinite": false,
	"position": [-9, 4],
	"contents": [
		{ "kind": "token", "name": "Ember", "color": "#f97316" },
		{ "kind": "counter", "name": "Wound Dial", "maxValue": 5 },
		{ "kind": "card", "code": "omen", "name": "Omen", "face": "https://example.com/omen.png" }
	]
}
```

- **`contents`** — what the bag holds, in insertion order. Each entry is either a **piece item** (`kind` `'token' | 'pawn' | 'counter'` plus `name`, `color?`, `imageUrl?`, `radius?`, `maxValue?` — a piece def with no `position`, because the draw decides where it lands) or a **card item** (`kind: 'card'` plus `code`, `name?`, `face`, `back?`, `orientation?`, using the face-ref grammar below). `code` is the per-bag stable id, and must be **unique within the bag** for the same reason a deck's card codes must be: the drawn card's entity id is `card:<owner>:<bag>-<code>`.
- **`drawMode`** — `'random'` (default; a blind draw), `'lifo'` (the last item in comes out first — a stack), or `'fifo'` (a queue). Matches TTS's container Order.
- **`infinite`** — `true` makes a draw **clone** the item instead of removing it, so the bag never empties (TTS `Infinite_Bag`). Its badge shows `∞` instead of a count.
- Bags cannot contain bags. Containers do not nest in tbpp, and the TTS importer leaves a nested container in `skipped[]` rather than flattening it — deep `ContainedObjects` recursion belongs with the importer envelope work, not here.

What "hidden" means precisely: **no UI renders a bag's contents** — the only thing on screen is the remaining count (or `∞`). The contents do live in shared game state, because a draw has to resolve once and be agreed on by every client: the drawing client picks the item, then broadcasts the _result_ (the spawned entity plus the bag's new contents) as a single patch, exactly the way a deck shuffle broadcasts its result rather than a seed. So a determined player with devtools can read a bag the same way they could read a TTS save file; hiding is a property of the interface, not a secrecy guarantee.

A drawn **card** arrives facedown — the contents were hidden, so the draw doesn't reveal them; `F` turns it over. A drawn **piece** arrives as an ordinary piece of its kind (a counter arrives full).

In a scenario, a bag is an ordinary `piece` placement: position and rotation round-trip, and the contents come back from the pack. There is no `order`-style field for a bag's remaining contents — a bag is a shuffled hidden pool by definition, and inlining its contents into a scenario would both restate the pack and publish what the format calls hidden. Draw during play, not while authoring a scenario.

### Face refs

Card `face`/`back` (and piece/overlay `imageUrl`) are **refs** — tiny strings resolved to textures only at render time, so files and synced game state never carry image data. The schema can only type them as `string`, so this is the normative grammar. Exactly four schemes exist, dispatched on prefix: the three image schemes are implemented by `resolveCardImage` in `src/lib/packs/resolve.svelte.ts`, and the `model:` scheme by `resolveModelRef` in `src/lib/models/catalog.ts`.

**`gen:std52/<code>`** — procedurally generated on a canvas, zero image assets. `std52` is the only generator that exists; an unknown `gen:` namespace falls through to the literal-URL case and renders broken. `<code>` is either the literal `back` or a card code of **rank + suit with no separator**, suit last: suits `S`/`H`/`D`/`C`, ranks `A`, `2`–`10`, `J`, `Q`, `K` (`gen:std52/AS`, `gen:std52/10D`). This is what the built-in standard-52 pack uses.

**`sheet:<json>`** — one cell of a sprite sheet, fetched once and sliced client-side. The literal prefix `sheet:` is followed immediately by a JSON object (a JSON payload nested inside a JSON string, so it is escaped in the file). Built by `makeSheetRef`; the payload is `SheetRefPayload`:

| Field   | Type    | Required | Meaning                                                                      |
| ------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `url`   | string  | yes      | the sprite sheet image                                                       |
| `cols`  | number  | yes      | columns in the sheet                                                         |
| `rows`  | number  | yes      | rows in the sheet                                                            |
| `index` | number  | yes      | 0-based cell index, row-major                                                |
| `name`  | string  | no       | card name, drawn as a text placeholder if the sheet cannot be fetched        |
| `back`  | boolean | no       | if true, fall back to the generated card back instead of a named placeholder |

Resolution is asynchronous and failure is non-fatal — an unreachable sheet falls back to a placeholder rather than breaking the table. Mostly produced by the TTS importer; prefer plain URLs when authoring by hand.

Two producers in this repo emit these, and both follow the table above: the TTS importer, and /create's "Bulk add from sheet" pane, which enumerates a whole `cols × rows` grid into one card per cell (`src/routes/create/bulk-sheet.ts`). Excluding a cell in that pane simply omits its card — `cols`/`rows` stay the sheet's real dimensions and the remaining `index` values keep their absolute positions, because an index is only meaningful against the grid it was cut from. A 1×1 grid is not written as a `sheet:` ref at all; it degrades to the plain-URL case below.

**`https://…`** — a plain image URL, creator-hosted (imgur, GitHub raw, your own site), used verbatim. table.place hosts no card/token art of its own, so it must be publicly reachable, CORS-readable and hotlinkable. Any ref matching none of the prefixes here is treated as a literal URL.

**`model:<kit>/<name>`** — a curated 3D model from the first-party catalog (tableplace-135), e.g. `model:kenney-cave/room-large`. Goes in a `kind: 'model'` piece's **`model`** field, never in `face`/`back`/`imageUrl`. Resolved through the static manifest at `/models/catalog.json` (kit → base URL, scale, license/credit, per-model footprint and thumbnail), which is also where the models themselves are hosted — a deliberate carve-out from the "no first-party assets" rule above, safe because everything in the catalog is CC0 and repackaged by `scripts/ingest-model-kit.ts`. There is no arbitrary-URL form; an unknown or malformed ref renders as a placeholder box. Catalog footprints are measured in cells of **2.0 world units**, matching the default snap-grid pitch.

The built-in `STANDARD_52` pack (`src/lib/packs/standard52.ts`) is the canonical example: 52 cards, all `gen:` faces, serialized it is a valid tbpp file.

### TTS is an import boundary, not part of the spec

`ttsToPack` (`src/lib/tts/to-pack.ts`) converts a parsed Tabletop Simulator Saved Object into a `GamePackDef`: TTS decks become pack decks, sprite-sheet cells become `sheet:` refs (whole images become plain URLs), loose cards group into a face-up `Loose Cards` pile, tiles/pawns/health-dials become pieces, `Bag`/`Infinite_Bag` become bags, and the result is stamped `source: "tts"`. A card's `SidewaysCard` flag (per card, falling back to the deck-level flag) becomes `orientation: "landscape"`.

A container's children are mapped **one level deep**: cards become card items, a deck inside the bag flattens into its cards, and tiles/pawns/dials become piece items. Anything else — a nested container above all — is named in `skipped[]`; the bag itself still imports, because an empty bag is still the object the author placed. Draw order comes from TTS's `Bag.Order` (observed encoding: 0 random, 1 LIFO, 2 FIFO), and an unrecognised value falls back to `'random'` rather than failing the import. "Backwards compatible with TTS" means the importer accepts TTS JSON and every TTS concept maps into pack primitives — TTS mechanics (CardID math, `CustomDeck` sheets, Lua scripts) never appear in tbpp itself.

**`States`** map onto the `states` above. A TTS save keeps the _active_ state as the object itself and stores only the others in the `States` dict, keyed by 1-based state number — so the current state is **the number missing from the `1..N` sequence** (there is no `CurrentState` field to read). `statesOrder` in `src/lib/tts/parse.ts` implements exactly that, and the recovered index becomes the piece's starting state. Only image-bearing states (`Custom_Tile`, `Card`/`CardCustom`, anything with a `CustomImage`) become faces; a state of another object class has no image to show, so it degrades to a `skipped[]` note and is left out — never fatal. States nested inside states, and `ContainedObjects` within a state, are not followed.

## tbps — scenarios

A scenario file is a saved table arrangement (`src/lib/scenario/file.ts`) plus the discriminator. A pack says what content _is_; a scenario says _where it goes_:

```json
{
	"$schema": "https://table.place/scenario.schema.json",
	"tbps": 2,
	"specVersion": "0.1.0",
	"name": "duel",
	"createdAt": 1700000000000,
	"packs": [{ "id": "standard-52", "source": "builtin" }],
	"placements": [
		{
			"kind": "deck",
			"pack": "standard-52",
			"content": "main",
			"seat": 0,
			"position": [8.5, 0.4, 4.5],
			"isFaceUp": false,
			"order": ["7H", "AS", "2C", "KD", "10S"]
		}
	],
	"state": {
		"pieces": { "piece:seat0:hp-0": { "kind": "counter", "name": "HP", "value": 20 } }
	}
}
```

Scenarios are **seat-relative**: entities belong to placeholder players `seat0`–`seat3` (entity ids are `kind:owner:slug`), and when a real player claims a seat every id containing that placeholder is renamed to the claimer. Only placeholder players are exported — real players never leak into a scenario file.

### packs + placements (v2)

- **`packs`** — every pack the scenario draws from: `{ id, source? }`. `source` is `"builtin"` (shipped with the app, e.g. `standard-52`), `"local"` (this browser's pack library — see below) or a URL a `.tbpp.json` can be fetched from. That's enough to re-resolve the content, so the cards themselves are never copied into the scenario.
- **`placements`** — one entry per spawned thing: `{ kind, pack, content, seat?, position?, rotation?, … }`.
  - **`kind`** — `'deck' | 'piece' | 'overlay'`.
  - **`content`** — the deck's `slot`, or the index into the pack's `pieces`/`overlays`. With `packs[].id` this is the `<pack>/<slot>` addressing from the pack section.
  - **`seat`** — which placeholder owns the result (`0`–`3`). Omitted for table-scoped overlays.
  - **`order`** (decks) — the authored card sequence as pack card `code`s. **A scenario preserves card order by default**: an encounter deck, a rigged opening, a tutorial setup all reload exactly as saved. It is a list of ids, never card bodies, so referencing the pack stays the point.
  - **`shuffleOnLoad`** (decks, default `false`) — reshuffle on load instead of restoring `order`. It is **per placement**, so one scenario can hold a fixed stacked encounter deck _and_ a shuffled draw deck side by side.
  - **`state`** (pieces) — which of the pack piece's `states` it starts on (index, default `0`). Not to be confused with the scenario's top-level `state` snapshot: this one is a single piece's face.
  - **`isFaceUp`** (decks), **`value`** (counter pieces), **`scale`** (overlays) — arrangement details that override the pack's defaults.
- **`state`** — a `Partial<GameDTO>` snapshot (`src/lib/store/game/types.ts`) for everything _not_ pack-derived: ad-hoc pieces, hand-placed cards, TTS-imported decks. It is applied on top of the spawned placements, so it can also override them.

### snapPoints — placement guides

`snapPoints` (optional, any version) is a flat array of authored spots on the felt that dropped cards and pieces gravitate to — TTS's core placement primitive, and what turns an imported pile of floating objects into a playable board.

```json
"snapPoints": [
	{ "position": [0, 2.5], "rotation": 0, "radius": 1 },
	{ "position": [-4, 0], "y": 2 },
	{ "position": [6, 0], "kind": "grid", "pitch": 2, "cols": 4, "rows": 3 }
]
```

- **`position`** — table-space `[x, z]`. Two elements — elevation is the separate optional `y`, so the tuple every 0.1.x reader asserts stays two long.
- **`y`** (optional) — elevation: the local floor whatever lands here rests on. The rest height is computed exactly as on the felt with `y` substituted for the table top, so a card dropped on a card on an elevated point still stacks. Omitted means the felt.
- **`rotation`** (optional) — the yaw a caught drop turns to, in **degrees**. Placements use radians; this uses degrees, because it is a single table yaw that maps 1:1 onto the card DTO's tap rotation (`actions/card.ts`) and onto TTS's `SnapPoints`. Omitted means "position only — leave the facing alone". On a grid this is the lattice's yaw instead.
- **`radius`** (optional) — catch radius in world units, defaulting to `SNAP_RADIUS_DEFAULT` (`utils/constants-snap.ts`). Nearest point wins where radii overlap.
- **`kind`** (optional) — `'grid'` turns the entry into a lattice of square cells; absent (or `'point'`) is the discrete spot it always was. A drop anywhere over the grid's extent pulls to the nearest **cell centre**; grid cells and discrete points compete on distance, and an authored discrete point beats a generated cell on an exact tie (authored intent over generated lattice). The extent is deliberately not clamped the way a point's radius is — a grid covers area on purpose.
  - **`pitch`** — cell size in world units (required on grids).
  - **`cols`**, **`rows`** — extent in cells (required); `position` is the grid's centre.
  - **`yawStep`** (optional) — degrees; a snapped entity's yaw rounds to the nearest multiple, measured from the grid's own `rotation`. Default 90 — the modular-kit case.

Snap points are **table-scoped and not seat-relative** — unlike a pack piece's `[x, z]` they are never mirrored, so both ends of a board are authored explicitly. In the store they live in `GameDTO.snapPoints` keyed `snap:<n>`; the file drops those ids and reassigns them on load by array index, which is why the field is an array rather than a record. The only thing that references a point is another point's `links`, so an export renumbers links to the exported order and drops any whose target is gone.

#### Links, tags and reach — an optional board graph

- **`links`** (optional) — ids of connected snap points, `snap:<index in the array>`. Undirected: written on either end, a link joins both. Missing targets are ignored.
- **`tags`** (optional) — free-form string labels a scenario can group points by. The table reads none of them.
- **`reach`** (optional, on pieces — packs and `state.pieces`) — how many links the piece usually travels.

Lift a piece with `reach` off a linked point (the point whose catch radius holds its pre-lift position) and `liftReachSet` (`drop/snap-reach.ts`) walks the link graph breadth-first: the points within `reach` links, the origin included, draw brighter from their own instanced mesh and every other ring fades back. A point with a card, deck or other piece already in its catch radius is left out of the bright set but stays passable. **Advisory only** — none of it feeds `resolveDrop`, so every point still catches exactly as before. No links, or no `reach`, means no bright set: the guides draw as they always did.

In /setup, arm **draw links** in the Snap points folder: click a marker to pick it, click another to draw (or remove) the link between them — the pick carries on, so a path is a run of clicks. Each point's tab lists its links and edits its tags; **Piece reach** sets a piece's reach. /create authors a pack piece's reach.

**How it lands, and why there is no new sync machinery.** `resolveSnap` (`utils/transforms/snap.ts`) is a pure nearest-point-within-radius search; `resolveDrop` calls it and returns `kind: 'snap'`, and the commit writes that final position — plus the rotation, but only when a point authored one — through the same move path as any other drop. The relay carries that one patch, so both clients end on the identical transform. Resolution order is tray → hovered deck → Alt's opt-out → snap point → loose-pile square-up: aimed-at targets beat authored intent, and authored intent beats where cards happen to have drifted.

**Visibility.** Markers are drawn only in /setup (`TableFeatures.snapEditing`). In /play the board stays clean at rest, and the points appear only while something that snaps is lifted: every point shows a ring, a grid shows its cells near the pointer (never the whole lattice), the point that will catch the drop is filled, and any overlay with a snap point on it dims slightly. It all fades in and out over about 150 ms, and is hidden while `Alt` (no snap) is held and for a piece authored `snap: false`. The drop preview still jumps onto the catching point in its own colour, already turned to the authored yaw. This is local rendering only; nothing about it is synced.

Authoring lives in the /setup pane's **Snap points** folder plus direct manipulation in the scene: arm "place on click" and click the felt, drag a marker to move it, right-click to delete. `gameActions.addSnapPoint` / `moveSnapPoint` / `updateSnapPoint` / `removeSnapPoint` (`store/game/actions/snap.ts`) are ordinary surgical patches, `null` to delete, exactly like a piece's.

TTS save-level `SnapPoints` import is deliberately _not_ wired up here (issue #96 scope); the shape is kept close to TTS's position-plus-rotation so that mapping stays mechanical when the importer envelope work lands.

Export decides per entity: content carrying pack provenance (a `packOrigin` stamp, written by `spawnPack`) becomes a pack ref + placement; everything else falls back to the raw snapshot. A table with no pack content at all still exports as **v1**.

### The local pack library

`source: "local"` resolves against the **pack library**: every pack this browser knows about, kept in localStorage (`packs:v1`, `src/lib/packs/library.ts`). A pack joins it by being opened from a file (at `/setup`, `/create`, `/play`, or by dropping a `.tbpp.json` on the table) or by being saved from the `/create` editor. Once it is there, `/setup` and `/play` spawn it from a list — no re-picking the file per seat or per session — and `spawnPack` stamps `source: "local"` onto the content it puts down, which is what makes a scenario built from it reload later.

It exists because table.place hosts nothing (see `CONTENT_CREATION.md`): without it, the only packs able to survive a scenario save/load are the two builtins and packs you have published at a public URL, which leaves _your own_ packs as the case that doesn't work.

The library is **device-local and not shareable**. A scenario referencing `source: "local"` opened on another machine — or in another browser — fails loudly, naming the pack id it could not find, and its placements are skipped rather than silently dropped. Sharing content is still the pack file: export the `.tbpp.json` and send it, and the recipient's own library takes it on the first open. A scenario meant to travel on its own should use a URL `source` instead.

### Versions

| Version | Shape                                                | Written by                     |
| ------- | ---------------------------------------------------- | ------------------------------ |
| **v2**  | `packs` + `placements` (+ `state` for the remainder) | tables containing pack content |
| **v1**  | self-contained `state` snapshot, cards inlined       | hand-placed / TTS-only tables  |
| **v0**  | legacy `scenario-<name>.json`, no `tbps` field       | historical exports             |

All three load. `parseScenarioFile` accepts v0 (`name` + `state` is enough) and v1 unchanged, so existing files keep working; new exports always write the discriminator and the `.tbps.json` name. Loading v1/v0 applies the snapshot exactly as before — only v2 resolves packs first.

Sizing analysis for public/remote scenario seeding lives in issue #39: pack refs are what make a fetchable scenario small enough to be practical.

### Composing a table without a browser

`composeScenario(scenario, packs)` (`src/lib/compose/scenario.ts`) turns a scenario plus its already-resolved packs into the `GameDTO` fragment — decks, cards, pieces, overlays, seat placeholders, snap points — that a client would have produced. It imports no Svelte, no store and nothing from the DOM, so it runs anywhere JavaScript does.

That matters because it is the **only** implementation of the layout rules. Entity ids (`kind:owner:slug`), the `seat0`…`seat3` placeholder owners, `packOrigin` stamps, mirrored positions for the far seat, and the "authored order unless `shuffleOnLoad`" convention are decided once, here. `applyScenario` is a thin wrapper over it: resolve packs → compose → push to the store, still one message per deck so a full card list stays under the server's 1 MB websocket read limit. Anything outside the browser calls the same function rather than reimplementing the grammar and drifting from it.

Pack **resolution** stays outside on purpose — fetching a `.tbpp.json` is I/O, and keeping it out is what makes the composer testable and portable. The browser resolves with `scenario/resolve-packs.ts`; a script resolves off disk.

`bun run seed-lobby` (`scripts/seed-lobby.ts`) is that path, end to end, from a terminal:

```
bun run seed-lobby --lobby brave-otter --server localhost:8080 --scenario duel.tbps.json
```

It resolves packs (builtin registry, URL fetch, a path relative to the scenario, or `--pack file.tbpp.json` standing in for the browser's local library), composes, opens a websocket as a throwaway player, sends the same patches — clear first, then one per deck, paced under the server's 7 msg/s limit — and disconnects. Players then only claim a seat: `/play?lobby=brave-otter&seat=0`.

The seeder is an ordinary client, so its disconnect is a normal empty transition and the lobby's 15-minute idle TTL applies as usual; a seeded lobby nobody opens is collected, and a server restart drops it (in-memory state). Both are issue #39's to answer, not the seeder's.

## Versioning

The discriminator value is the format version. Breaking changes bump it (`"tbpp": 2`); parsers reject versions they don't know rather than misread them. This matches the `{tableplace: 1}` pattern from the raw-link-loading research.

### Spec versioning

Alongside the discriminator, every emitted document carries **`specVersion`** — the semver of the spec revision it was authored against (`src/lib/formats/spec-version.ts`). The two answer different questions: the discriminator says _which format and container shape_ this is, `specVersion` says _which revision of the rules_ produced it, finely enough to tell an additive change from a breaking one.

Schema-side metadata is not a substitute. A schema can say what the current spec is; only the document can say what it was written against, and it is the documents that escape into the wild.

`specVersion` is **optional on read** — files exported before it existed still validate and still import — and **always written on export**. `parsePackFile` / `parseScenarioFile` judge readability from the document's declared version:

| Declared                       | Result                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| absent                         | accepted — predates spec versioning                           |
| older                          | accepted; keeping old files readable is the point             |
| newer, same breaking component | accepted — additive by convention, unknown fields are ignored |
| newer breaking component       | rejected, with a message naming the tag that schema lives at  |

The breaking component is the major, except under `0.x` where semver makes the minor breaking — which is why the scenario spec sits at `0.x`.

### Schema provenance

Both generated schemas carry three annotation keywords:

- `x-tableplace-spec-version` — the semver above.
- `x-generated-at` — ISO timestamp of generation.
- `x-tableplace-source-sha` — **the commit the schema was generated _from_**, not the commit that contains it. A file cannot contain the hash of the commit that introduces it, so this is necessarily an ancestor — normally the parent of the commit that ships the file. Read it as "generated from the tree at". A `-dirty` suffix means the tree had uncommitted changes at generation time.

`x-generated-at` and `x-tableplace-source-sha` are **excluded** from CI's comparison (`scripts/check-schemas.ts`): the timestamp changes on every run and the sha always differs between the committed value and a CI regeneration, so comparing either would make the check fail constantly and train everyone to ignore it.

Note for consumers: ajv's strict mode rejects unknown keywords, so validating these schemas needs `new Ajv({ strict: false })` or an `addVocabulary` call. Most validators ignore unknown keywords as the spec intends.

### Release convention

On a version bump the schema is tagged **`spec/pack/vX.Y.Z`** / **`spec/scenario/vX.Y.Z`**, so an older schema stays fetchable at its tag after `static/` moves on.

- **Major** — a breaking change: a field removed, renamed, or made required (a required-tightening rejects documents that were previously valid).
- **Minor** — an additive change: a new optional field.

Under `0.x` the components shift down with the breaking one: the scenario spec bumps its **minor** for a breaking change and its **patch** for an additive one.

CI enforces the bump: `bun run schemas:check --base <ref>` fails if a schema's content changed against the base branch without `x-tableplace-spec-version` changing.

## Known gaps

Open questions the format deliberately does **not** answer yet. They are listed rather than silently decided, because guessing here would bake a policy into a published contract (tableplace-78, CONTENT_CREATION.md). A file that invents syntax for any of them fails validation.

- **Card multiplicity.** `PackCardDef` has no `count`. Three copies of a card means three entries with distinct `code`s (`strike-1`, `strike-2`, …), because `code` is the per-deck identity that scenario `order` arrays reference. Whether multiplicity becomes a first-class field — and what it would do to `order` — is undecided.
- **Pack content versioning.** `tbpp` versions the _format_, not the pack. A pack cannot declare "Ember Duel v1.2", and there is no upgrade story for a pack whose cards changed underneath a scenario that references it by URL.
- **Nested containers.** A bag's `contents` is one level deep — no bag inside a bag, and no way to say what is left in a partly-drawn bag when a scenario saves it. Deep `ContainedObjects` recursion on import is tracked with the importer envelope work, not here.
- **`id` collision policy across authors.** Pack `id` is a bare string with no namespacing, registry, or ownership check. Two authors can both ship `ember-duel`, and `resolve-packs.ts` only warns when a fetched pack's `id` disagrees with the ref. Until this is decided, the practical advice is a distinctive `id` plus a `source` URL you control.

- **Snapping beyond square grids.** Square grids (`kind: 'grid'`), elevation (`y`) and the per-piece `snap` opt-out landed with tableplace-134, but hex grids and hidden/layout/randomize zones still have no syntax, and a snap point cannot restrict what is allowed to land on it. Pack-level snap sets (a snap layout that travels with an overlay, rather than with the scenario) are also unresolved — that would pull the pack schema and /create in under the parity rule, so it is deliberately left to a follow-up.

`GamePackDef` also does not carry a board/table definition (SPEC §4d mentions one); overlays are the closest thing today.
