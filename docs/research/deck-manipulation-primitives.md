# Deck & pile manipulation — primitive gap analysis

*2026-07-25. Source: full code survey of `src/lib` interaction layer + SPEC.md /
TTS_IMPORT_PLAN.md / tts-tactile-habits-report.md cross-check. This is the
backlog source for card-handling primitives; file tickets from here.*

## Where we are today

Two card containers exist, and only one is a real object:

- **`DeckDTO`** (`src/lib/store/game/types.ts`) — the formal pile. Has
  position, ordering, count label, face-up variant. But its interaction
  surface is tiny: `pointerdown` **always draws one card** (the deck itself
  cannot be dragged — moving it requires the tweakpane XZ widget), shuffle is
  a pane button (own decks only), and `isFaceUp` is frozen at creation.
- **Loose stacks** — not objects at all. Dropping card B on card A just sets
  B's Y to `maxY + thickness` within a 1.7-radius XZ scan
  (`src/lib/utils/transforms/stacking.ts`). No stack id, no membership, no
  XZ snap (piles drift/fan), no re-settle when a middle card leaves, and the
  raycast on click returns exactly one card — usually the top — so there is
  **no way to grab a pile, split it, or turn it into a deck**.

There is **no selection model** (no box-select, no shift-click, no group), and
**no context/radial menu** anywhere except the counter piece's right-click.
The entire keyboard surface is: Space preview, F flip, T/R tap, C camera,
↑/↓ height nudge.

Sync layer note: everything is a `GameDTO` patch over WS (`updateState` →
merge, arrays replace wholesale). New primitives need **no server or protocol
change** as long as they're expressible as a state patch. Watch: last-write-
wins concurrency (two simultaneous deck mutations clobber), and any new
draggable collection must join the position-throttle list in
`storeIntegration.ts` or it trips the server rate limiter.

## Needed primitives

Effort: S = one action + one binding; M = touches drag/drop routing or a new
UI surface; L = needs new interaction infra (selection, menus).

### A. Pile formation & handling (the core complaint)

| # | Primitive | TTS analog | Effort | Notes |
|---|-----------|-----------|--------|-------|
| A1 | **Group loose stack → deck** (hotkey `G` on hovered card) | `G` group | **S/M** | Everything needed exists: reuse the `resolveStackHeight` radius scan for membership, order by Y, `addDeck` at base-card XZ, delete loose card entities. Instantly gives piles draw-1 / count / return-to-top semantics for free. |
| A2 | **Square-up on stack drop** — snap XZ to stack base | auto-align | **S** | Pure change in the drop commit; makes stacks read as intentional piles instead of drift. Optional small random jitter for feel. Holding `Alt` at release opts out (raw pointer XZ, rests on the felt), so cards can still be laid out deliberately next to each other. |
| A3 | **Grab whole pile** (modifier-drag or long-press on a stack/deck) | RMB-drag / container drag | **M** | *Shipped for decks.* Drag threshold on pointerdown — move = drag the whole deck (streams through the position throttle like cards), click = draw 1 to the felt in front of the deck. Loose stacks still wait on the selection model. |
| A4 | **Split / take N** (drag off top with count, or cut at midpoint) | number+drag, Cut | **M** | Depends on A1 (needs real pile objects to split). |
| A5 | **Re-settle stack Ys** when a mid-card is removed | gravity | **S** | Run the stack scan on pickup, not just drop. |
| A6 | **Ungroup deck → loose stack** (hotkey `Shift+G` on a hovered deck) | unpack container | **S** | *Shipped.* The inverse of A1 and the only way back out of a `G` short of drawing one card at a time. `DeckDTO.cards` is already the full ordered list, so it's one patch: delete the deck, write the cards. `orderForDeck` is its own inverse, so the ordering convention survives the round trip. Own decks only (matches shuffle), and capped at `UNGROUP_MAX_CARDS` (40) so a 200-card deck can't carpet the felt. |
| A7 | **Hover-fan a loose pile** (cascade members on hover) | — | **S** | *Shipped.* Membership comes from the same `collectStackGroup` scan `G` uses, so the fan is an honest preview of what `G` will swallow — and it's what tells a squared-up loose pile apart from a `DeckDTO` slab. Render-time only: a local hover never patches `GameDTO`. Anchored on the visual top card so fanning can't slide the pile out from under the cursor. |

