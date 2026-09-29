# Hidden information — what the relay sends, and what it should send

_2026-09-29, tableplace-184. This is an investigation, not an implementation. It
covers the Go relay (`server/`), the websocket layer (`src/lib/websocket/`) and
the game store actions (`src/lib/store/game/actions/`). File the tickets at the
end from this document._

Hidden information is treated here as a property of **containers**: a hand, a
deck, a face-down card, a bag. It is never a property of a game. Every rule
below must work unchanged for any card or board game. A game that wants
different visibility (open hands, a face-up market row) says so in pack or
scenario data. The server and client never gain a game-specific branch.

---

## 1. What the relay sends today

The relay is a schema-agnostic merge-and-rebroadcast loop:

- **Update.** `game.update` merges the client's patch into `g.Data`
  (`server/game/game.go`, `update`). `HandleMessage` then rebroadcasts the
  **original message verbatim** to every other client in the lobby
  (`Exclude: from.ID`, empty `To`).
- **Sync.** On connect, `SyncPlayerState` marshals the **entire** `g.Data` and
  sends it to the joining socket (`server/lobby/server.go`,
  `handleWebsocket` → `SyncPlayerState`).
- **Camera.** Camera messages are relayed and never stored.
- **Identity.** Identity is whatever `?player=` says. `handleWebsocket` reads
  `lobby` and `player` from the query string with no secret. The client takes
  the id from `localStorage.myPlayerId`
  (`src/lib/store/game/actions/player.ts`), so any client can connect as any
  player id. `HandleMessage` also trusts a non-empty `msg.PlayerID`.
- **Rate limit.** 7 msg/s sustained, burst 15, per socket, inbound only
  (`server/lobby/lobby.go`, `AddClient`). Exceeding it disconnects the client.

There is no per-recipient view anywhere in the pipeline. Whatever one client
writes, every client receives.

## 2. The secrets that exist today

**Nothing below is secret on the wire.** Every item is readable in devtools on
every client in the lobby (the WS frames tab, or `window.__tableplace` in dev).
The only protection is that the UI chooses not to draw it.

| #   | Secret                         | Where it lives on the wire                                                                                                              | Why it leaks                                                                                                                                                                                                                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Hand contents**              | `players[id].tray[cardId]` carries the full card, including `faceImageUrl` (`store/game/types.ts:76`; written by `actions/tray.ts`).    | Synced to everyone. `hud/players.ts` only exposes `handCount` for others (`:142`). `packs/prewarm-state.ts:33` **fetches the face image of every player's hand**, so the leak also shows in the network tab.                                                                |
| S2  | **Deck order and composition** | `decks[id].cards` is an ordered array of `{id, faceImageUrl, backImageUrl?}`, whether the deck is face-up or face-down (`types.ts:52`). | Shuffle runs on the acting client with `Math.random` and sends the whole reordered array (`actions/deck.ts:370-395`). The shuffler and every observer know the order. Scenario seeding writes every seat's decks from one client (`scenario/scenario.ts`, `applyScenario`). |
| S3  | **Face-down card faces**       | A face-down card is `rotation[0] === 180` (`actions/card.ts:25`). Its `faceImageUrl` stays in the entity.                               | Every path that creates a face-down card writes the face: draw, bag draw, and hand→table (`HUDTray/TrayCard.svelte:90-91`). `Card.svelte` keeps the face plane mounted and only hides it.                                                                                   |
| S4  | **Bag contents**               | `pieces[bagId].contents: BagItem[]`, in draw order (`types.ts`, `PieceDTO.contents`).                                                   | The draw is resolved on the acting client (`actions/bag.ts:91-139`). `docs/packs.md:105-132` already says the bag is "hidden in the UI only".                                                                                                                               |

Two cross-cutting leaks defeat any fix that addresses only the four fields
above:

