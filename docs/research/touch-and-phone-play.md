# Touch and phone play — gesture map and slice list

_2026-09-29, tableplace-205. WIP, parked: the tested findings are complete. The inferences, the gesture map and the slice list are still to be written._

## Tested findings (Chrome touch emulation)

**Setup.** Headless Chromium 1243 with SwiftShader, via the e2e harness
(`startServers` and `openTable`). The viewport was 390×844 (and 844×390) with
`isMobile` and `hasTouch` set before navigation, on a local relay on `:8080`.
Gestures went through CDP `Input.dispatchTouchEvent`. The probe is
`touch-and-phone-play.probe.ts.txt`, next to this file. To rerun it, copy it
to `e2e/touch-probe.ts` and run
`CHROME_PATH=… bun e2e/touch-probe.ts portrait|landscape`. For the focused runs,
add `ONLY=fastdrag|fasttap|hand|drag`.

**Host caveat.** The host was loaded (load average 11–13 on 4 cores), and the
page handled each event 1–3 s late. An awaited CDP `touchStart` blocks until
the renderer acks it, so the next move is also sent late. Any spec that awaits
every touch call is therefore really testing a long press.

- **Emulation is real.** `(pointer: coarse)` and `(hover: none)` match. three's
  OrbitControls sets `touch-action: none` on the canvas wrapper, so the page
  never scrolls or zooms (`visualViewport.scale` stays 1).
- **One finger on the felt orbits.** The camera turns and no box select starts.
- **Pinch zooms.** Two fingers spreading moved the camera from distance 49 to
  11 in portrait and from 25 to 5.7 in landscape. Closing them brought it back
  out.
- **Two-finger pan works, but weakly.** A 120 px parallel two-finger move
  shifted the camera about 0.7 units at distance 11.
- **Touch drag works.** With non-blocking sends, a token and a card each
  lifted and landed, 4 out of 4. The first run showed 0 out of 6, but that was
  a probe artifact (see "Verified surprises" in PR #234).
- **A tap on a deck draws one card to the hand** (3 out of 3 with non-blocking
  sends). This is the same as a mouse click.
- **Long press opens the radial wheel** on a card, a deck and a token. It
  offers the same verbs as right-click. A flick to a wedge runs the verb: Flip
  turned a face-down card face-up. Lifting without travel closes the wheel, so
  there is no sticky wheel on touch.
- **A tap on a card does nothing visible.** No preview opens, no hover is set,
  and nothing is selected. Preview is reachable only with Space or Alt.
- **A double tap on the felt does nothing.** The camera doesn't move and no
  `dblclick` is emitted, although on desktop a double-click focuses.
- **No `contextmenu` event** was emitted by the emulated long press.
- **The wheel is about 230 px across and centred on the finger.** On a 390 px
  screen, a card at x≈110 put the Lock wedge at x≈33. The finger covers the
  hub.
- **The panes cover the table.** Both tweakpane panes are 300 px wide. They
  cover 38% of a 390×844 screen and 53% of an 844×390 screen. In landscape they
  covered the deck and the token, so a tap there hit the pane.
- **The hand is left-anchored with 96 px slots and no wrapping.** On a 390 px
  screen only 3 cards show fully and a 4th is cut off, whether the hand holds
  5, 7 or 9 cards. In landscape the hand cards are clipped at the bottom edge,
  and the hint bar overlaps them.
- **Copy is mouse-only.** The hint bar reads "drag Select · right-drag Orbit"
  on a touch device. The journal log covers the middle of the felt in portrait.
- **A drag out of the hand works:** the card leaves the tray.

## Inferences

TODO

## Gesture map

TODO

## Slice list

TODO
