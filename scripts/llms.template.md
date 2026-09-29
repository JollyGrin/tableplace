# table.place — authoring packs and scenarios

> **table.place** is a free digital tabletop that runs in the browser: play card games and board games online with other people — no install, no download, print-and-play friendly. Content reaches the table in two steps: create it as a **pack** (the cards, pieces and boards — what exists), arrange it as a **scenario** (what goes where at the start), then play it in a lobby. The rest of this document is the complete authoring spec for those two file formats.

If you are looking for something other than the file formats:

- **Play a specific game** — `https://demo.table.place/` hosts per-game landing pages with playable demos, and `https://demo.table.place/llms.txt` is the agent-facing list of the games available there. If you were asked "where can I play _X_ online", start with that list.
- **Create a lobby programmatically** — `https://api.table.place/llms.txt` documents the HTTP API for spinning up lobbies.

GENERATED FILE — do not edit by hand. Built from the TypeScript types by `bun run schemas`; the schemas, constants and examples below are extracted from the running code, and CI fails if this file is stale.

This document is self-contained. If you are an LLM with no access to the table.place repository, everything you need to emit a valid file is here: both JSON Schemas, the face-ref grammar the schemas cannot express, the world-coordinate constants, and a worked example of each format.

Canonical URLs:

- this document — `https://table.place/llms.txt`
- pack schema — `{{PACK_SCHEMA_URL}}`
- scenario schema — `{{SCENARIO_SCHEMA_URL}}`

## 1. The two formats

table.place is a 3D tabletop in the browser. It reads two plain-JSON file formats:

| Format                              | Filename           | What it is                                                                         |
| ----------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **tbpp** — table.place **pack**     | `<name>.tbpp.json` | A content library: decks of cards, pieces, board overlays. What _exists_.          |
| **tbps** — table.place **scenario** | `<name>.tbps.json` | An arrangement: what goes where, which seat owns it, starting values. The _setup_. |

A pack says what the content **is**. A scenario says **where it goes**. If you are describing a game's cards, write a pack. If you are describing a starting position for a game whose cards already exist, write a scenario.

"Deck" means one pile of cards _inside_ a pack — a pack can hold several (draw pile, discard, tokens-as-cards).

Every file carries an in-band discriminator at the top level: `"tbpp": {{TBPP_VERSION}}` or `"tbps": {{TBPS_VERSION}}`. The _content_ identifies the format, not the filename, because files get renamed and piped. Parsers reject a file with no marker, and reject versions they do not know rather than misreading them.

## 2. Stability

**The pack format (tbpp) is a stated contract.** Write against it. Decks, pieces and overlays are all implemented and round-tripped in CI.

**The scenario format (tbps) is UNSTABLE.** Its schema is generated from live internal types that are still changing, and it is published so you can see the current shape — not as a promise. There is no compatibility guarantee and no deprecation policy for tbps. It may change without notice. Generate scenarios against the schema you fetch at the time you generate them, and expect to regenerate. Packs are the stable thing to build on.

### 2.1 Spec versions

Current: **pack `{{PACK_SPEC_VERSION}}`**, **scenario `{{SCENARIO_SPEC_VERSION}}`**. The scenario spec is `0.x` on purpose — under semver, `0.x` may break on every minor, which is precisely the promise being made.

Two version fields exist and they answer different questions:

- **`tbpp` / `tbps`** — the in-band discriminator. Identifies _which format_ a file is, and gates the container shape.
- **`specVersion`** — semver of the spec revision the document was authored against.

Write **both**. Set `specVersion` to the version above that you generated against.

The importer decides from the **document's** declared `specVersion`, not from its own:

| Declared                       | Result                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| absent                         | accepted — the file predates spec versioning                      |
| older                          | accepted; keeping old files readable is the point                 |
| newer, same breaking component | accepted — those changes are additive, unknown fields are ignored |
| newer breaking component       | **rejected**, naming the tag its schema lives at                  |

The "breaking component" is the major, except for `0.x` where it is the minor.

### 2.2 Schema provenance and release tags

Each schema carries three annotation keywords:

