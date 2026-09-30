# tableplace

A browser-based tabletop simulator ("table.place"): a SvelteKit 2 + Svelte 5 +
Threlte 8 / three.js front end that renders a 3D table where players drag cards,
decks, and pieces, plus an optional Go WebSocket server that syncs lobby state
between clients. Table contents come from built-in packs (a procedurally drawn
standard 52-card deck) or from imported Tabletop Simulator save/Saved-Object
JSON, which is parsed client-side and rendered by slicing the mod's sprite
sheets in the browser. The front end builds as a pure static site
(`@sveltejs/adapter-static`) and is deployed to GitHub Pages by CI; the server is
containerized for Railway.

## Layout

- `src/routes/` — SvelteKit pages: `/` landing, `/play` (the table +
  `Pane.svelte`/`PaneDecks.svelte` tweakpane HUD), `/setup` (scenario editor),
  `/create` (pack editor — authors `.tbpp.json` packs with live 3D preview).
- `src/lib/` — Threlte components (`TableScene.svelte`, `Card.svelte`,
  `Deck.svelte`, `Piece.svelte`, `Table.svelte`, `TableCamera.svelte`,
  `HUDTray/`, `HUDPreview/`, `table-overlay/`).
- `src/lib/store/game/` — authoritative client state: `gameStore.svelte.ts`
  (deep-merge/null-delete store over `GameDTO`), `types.ts`
  (`CardDTO`/`DeckDTO`/`PlayerDTO`/`PieceDTO`/`OverlayDTO`), `actions/` (card,
  deck, player, tray, piece), `README-GameStore.md`.
- `src/lib/websocket/` — `connection.ts` (socket + throttling), `index.ts`
  (connect/join lobby), `storeIntegration.ts` (store↔wire wrappers).
- `src/lib/tts/` — TTS importer: `parse.ts`, `import.ts`, `slice.ts`
  (sprite-sheet slicing, IndexedDB cache).
- `src/lib/packs/` — pack templates and face-ref resolution: `standard52.ts`,
  `resolve.svelte.ts`, `spawn.ts`, `placeholder.ts`.
- `src/lib/scenario/scenario.ts` — save/load seat-relative table presets to
  localStorage and seed a lobby with them.
- `server/` — Go module `github.com/jollygrin/tts-server`: `main.go`, `lobby/`
  (chi router, `/ws`, `/view`, `/{lobby}/debug`), `game/` (in-memory game +
  player state), `jsonmerge/` (RFC-7386-style merge patch).
- Tests: colocated `__tests__/` dirs under `src/lib/**`; Go tests beside the
  package (`server/jsonmerge/merge_test.go`).
- Design docs at the repo root: `SPEC.md` (current source of truth),
  `TTS_IMPORT_PLAN.md`, `MULTIPLAYER_OPTIONS.md`, `SPACETIMEDB_MIGRATION.md`,
  `CONTENT_CREATION.md`, `UPGRADE_FOLLOWUPS.md`.

## Build / test / lint

Run from the repo root (bun is the package manager; `bun.lock` is committed):

```
bun install
bun run dev              # vite dev server
bun run dev:server       # cd server && ./run.sh (go run main.go -debug=true, :8080)
bun run dev:all          # both, via concurrently
bun run build            # static build into build/
bun run preview
bun run test             # bun vitest run — 29 tests, ~1s
bun run test:watch
bun run test:coverage
bun run test:e2e         # headless render harness (see below); [filter] narrows by spec name
bun run check            # svelte-kit sync && svelte-check
bun run lint             # prettier --check . && eslint .
bun run format           # prettier --write .
```

Server (from `server/`, needs Go 1.24+):

```
go test ./...
go vet ./...
go build -o tts-server .
```

## Conventions

- Prettier config is authoritative: tabs, single quotes, no trailing commas,
  100-column width, `prettier-plugin-svelte` + `prettier-plugin-tailwindcss`.
  ESLint flat config = js/ts/svelte recommended with `eslint-config-prettier`.
- Svelte 5 runes throughout (`$state`, `$derived`, `$effect`); rune-bearing
  modules use the `.svelte.ts` extension. TypeScript is `strict` with
  `checkJs: true`; imports use the `$lib` alias.
- Styling is Tailwind v4 via `@tailwindcss/vite` (no tailwind.config file).
- Game state is a record-of-records (`cards`/`decks`/`players`/`pieces`/
  `overlays` keyed by id); updates are surgical partial patches, and `null` at a
  path means delete. `jsonmerge.Patch` on the server intentionally mirrors the
  client `merge` semantics.
- Entity ids encode ownership: `card:<playerId>:<slug>`, `deck:<playerId>:<slot>`;
  scenario editing uses placeholder owners `seat0`–`seat3`.
- Image sources are passed around as short refs, never image bytes:
  `https://…`, `gen:std52/<code>` (canvas-drawn), or `sheet:{json}` (sliced
  sprite-sheet cell) — see `packs/resolve.svelte.ts`.
- Asset/network failures degrade rather than throw: dead URLs and CORS-less
  hosts resolve to `null` and fall back to named placeholder faces.
- Constants live in `src/lib/utils/constants-*.ts` (card dimensions, stacking
  radii, rotations) rather than inline literals.