- **L1: ids name the card.** Pack cards are `card:<owner>:<slot>-<code>`
  (`compose/pack.ts:41`), for example `card:p1:main-AS`. Bag draws use
  `card:<owner>:<bag>-<code>`, and TTS loose cards embed a slug of the name.
  A draw keeps the deck card's id (`actions/deck.ts:268,318`). Hiding
  `faceImageUrl` alone still broadcasts `…-AS` as a key. Only TTS deck imports
  use index-based ids. `/create` also parses this id grammar backwards (#109),
  so it can't simply be replaced.
- **L2: face refs name the card.** `gen:std52/AS`, `sheet:{…cell…}` and
  per-card `https://` URLs identify a card as well as the image itself does. A
  redaction has to remove the **whole ref**. Swapping it for a hash of the ref
  doesn't work, because the pack is public and a 52-entry dictionary reverses
  the hash.

Two more facts constrain every option:

- **Integrity.** Any client can write any field today. A client can play a card
  it never drew by writing a face, or reorder a deck. Confidentiality and
  integrity are separate problems. This ticket is about confidentiality, but
  each option below states what it does for integrity.
- **Randomness is client-side.** Shuffles and bag draws use the acting client's
  `Math.random`. Whoever runs the random choice knows the result.

---

## 3. Option 1: server filtering

The relay keeps the full state and sends each recipient a **projection**. A
projection is the state with every container that recipient may not see
redacted.

### Visibility rules (generic, per container)

| Container                       | Default visibility                           | Redacted form for everyone else                                                                                    |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `players[p].tray`               | owner `p`                                    | same keys (opaque ids), each value `{backImageUrl, orientation}`. Opponents can render a fan of backs and a count. |
| deck with `isFaceUp !== true`   | **nobody**, including the owner              | `cards: [{backImageUrl, orientation}, …]` of the same length, with no ids and no faces.                            |
| deck with `isFaceUp === true`   | everyone (a discard pile is public)          | none                                                                                                               |
| card with `rotation[0] === 180` | nobody, or the placer once #193 (peek) lands | `faceImageUrl` absent                                                                                              |
| bag `contents`                  | nobody                                       | `contentsCount: n` (or a same-length array of `{}`)                                                                |

A pack or scenario can override the default per container with a data field
(for example `visibility: 'all' | 'owner' | 'none'` on a deck definition or a
bag, for open-hand games). The field is data. The relay never learns a game's
name.

### Server changes

1. **Per-recipient diffing replaces verbatim rebroadcast.** After merging a
   patch, for each recipient `r`, send `diff(view_r(before), view_r(after))`,
   restricted to the entities the patch touched. This one rule covers:

   - **Reveals.** A face-down card flipped face-up: the flipping client's patch
     contains only `rotation`, and the diff pulls `faceImageUrl` from state for
     everyone.
   - **Un-reveals.** Flipping a card face-down produces `faceImageUrl: null` for
     `r`, which the client's null-delete merge already handles.
   - **Container moves.** A card leaving a hand shows up for others with
     whatever the destination allows.

   The client's merge semantics are unchanged. It still receives RFC-7386-style
   patches, just ones computed for it.

2. **Secret-dependent operations become server actions.** A client that can't
   see a deck's order can't compute "the deck minus its top card". So these
   move from client-built patches to a small action vocabulary resolved on the
   relay with `crypto/rand`:

   - `draw(deck, n, to: 'table' | 'hand', pose)`
   - `shuffle(deck)`
   - `play(cardId, pose, faceUp)` from hand
   - `take(cardId)` to hand
   - `return(cardId, deck, where)`
   - `bagDraw(bag, pose)` and `bagReturn`
   - `search(deck)`, which reveals to the searcher only and broadcasts a notice
     that a search happened (item B5 in `deck-manipulation-primitives.md`)
   - `peek(cardId)` (#193)

   This is the action protocol SPEC.md §4b already wants. Here it is needed for
   the containers, not for all of state.

3. **Face refs are write-once.** After spawn, the relay ignores
   `faceImageUrl` in client patches for existing cards. This closes the
   "play a card you never drew" integrity hole for free.
4. **Opaque ids.** The server (or the spawning client) mints random ids for
   cards inside hidden containers, and re-keys on shuffle (fixes L1).
5. **Seat secrets.** On a player id's first connect, the relay issues a random
   token. Later connects for that id must present it. Without this, filtering
   protects nothing, because an opponent connects as `?player=<you>` and gets
   your projection. The invite/seat-claim link (`scenario/invite.ts`) has to
   carry or mint it.

### Client changes

- Render redacted entities:
  - cards with no face render back-only;
  - decks render from `cards.length` (no ids);
  - opponents' hands render as backs, which the HUD can show.
- `actions/deck.ts`, `actions/tray.ts` and `actions/bag.ts` send actions for the
  operations above instead of building patches. Everything else (moves,
  rotations, counters, dice) stays a patch.
- A draw needs one round trip before the face is known. The "draw flies to your
  hand" animation starts on a back and fills the face in when the reply
  arrives.
- `prewarm-state.ts` needs no change. It can only prewarm what it receives.

### Reconnect and reload

- **Reload.** The seat token is in `localStorage`, so the filtered `sync`
  returns the player's own hand intact. Same as today, minus the leak.
- **Device switch.** Needs the seat token moved, through an invite link that
  carries it.
- **Grace period.** The 5 s offline grace and 15 min empty-lobby TTL are
  unchanged. A relay restart still drops the lobby. That is true today, and no
  worse.

### Deck order

Protected. The order exists only on the relay, and shuffles use server
randomness. The seeding client knows the order it wrote, so a scenario load
must end with a server `shuffle` for every deck marked `shuffleOnLoad`. The
seeding client can't be the one that shuffles.

### Spectators

There is no spectator concept today. `?seat=` is a seat claim. A socket with
no seat gets the public projection: counts and backs.

An **omniscient spectator** (for casting or teaching) is a lobby-level opt-in.
The table has to set it, because otherwise any player can open a second tab as
a spectator and see everything. Without accounts this can't be prevented, only
made opt-in.

### Wire cost

- **Client → relay.** Each operation stays **one** inbound message. `draw(n)`
  must carry `n`: the 1–9 "draw several" hotkeys must not become n messages,
  because that runs into the burst of 15.
- **Relay → client.** Messages are outbound and not rate-limited. There is still
  one per recipient per operation. Only the contents differ per recipient.
- No new steady stream. Drag (5 Hz) and camera (~3 Hz) are unaffected, because
  positions are public.

### Protects

S1 hand, S2 deck order, S3 face-down faces, S4 bag contents. L1 and L2 are
fixed by opaque ids and whole-ref redaction.

**Trust assumption:** whoever runs the relay sees everything. In the
host-authoritative p2p mode SPEC.md §4b recommends (M3), the host is a player,
so the host would see everything. Either keep a thin relay as the authority
for hidden containers, or accept "the host can cheat" for that mode. Section 6
lists the ticket for this decision.

---

## 4. Option 2: client-held hands

Hand contents never leave the owning client until played. The wire carries
only a count, and the relay stays schema-agnostic.

### Changes

- **Server.** None needed. Seat secrets are still advisable, but not for
  confidentiality: there is nothing secret on the server to steal.
- **Client.**
  - `tray` becomes local state persisted to `localStorage` or IndexedDB, keyed
    by `(lobby, player)`.
  - The synced player row carries `handCount` (or a keyed set of opaque ids
    with no values).
  - Taking a card sends `{cards:{id:null}, players:{me:{handCount}}}`.
  - Playing sends the card with its face (face-up), or without it (face-down).
- **Face-down play.** The card enters the table with no face, and only the
  owner can reveal it. If the owner has left, the card stays face-down for good.
  A physical table has no such failure.
- **Integrity gets worse, not better.** Nothing on the wire records what is in
  a hand, so a player can "play" any card they like. Option 2 is only sound
  with option 3 on top of it.

### Reconnect and reload

- **Reload in the same browser.** Works, restored from local storage.
- **Another device, cleared site data, or a private window.** The hand is gone.
  The table shows a count for cards nobody can produce.
- **Relay restart.** Local hands outlive the lobby, and the two sides disagree.
- **Seat claim.** Today `claimSeat` copies `ph.tray` into the new player
  (`scenario.ts:400`). With client-held hands, a placeholder seat can't hold a
  hand at all, because nobody's client owns it.

### Deck order

Not protected, unless decks become client-held too. An **owner-held deck**
(order kept on its owner's client, with the wire carrying count and back) hides
the order from opponents but not from the owner, who can then choose their
draws. **Shared decks, which have no owner, can't be protected at all** without
a mental-poker protocol (section 5).

### Spectators

Counts only. An omniscient spectator mode is impossible without every owner
streaming their hand to it.

### Wire cost

The same message count as today, with fewer bytes. A draw from a synced deck is
one patch, a play is one patch, a reveal is one patch. No new stream.

### Protects

S1 hand only, and only against reading, not against fabrication. S3 is
protected for cards played from a hand. S2 and S4 are not protected. L1 still
has to be fixed, or a card's id announces it when it is drawn from a public
deck.

---

## 5. Option 3: commit and reveal

A client that places a secret publishes a commitment instead of the secret,
and later reveals the secret together with the salt. Every client verifies the
reveal.

```
commit = SHA-256(lobbyId ‖ entityId ‖ faceRef ‖ salt)   // salt: 16 random bytes
```

Binding the lobby and entity id prevents replay across cards and lobbies. The
salt is essential, because face refs have very little entropy (L2): 52 candidate
refs are trivially brute-forced. Use `crypto.subtle.digest` and
`crypto.getRandomValues`. No server code is involved.

### Changes

- **Server.** None. A commitment is just another string field the relay merges
  blindly.
- **Client.**
  - A face-down card carries `commit` in place of `faceImageUrl`.
  - Revealing sends `{faceImageUrl, salt}` in one patch.
  - Receivers recompute the hash and mark the card verified or mismatched. A
    mismatch is shown to the whole table and never silently hidden.
  - A hand card is committed as it enters the hand, so a later play can be
    checked against it. That requires the committer to be the only one who
    ever saw the face, so it only works on top of option 2 (or when the
    committer created the card).

### Reconnect and reload

The salts must persist locally with the secrets they protect, just like option
2's hand. A lost salt means the card can still be revealed but not verified.
The table then sees "unverified", which is honest.

### Deck order

A shuffler can commit to the shuffled order as per-position commitments (or a
Merkle root). Draws are then provably the committed top card. That stops
**changing** the order after the shuffle, but the shuffler still **knows** it.

A fair shuffle among mutually distrusting players is mental poker (SRA-style
commutative encryption):

- **Shuffle.** Each player encrypts and shuffles in turn, which is N sequential
  messages.
- **Draw.** Every other player must publish a decryption share: N−1 messages
  per card, with all players online.
- **Budget.** An opening deal of 5 cards to each of 4 players is 15 key shares
  from each client in a few seconds. That is exactly the burst limit, so shares
  would have to be batched per deal.
- **Verdict.** Workable, but it is research-grade work and makes every draw
  depend on every player's connection.

### Spectators

Spectators see commitments and can verify every reveal. This is the one option
where a spectator (or a later replay) can **audit** a game without trusting
anyone. It still gives them no view of the secrets themselves.

### Wire cost

- **Commit.** Adds bytes (~64 hex characters per secret) but no messages.
- **Reveal.** One patch, the same as a flip today.
- **Mental poker.** Adds N−1 discrete messages per draw. That is not a steady
  stream, but it does run into the burst limit (see above).

### Protects

Integrity of S3 face-down plays and of committed hands and deck orders. It
provides confidentiality only for secrets the committer alone holds, so on its
own it protects none of S1–S4 from reading. It is a complement to option 1 or
2, not an alternative.

---

## 6. Comparison

|                        | Option 1: server filtering                | Option 2: client-held                                                          | Option 3: commit and reveal                   |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| **S1 hand**            | ✅ hidden                                 | ✅ hidden (fabrication possible)                                               | integrity only                                |
| **S2 deck order**      | ✅ hidden from everyone, owner included   | ❌ (owner-held decks: hidden from opponents, not from owner; shared decks: ❌) | integrity only; mental poker for fairness     |
| **S3 face-down faces** | ✅                                        | ✅ when played from a hand                                                     | ✅ integrity; confidentiality only with 2     |
| **S4 bag contents**    | ✅                                        | ❌                                                                             | ❌                                            |
| **Server change**      | large: projections, actions, seat tokens  | none                                                                           | none                                          |
| **Reload**             | ✅ from relay                             | same browser only                                                              | same browser only (salts)                     |
| **Spectators**         | public view; omniscient mode as an opt-in | counts only                                                                    | counts only, plus audit                       |
| **Messages**           | unchanged (1 per op; `draw(n)` batched)   | unchanged                                                                      | unchanged, plus N−1 per draw for mental poker |
| **Trust**              | relay operator (the host in p2p mode)     | nobody for reading; everybody for integrity                                    | nobody                                        |

## 7. Recommendation

**Build option 1**, the container-visibility model enforced by whichever
component is the authority. Today that is the Go relay.

- It is the only option that protects all four secrets, including shared decks
  and bags, which options 2 and 3 cannot hide without mental poker.
- It keeps reload working.
- It fixes the worst integrity hole along the way: face refs become
  write-once, and secret-dependent randomness moves to the server.
- It needs no new message stream.
- It lines up with the action protocol SPEC.md §4b already calls for. The
  actions it needs are exactly the container operations, so the rest of state
  can stay patch-based.

**Do not build option 2.** Its costs are:

- hands lost on device switch or cleared storage;
- stuck face-down cards;
- free fabrication;
- no answer for shared decks or bags.

It buys only a relay that stays dumb.

**Keep option 3 in reserve** for a mode with no trusted authority. That is p2p
with a host who is also a player, or a future "verifiable game" feature. The
commitment format above is cheap to add later on top of option 1. With a
trusted relay it adds nothing.

Order of work:

1. **Opaque ids.** They are safe to ship alone and useless without the rest.
2. **Seat tokens.**
3. **Relay projection and actions.**
4. **Client rendering of redacted entities.**
5. **Spectator role.**

Until step 3 ships, UI copy must not call anything "private" or "hidden". #193
(peek) already states this limit.

## 8. Tickets to file

Each ticket follows the table-feel ground rules: generic containers, no game
names, and a spec bump wherever a published shape changes.

1. **Opaque card ids in hidden containers.**
   - Mint random ids for cards in decks, hands and bags, and re-key on shuffle.
     Fixes L1.
   - Keep `/create`'s card marking (#109) working through `packOrigin`-style
     provenance instead of the id grammar.
   - Behaviour-only for the tableplace-api.
2. **Seat secrets on the relay.**
   - Issue a token on a player id's first connect and require it afterwards.
   - The invite/seat-claim link carries or mints it.
   - `HandleMessage` stops trusting `msg.PlayerID`.
3. **Container visibility in the data model.**
   - Default rules per container (section 3), plus an optional
     `visibility: 'all' | 'owner' | 'none'` on deck and bag definitions.
   - This touches `packs/types.ts`, `scenario.ts` and the schemas, so it needs a
     pack minor bump, a scenario patch bump, `/create` and `/setup` authoring,
     and the TTS mapping (TTS hand zones and hidden zones). Additive.
4. **Relay: per-recipient projections.**
   - Replace verbatim rebroadcast of `update` with
     `diff(view_r(before), view_r(after))`, and filter `sync`.
   - Face refs become write-once.
   - Go unit tests per container rule, including reveal on flip and un-reveal
     on flip back.
5. **Relay: container actions.**
   - `draw(n)`, `shuffle`, `play`, `take`, `return`, `bagDraw`, `bagReturn`,
     `search`, `peek`, resolved with `crypto/rand`.
   - Client `actions/deck.ts`, `tray.ts` and `bag.ts` send actions instead of
     building patches. `draw(n)` is one message.
6. **Client: render redacted entities.**
   - Back-only cards, decks rendered from their length, and opponents' hands as
     a fan of backs.
   - The draw animation fills in the face on the relay's reply.
7. **Scenario load and seat claim through the relay.**
   - After seeding, the relay shuffles every `shuffleOnLoad` deck.
   - `claimSeat` transfers hidden containers on the relay rather than copying
     the tray client-side.
8. **Spectator role.**
   - A seatless socket gets the public projection.
   - A lobby-level opt-in allows omniscient spectators.
9. **Two-client e2e privacy spec.**
   - Seat 0 takes a card into their hand, plays one face-down, and draws from a
     face-down deck.
   - Assert that no frame or `sync` received by seat 1 (captured over CDP)
     contains seat 0's hand face refs, the deck's face refs or the face-down
     card's ref, and that the card still renders and drags for seat 1.
10. **Decision: authority in p2p mode (M3).** Keep a thin relay as the authority
    for hidden containers, or accept "host sees all" for p2p lobbies and say so
    in the UI.
11. **Later, research spike: commit and reveal, and mental poker** for a mode
    with no trusted authority. Section 5 has the commitment format and cost.
12. **Update #193 (peek)** once ticket 4 lands, so the face reaches only the
    placer and the "display rule, not secrecy" caveat can go.