### B. Deck verbs

| # | Primitive | TTS analog | Effort | Notes |
|---|-----------|-----------|--------|-------|
| B1 | **Draw N** (number keys 1–9 while hovering deck) | number keys | **S** | *Shipped.* `drawFromTop(id, count)` lands the cards fanned down-screen of the deck, one thickness apart in Y, in a single patch. |
| B2 | **Flip whole deck** (toggle `isFaceUp`) | flip deck | **S** | *Shipped.* `F` on a hovered deck. Toggling `isFaceUp` alone is the physical flip — the draw convention (top = last vs first) makes the former bottom the new top. |
| B3 | **Shuffle hotkey + visible feedback** (hover deck + `S`) | shake/`R` | **S** | *Shipped.* `S` on a hovered own deck; `shuffledAt` rides the shuffle patch and every client's Deck plays a decaying yaw wiggle when it changes. |
| B4 | **Deal to seats** (right-click → deal N to each player tray) | Deal | **M** | Blocked on B6 for discoverability, but the action itself is a loop of draw→tray patches. |
| B5 | **Search / browse deck** (scrollable contents list, take/reorder) | Search | **M** | SPEC already plans the Bag to *reuse* this UI — build it once here. Hidden-info: only reveal to the searcher. |
| B6 | **Context menu on card/deck** (right-click) | RMB menu | **M/L** | The unlock for every discoverable verb (deal, search, reset, flip-pile). Today right-click on a card falls through to camera orbit. |
| B7 | **Reset / refill** — discard pile → shuffle → replace draw deck | Reset | **S/M** | deck→deck transfer doesn't exist yet; this is its first use case. |
| B8 | **Peek / draw-bottom / reveal N** | ALT-peek etc. | **M** | Peek must be peek — the Space preview correctly shows the back today. Needs per-player visibility, which #37's hidden-state work established. |
| B9 | **Missing container transitions**: deck→deck, deck→tray, tray→deck | various | **M** | Only deck→table, table→deck, table↔tray exist. |

### C. Selection & multi-card

| # | Primitive | TTS analog | Effort | Notes |
|---|-----------|-----------|--------|-------|
| C1 | **Box-select + group actions** (flip all, group→deck, move together) | LMB marquee | **L** | Requires reshaping `DragState` (all-singular today) into a set. Do after A1 so "group" has a target. |
| C2 | **Multi-grab drag** (add to held set while dragging) | RMB additive grab | **L** | Same infra as C1. |

### D. Hand tray

| # | Primitive | TTS analog | Effort | Notes |
|---|-----------|-----------|--------|-------|
| D1 | **Hand reordering** (drag within tray) | hand drag | **M** | Tray renders in object-key order today; needs an order array. |
| D2 | **Play face-up vs face-down choice** | flip-in-hand | **S** | Cards currently always leave the hand facedown. |
| D3 | **Deck→hand and hand→deck direct** | draw to hand | **S/M** | Subset of B9. |

### E. Safety & feel (bug-shaped, tiny)

| # | Primitive | Effort | Notes |
|---|-----------|--------|-------|
| E1 | **Esc cancels drag** → card returns to pickup origin | **S** | Tactile-habits report Tier 4 "forgiveness". Needs origin capture in `dragStore`. |
| E2 | **Window-level pointerup fallback** | **S** | Releasing outside the canvas currently leaves `isDragging` stuck (drop only commits on the table mesh). |
| E3 | **Drag threshold on cards** | **S** | Any pointerdown lifts today — no button check, no threshold; misclicks move cards. |

## Suggested sequencing

1. **Quick wins (one ticket):** A1 + A2 + E1/E2/E3 — turns the "stacks are
   fun but unmanageable" complaint into real piles, with drag safety thrown
   in. All client-side state patches, no protocol work.
2. B1/B2/B3 — cheap deck verbs, each a small action + hotkey.
3. B6 context menu, then B4/B5/B7 hang off it.
4. C1 selection model (biggest infra), then A4, C2.
5. D-tier hand work alongside any of the above.

Concurrency (SPEC §4c hold-lease, two players drawing the same top card) is a
known, separate track — don't couple it to these, but keep new actions
patch-shaped so they inherit the fix when it lands.