- Commits: lowercase conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`,
  `revert:`) with a short subject, often followed by an em-dash rationale.

## Headless render harness (`e2e/`)

`bun run test:e2e` drives a real (software-rendered) Chrome through
`puppeteer-core` against its own `vite dev` and its own Go relay. It exists
because **jsdom never executes three.js geometry, a raycast or a WebGL draw** —
tableplace-102 shipped to production past 700 green unit tests, `svelte-check`
with 0 errors and a clean build, because no test in the repo could see it.

- `e2e/specs.ts` is the whole suite. Every spec has the same spine: put a new
  primitive on the table, then assert that *everything else* still renders,
  still gets raycast, and still moves under a real mouse. That is the assertion
  a new primitive needs, because the scene shares one `interactivity()` context
  (#86) and one Svelte effect graph — a single bad entity takes both down.
- Any console `error`, `pageerror` or failed request fails a spec. Keep the app's
  console clean; `IGNORED` in `e2e/table.ts` is for environment noise only.
- The page is driven through `window.__tableplace` (`src/lib/dev/`), which exists
  only under `import.meta.env.DEV`. Spawn through it — the tweakpane `List`
  controls cannot be driven synthetically.
- Anything a spec clicks must draw clear of the HUD panes; `dragBy` fails with
  that diagnosis rather than looking like a frozen table.
- `table.stall({ ms, everyMs })` holds the page's main thread on a duty cycle —
  the long frame gaps a loaded CI runner produces, on demand, and the tool for
  any change that adds per-frame cost. It reproduces the queued-pointer drag
  race (#164) exactly: with `{ ms: 800, everyMs: 20 }` a pre-fix build drags the
  raised tile to the token's drop point. `stall(null)` stops it and returns how
  many stalls ran, so a spec can prove the injection was live.
- Needs Chrome (`CHROME_PATH` overrides discovery) and Go for the relay. Reuses
  a relay already on `:8080`; takes a random high port for the web server so it
  can never disturb a dev server you are using.

## Primitive parity rule

The `/create` pack editor exposing **everything the primitives allow** is an
invariant. Any PR that expands the primitive vocabulary — a new `PieceKind`,
a new imported-object kind, a new deck/card field, a new face-ref scheme —
must, in the same change, also update:

- the `/create` editor (`src/routes/create/`) so the new primitive can be
  authored, previewed, and exported;
- the tbpp/tbps types and validators (`src/lib/packs/types.ts`,
  `src/lib/packs/file.ts`) and the published JSON schemas;
- the TTS import mapping (`src/lib/tts/parse.ts`, `src/lib/tts/to-pack.ts`)
  so the TTS analog of the primitive converts into it.

## Gotchas

- This repo is checked out inside a parent folder (`~/git/tableplace/`) that is
  not itself a git repo; the parent holds `.grove/` local tooling state, which is
  not project code and is not part of this repository.
- `.svelte-kit/` is generated and gitignored, and `tsconfig.json` extends
  `./.svelte-kit/tsconfig.json` — run `bun run prepare` / `svelte-kit sync`
  (both `check` and `vitest` do it via the sveltekit plugin) before type checks
  work in a fresh clone.
- `bun run check` currently exits with 0 errors but 8 `state_referenced_locally`
  warnings in `Card.svelte`/`Piece.svelte`; `UPGRADE_FOLLOWUPS.md` §2 documents
  which of them are real bugs.
- `src/lib/tts/__tests__/parse.test.ts` reads the committed fixtures
  `tts-unmatched-greviousdeck.json` and `tts-clonetroopers.json` from the repo
  root — moving them breaks the suite.
- Runtime configuration is localStorage, not env vars: `serverurl` (host without
  scheme; `ws://` vs `wss://` is chosen automatically, path `/ws`), `myPlayerId`,
  `scenarios:v1`, `corsproxy` (prefix the image URL is appended to,
  URL-encoded; overrides the default CORS proxy below). `/play` also accepts `?lobby=`, `?server=`, `?seat=` query
  params. An empty/absent `serverurl` falls back to the public lobby relay
  `lobby.table.place` (`connection.ts`) — *not* `api.table.place`, which is
  reserved for the HTTP lobby-provisioning API. Precedence, widest to narrowest:
  `?server=` → `localStorage.serverurl` → that default.
- Sprite-sheet slicing needs canvas pixel access, so it retries through a
  third-party CORS proxy (`https://corsproxy.innkeeper1.workers.dev/?url=`,
  `corsProxied` in `utils/image-cors.ts`) when a host sends no CORS headers, and
  caches sliced cells in IndexedDB — a stale cache can mask importer changes.
- Anything that becomes a WebGL texture must resolve its ref with
  `resolveTextureImage`, not `resolveCardImage`: a plain `https:` URL on a host
  without CORS headers (every TTS `UniqueBack: false` deck back) loads in an
  `<img>` but not in WebGL, and only the texture resolver probes it and falls
  back to the proxy (tableplace-262). Art that fails to load shows its
  placeholder and is retried on a backoff, then again on the next sync.
- Server env vars: `PORT` overrides `-addr` (Railway); `ADMIN_TOKEN` gates
  `/view` and `/{lobby}/debug` — unset means those routes 404.
- Game state is in-memory only on the server; restarting it drops every lobby.
- The GitHub Pages workflow sets `PUBLIC_BASE_PATH: '/svelte-aframe'`, but
  `svelte.config.js` hardcodes `paths.base` to `''`, so that variable has no
  effect.
- A PWA service worker (`@vite-pwa/sveltekit`, `registerType: 'autoUpdate'`) with
  CacheFirst rules for images and models is active in builds — hard-reload when
  asset changes appear to be ignored.
