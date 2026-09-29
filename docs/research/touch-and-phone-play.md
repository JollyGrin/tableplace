# Touch and phone play — gesture map and slice list

_2026-09-29, tableplace-205. WIP: investigation in progress._

## Tested findings (Chrome touch emulation)

Measured in headless Chrome at 390×844 with `isMobile` and `hasTouch`, driven by
CDP `Input.dispatchTouchEvent`:

- `(pointer: coarse)` and `(hover: none)` match. three's OrbitControls sets
  `touch-action: none` on the canvas wrapper, so the page never scrolls or
  zooms (`visualViewport.scale` stays 1).
- One finger on the felt orbits. No box select starts.
- A two-finger spread zooms in (camera distance 49 → 11). A pinch zooms back
  out.
- A tap on a card opens no preview and sets no hover.
- A long press on a card, deck or token opens the radial wheel. Lifting the
  finger without travel closes it again.
- A flick from a long press to a wedge runs the verb. Flip was tested.
- A tap on a deck draws nothing. A mouse click on the same deck draws a card.
- A one-finger drag on a table card or token did not lift in 6 out of 6 tries
  on a fresh table. A mouse drag of the same card works.
- A drag out of the hand does take the card out of the hand.
- The two 300 px panes cover 38% of a 390 px screen.

## Inferences

TODO

## Gesture map

TODO

## Slice list

TODO