- `x-tableplace-spec-version` — the semver above.
- `x-generated-at` — ISO timestamp of generation.
- `x-tableplace-source-sha` — **the commit the schema was generated _from_.** It is not the commit that contains the schema, and cannot be: a file cannot contain the hash of the commit that introduces it. Read it as "generated from the tree at this commit" — normally the parent of the commit that ships the file. A `-dirty` suffix means the tree had uncommitted changes.

On a version bump the schema is tagged `spec/pack/vX.Y.Z` / `spec/scenario/vX.Y.Z`, so an older schema stays fetchable at its tag. **Breaking** (a field removed, renamed, or made required) bumps the major; **additive** (a new optional field) bumps the minor.

> **Validating with ajv:** these `x-` keywords are annotations, and ajv's strict mode rejects keywords it does not know. Use `new Ajv({ strict: false })`, or register them with `ajv.addVocabulary(['x-tableplace-spec-version', 'x-generated-at', 'x-tableplace-source-sha'])`. Most other validators ignore unknown keywords as the JSON Schema spec intends.

## 3. Hard rules

1. Emit **JSON only**. No comments, no trailing commas.
2. Include the discriminator (`"tbpp": {{TBPP_VERSION}}` / `"tbps": {{TBPS_VERSION}}`). A file without it is rejected.
3. Include `specVersion` (§2.1) and the `$schema` line. The `$schema` line costs nothing and gives editors inline validation.
4. **Never inline image data.** Faces are short ref strings (§5); base64 or data-URLs in a file will be carried into synced multiplayer state and break it.
5. table.place hosts **no assets**. Every `https://` ref points at hosting you control, and must be CORS-readable and hotlinkable.
6. `code` (within a deck, or within a bag's `contents`) and `slot` (within a pack) are stable ids. Keep them stable across re-exports — scenarios reference cards by them.
7. Coordinates are **world units**, not pixels or grid cells (§4).

## 4. The coordinate system

Right-handed 3D. The table is a **60 × 30** felt rectangle centred on the origin: **x** is the long axis, **z** is the short axis, **y** is up. A position is always `[x, y, z]`.

Seats sit around the short ends. Seats **0 and 2** are on the `+z` side facing `-z` (rotation `[0, 0, 0]`); seats **1 and 3** are on the `-z` side facing `+z` (rotation `[0, 3.141592653589793, 0]`, i.e. π radians about y). Rotations are radians.

{{CONSTANTS_TABLE}}

Practical defaults, matching what the app itself spawns:

- A deck for seat 0: `[8.5, 0.4, 4.5]` with rotation `[0, 0, 0]`.
- The same deck for seat 1: `[8.5, 0.4, -4.7]` with rotation `[0, 3.141592653589793, 0]`.
- Additional decks for the same seat step **+2.5 in x** each.
- A single card lying on the table: y = `0.26`. A piece: y = `0.335`. An overlay: y = `0.255`.

Inside a **pack**, a piece's `position` is the two-element `[x, z]` pair (no y — pieces rest on the felt). It is authored from **seat 0's** point of view; when the pack spawns for a seat on the far side, both components are negated automatically. Inside a **scenario**, `position` is the full `[x, y, z]`.

## 5. Face refs — the part no schema can express

`face` and `back` on cards, and `imageUrl` on pieces and overlays, are **refs**: short strings resolved to real textures only at render time, so files and network state never carry image bytes. The schema types them as `string`. This section is the normative grammar. Exactly four schemes exist:

### 5.1 `https://…` — a plain image URL

```
https://example.com/img/strike.png
```

Used verbatim as an image source. Must be publicly reachable, CORS-readable, and hotlinkable. This is the scheme you want for hand-authored packs. Any ref matching neither prefix below is treated as a literal URL.

### 5.2 `gen:` — procedurally generated, no assets

```
gen:std52/<code>
```

Drawn on a canvas in the browser. **`std52` is the only generator that exists today.** Do not invent other `gen:` namespaces — an unknown one is passed through as a literal URL and renders as a broken image.

`<code>` is either the literal `back` (the standard card back) or a card code formed as **rank + suit with no separator**, where the suit is the final character:

- suits — `S` spades, `H` hearts, `D` diamonds, `C` clubs
- ranks — `A`, `2`–`10`, `J`, `Q`, `K`

So: `gen:std52/AS` (ace of spades), `gen:std52/10D` (ten of diamonds), `gen:std52/back`. This is what the builtin `standard-52` pack uses, which is why it ships with zero image assets.

### 5.3 `sheet:` — one cell of a sprite sheet

```
sheet:{"url":"https://example.com/sheet.png","cols":10,"rows":7,"index":13,"name":"Strike","back":false}
```

The literal prefix `sheet:` followed **immediately** by a JSON object — a JSON payload embedded inside a JSON string, so it must be escaped when written into a file. The image is fetched once and sliced client-side.

| Field   | Type    | Required | Meaning                                                                      |
| ------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `url`   | string  | yes      | the sprite sheet image                                                       |
| `cols`  | number  | yes      | columns in the sheet                                                         |
| `rows`  | number  | yes      | rows in the sheet                                                            |
| `index` | number  | yes      | 0-based cell index, **row-major** (left to right, then top to bottom)        |
| `name`  | string  | no       | card name; drawn as a text placeholder if the sheet cannot be fetched        |
| `back`  | boolean | no       | if true, fall back to the generated card back instead of a named placeholder |

Resolution is asynchronous and failure is non-fatal: an unreachable sheet falls back to a generated placeholder rather than breaking the table. `sheet:` refs are produced mainly by the Tabletop Simulator importer. **Prefer `https://` refs when authoring by hand** — one URL per card is far easier to get right than sheet arithmetic.

### 5.4 `model:` — a curated 3D model, `kind: "model"` pieces only

```
model:kenney-cave/room-large
```

The literal prefix `model:` followed by `<kit>/<name>`, resolved through the first-party catalog manifest at `/models/catalog.json` — a curated, CC0-licensed model library (the first kit is Kenney's Modular Cave Kit). This scheme goes in a piece's **`model`** field, never in `face`/`back`/`imageUrl`. There is no arbitrary-URL form: only refs the manifest lists resolve, and an unknown ref renders as a placeholder box rather than an error. Catalog footprints are measured in cells of **2.0 world units**; sections grid-snap onto a `pitch: 2` snap grid.

## 6. Pack format (tbpp) — stable

### 6.1 Fields

- **`specVersion`** — the pack spec you generated against (§2.1). Currently `{{PACK_SPEC_VERSION}}`.
- **`id`** — stable identity for the pack, e.g. `ember-duel`. See §8 on collisions.
- **`name`** — human-readable title.
- **`scope`** — `"table"` or `"player"`. `table` is the shared game loaded once per lobby by the host (board, communal decks). `player` is what one participant brings and is spawned per seat — a deck-builder export is a player pack. When in doubt for a card game, use `player`.
- **`decks[]`** — `slot` (stable id within the pack), `name`, `back` (a face ref), optional `isFaceUp`, and `cards[]`.
  - **`cards[]`** — `code` (stable id within the deck), optional `name` (carried onto the spawned card and shown as the caption of the zoomed hover preview, only while the card is face up), `face` (a face ref), and optional `orientation` — {{CARD_ORIENTATIONS}}. A landscape card rests turned 90° everywhere it renders (board, hand, preview) while its art stays portrait in the image; use it for cards that are played sideways (the analog of Tabletop Simulator's `SidewaysCard`).
- **`pieces[]`** _(optional)_ — `kind` ({{PIECE_KINDS}}), `name`, optional `color` (hex string, used when there is no image), optional `imageUrl` (a face ref), optional `states` and `state` (§6.2), optional `radius`, optional `maxValue` (counters), optional `snap` (default `true`; `false` opts the piece out of snap points and grids — it drops as if Alt were held), optional `reach` (a whole number ≥ 0: how many snap-point links the piece usually travels — advisory reach rings, §7.2), `position` as `[x, z]`, and optional `rotation` (table yaw in **degrees**, default 0). A bag adds the three fields in §6.3; a model carries its catalog ref in **`model`** (§5.4).
- **`overlays[]`** _(optional)_ — board/map images: `imageUrl` (a face ref), `ratio` (image width ÷ height), `scale` (world size along the long axis).
- **`source`** _(optional)_ — provenance stamp written by converters; the only value is `"tts"`. Omit it in hand-authored packs.

Decks spawn in declaration order. A facedown deck is shuffled when spawned directly onto a table; a scenario placement controls this explicitly (§7).

### 6.2 Multi-state pieces

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

**`states[0]` is the base face.** The array is the piece's _complete_ ordered set of faces, not extra ones added to `imageUrl`. A piece with `states` renders `states[n].face` and starts at `n = 0` unless a scenario placement's `state` says otherwise (§7.1). Write `imageUrl` equal to `states[0].face`: it is the fallback for anything that ignores states.

`face` is a face ref (§5) — schemes may be mixed inside one piece. `name` is optional and labels the state on hover and in its picker menu. Only `token` and `counter` pieces render an image, so states on a `pawn` change its label, not its shape.

A piece may also carry **`state`**: the index it _spawns_ showing, for when that is not the base face. Omit it unless you mean it; a scenario placement's `state` (§7.1) overrides it.

Players cycle a piece with `X` (`Shift+X` backwards) or pick a state from its right-click menu; the current index is synced game state, so it survives a scenario save/load.

### 6.3 Bags — a hidden blind-draw pool

A piece of `kind: "bag"` is a container: a pouch holding a pool nobody can look into. Clicking it draws **one** item out beside it; dragging a card or piece onto it puts that object in. It is the analog of Tabletop Simulator's `Bag` / `Infinite_Bag`.

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

- **`contents`** — what the bag holds, in insertion order. Each entry is either a **piece item** — `kind` {{BAG_PIECE_ITEM_KINDS}}, plus `name` and the optional `color` / `imageUrl` / `radius` / `maxValue`; there is no `position`, because the draw decides where it lands — or a **card item**: `kind: "card"` plus `code`, optional `name`, `face` (a face ref, §5), optional `back` and optional `orientation` (§6.1).
- **`drawMode`** — {{BAG_DRAW_MODES}}.
- **`infinite`** — `true` makes each draw **clone** the item rather than remove it, so the bag never empties. Its badge reads `∞`.
- `code` must be **unique within the bag**, like a deck's card codes: the drawn card's table id is built from it.
- **Bags cannot contain bags.** Containers do not nest in this format; do not emit a `"bag"` item inside `contents`, it will be rejected.

Only the remaining count is ever shown on the table — never the contents. The contents do travel in shared game state so that one client's draw resolves for everyone, so treat "hidden" as a property of the interface, not as a secrecy guarantee: it hides a bag the way a face-down deck hides its cards, not the way encryption hides them.

A drawn card arrives **facedown**; a drawn piece arrives as an ordinary piece of its kind. In a scenario a bag is an ordinary `piece` placement — its contents come from the pack, and there is no field for the remaining contents of a partly-drawn bag.

### 6.4 JSON Schema

{{PACK_SCHEMA}}

### 6.5 Worked example

A complete, valid pack. Save as `ember-duel.tbpp.json` and import it from the table.place setup screen.

{{PACK_EXAMPLE}}

## 7. Scenario format (tbps) — UNSTABLE, no compatibility promise

Re-read §2 before building on this.

A scenario is a saved arrangement. Version 2 **references** packs rather than copying their contents: `packs` says where the content comes from, `placements` says where each piece of it goes, and `state` carries anything not derived from a pack. Versions {{TBPS_SUPPORTED}} are accepted on import; v2 is what you should write.

### 7.1 Fields

- **`specVersion`** — the scenario spec you generated against (§2.1). Currently `{{SCENARIO_SPEC_VERSION}}`.
- **`name`**, **`createdAt`** — title and a Unix epoch timestamp in milliseconds.
- **`packs[]`** — `{ id, source? }` for every pack the scenario draws from. `source` is `"builtin"` for packs shipped with the app (currently only `standard-52`), `"local"` for a pack held in the reader's own browser-local pack library, or an `https://` URL a `.tbpp.json` can be fetched from. A remote pack goes through the same validation as a local import. A scenario meant to travel to other people must use `"builtin"` or a URL: `"local"` resolves only on the machine that has the pack, and fails loudly (naming the pack id) anywhere else.
- **`placements[]`** — one entry per spawned thing:
  - **`kind`** — `"deck"`, `"piece"` or `"overlay"`.
  - **`pack`** — the `packs[].id` this content comes from.
  - **`content`** — the deck's `slot`, or the **array index as a string** into that pack's `pieces` / `overlays` (`"0"`, `"1"`, …).
  - **`seat`** — `0`–`3`, which seat owns the result. Omit for table-scoped overlays.
  - **`position`** / **`rotation`** — `[x, y, z]` world coordinates and radians (§4). Omitted means the app's per-seat default.
  - **`order`** _(decks)_ — the card sequence as pack card `code`s, top of the deck first. **Order is preserved by default**, so a rigged opening or a fixed encounter deck reloads exactly as authored. It is a list of ids, never card bodies. Unknown codes are skipped with a warning.
  - **`shuffleOnLoad`** _(decks, default `false`)_ — shuffle on load instead of restoring `order`. Per placement, so one scenario can hold a stacked encounter deck and a shuffled draw deck side by side.
  - **`state`** _(pieces)_ — which of the pack piece's `states` (§6.2) it starts on, as an index (default `0`). This is one piece's face; the scenario's top-level `state` field below is something else entirely.
  - **`isFaceUp`** _(decks)_, **`value`** _(counter pieces)_, **`scale`** _(overlays)_ — override the pack's defaults.
- **`snapPoints[]`** _(optional)_ — placement guides on the felt (§7.2 below). Independent of `placements`: they steer what players drop, not what the scenario spawns.
- **`state`** — a partial snapshot for everything _not_ pack-derived: hand-placed cards, ad-hoc pieces. Applied on top of the placements, so it can also override them. This is the part of the format most likely to change; keep as little in it as you can.

Scenarios are **seat-relative**. Entities belong to placeholder players `seat0`–`seat3`, and entity ids follow `kind:owner:slug` — `deck:seat0:main`, `card:seat0:main-AS`, `piece:seat0:hp-0`. Overlays are table-scoped and keyed `overlay:<packId>:<index>`. When a real player claims a seat, every id containing that placeholder is renamed to them. Never put a real player id in a file.

### 7.2 Snap points — placement guides

`snapPoints` is how a scenario makes a board _playable_ rather than merely arranged. Each entry is a spot on the felt that pulls drops onto itself:

```json
"snapPoints": [
	{ "position": [0, 2.5], "rotation": 0, "radius": 1 },
	{ "position": [-4, 0], "y": 2 },
	{ "position": [6, 0], "kind": "grid", "pitch": 2, "cols": 4, "rows": 3 }
]
```

- **`position`** — `[x, z]` in table space (§4). Two elements — elevation is the separate optional `y`, never a third tuple element.
- **`y`** _(optional)_ — elevation: the local floor whatever lands here rests on, substituted for the table top in the rest-height arithmetic. A card dropped on a card on an elevated point still stacks. Omitted means the felt.
- **`rotation`** _(optional)_ — the yaw a caught drop turns to, in **degrees**. Note the unit: `placements[].rotation` is radians, this is degrees, because it maps 1:1 onto a card's own tap rotation and onto TTS snap points. Omit it for a position-only guide, which leaves whatever lands facing as it was. On a grid this is the lattice's yaw instead.
- **`radius`** _(optional)_ — catch radius in world units. Omitted means `SNAP_RADIUS_DEFAULT` (§4). A drop lands on a point when its release is inside the radius; when radii overlap, the nearest point wins.
- **`kind`** _(optional)_ — `"grid"` makes the entry a lattice of square cells; omitted (or `"point"`) is a discrete spot. A drop anywhere over the grid pulls to the nearest **cell centre**; cells and discrete points compete on distance, and a discrete point beats a cell on an exact tie. Grids require:
  - **`pitch`** — cell size in world units;
  - **`cols`**, **`rows`** — extent in cells, `position` being the grid's centre;
  - **`yawStep`** _(optional)_ — degrees; the landing's yaw rounds to the nearest multiple, measured from the grid's `rotation`. Default 90.

Pieces can opt out per piece: a pack piece (or `state` piece) with `snap: false` ignores points and grids entirely — see §6.1.

**Links, tags and reach — an optional board graph.** Many boards move pieces along connected spaces. Two optional fields describe that, and one on pieces uses it:

```json
"snapPoints": [
	{ "position": [-4, 0], "links": ["snap:1"], "tags": ["north"] },
	{ "position": [0, 0], "links": ["snap:2"] },
	{ "position": [4, 0] }
]
```

- **`links`** _(optional)_ — ids of the snap points this one connects to. A point's id is **`snap:<its index in the array>`** — `snap:0` is the first entry. Links are **undirected**: written on either end they join both, so you need not repeat them. A link to an index that doesn't exist is ignored.
- **`tags`** _(optional)_ — free-form string labels (regions, sides, anything a scenario wants to group points by). The table never reads them.
- A piece's **`reach`** _(optional, §6.1 and `state.pieces`)_ — a whole number: how many links the piece usually travels. Lift a piece with `reach` off a linked snap point and the points within `reach` links (breadth-first, including the one it left) glow brighter than the rest; points with something already on them are left out of that bright set but still count as passable.

All three are **advisory only**. Nothing is ever blocked — a drop still lands on whichever point catches it, so house rules keep working. A scenario without links behaves exactly as it did before they existed.

Snap points are **table-scoped, not seat-relative**: unlike a pack piece's `[x, z]`, they are never mirrored for the far side of the table. Author both ends explicitly — one at `[0, 2.5]` facing `0`, one at `[0, -2.5]` facing `180`.

They are inert data. Nothing spawns from them, they claim no ids, they are drawn only in the scenario editor, and a player can always ignore one by holding Alt as they release. A scenario with no `snapPoints` behaves exactly as it did before the field existed.

### 7.3 JSON Schema

{{SCENARIO_SCHEMA}}

### 7.4 Worked example

Two packs — one builtin, one fetched from `{{EXAMPLE_PACK_URL}}` (the pack in §6.5) — with a stacked deck for seat 0, a shuffled deck for seat 1, a counter, a board overlay, three snap points, and one hand-placed token in `state`.

{{SCENARIO_EXAMPLE}}

## 8. Known gaps

Deliberately unresolved. Do not invent syntax for these — a file using it will fail validation.

- **Card multiplicity.** There is no `count` field on a card. To put three copies of a card in a deck, repeat the entry with distinct `code`s (`strike-1`, `strike-2`, `strike-3`). Whether multiplicity becomes a first-class field is undecided.
- **Pack content versioning.** `tbpp` is the _format_ version; a pack cannot declare its own version ("Ember Duel v1.2"). There is no field for it and no upgrade story for a pack whose contents changed under a scenario that references it.
- **`id` collision policy across authors.** Pack `id` is a bare string with no namespacing or registry. Two authors can both publish `ember-duel`, and a scenario referencing `ember-duel` by a URL that later serves different content will silently resolve differently. Until this is decided, prefer a distinctive `id` and always pin `source` to a URL you control.
- **Pieces and overlays in scenarios beyond the fields above** — piece rotation, stacking and zones are not expressible.
- **Snapping beyond square grids.** Square grids (`kind: "grid"`), elevation (`y`) and the per-piece `snap` opt-out exist (§7.2), but hex grids and hidden/layout/randomize zones have no syntax; a snap point cannot restrict _what_ may land on it either.
- **Nested containers.** A bag's `contents` is one level deep: a bag inside a bag has no representation, and the TTS importer skips one rather than flattening it. There is also no way to express the remaining contents of a partly-drawn bag in a scenario.

## 9. Before you emit a file

1. It parses as JSON.
2. The discriminator is present and correct, and `specVersion` is set (§2.1).
3. Validate against the schema (`ajv` with `strict: false`, any other JSON Schema validator, or an editor that honours `$schema`).
4. Every `face`, `back` and `imageUrl` is one of the three schemes in §5 — and every `https://` URL actually resolves.
5. Every `code` is unique within its deck; every `slot` is unique within its pack.
6. For a scenario: every `placements[].pack` appears in `packs[]`, and every `order` entry matches a `code` in the referenced deck.

On import, table.place validates independently of the schema and reports the offending field — for example `decks[0].cards[3].face must be a non-empty string`. If an import is rejected, the message names the path to fix.
