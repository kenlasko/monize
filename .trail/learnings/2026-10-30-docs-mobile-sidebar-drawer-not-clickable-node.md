---
title: docs mobile sidebar drawer not clickable
author: Node
date: 2026-10-30
branch: claude/issue-1958
cost: { minutes: 4, tokens: 95146 }
touches:
  - website/assets/css/docs.css
---

## Decided
The mobile page-list drawer (website/docs, .dside/#side/#shade, assets/js/docs.js)
was visible but unclickable on narrow screens. Root cause: .dlayout
(website/assets/css/docs.css) had `position:relative;z-index:1`, giving it its own
stacking context. The mobile drawer (.dside, position:fixed;z-index:70 under the
<900px breakpoint) is a descendant of .dlayout, so its z-index:70 only ranks against
other children of .dlayout -- it does not escape to compare against .dshade (the
tap-outside-to-close overlay, z-index:65), which is a *sibling* of .dlayout, not a
descendant. Since .dlayout itself only carries z-index:1 at the root level, the
whole layout (including the fixed drawer nested in it) painted and hit-tested
*below* .dshade. The drawer still looked open (shade is a translucent
rgba(3,7,16,.5)), but every tap landed on the shade and just closed the drawer.

Fix: drop `position:relative;z-index:1` from `.dlayout`. Nothing on docs pages
needed it (the decorative `.bgfx` layer it may have been copied from only exists on
the marketing `index.html`, not on `body.docs` pages), so removing it lets the
drawer's own z-index:70 compare directly against `.dshade`'s z-index:65 at the root
stacking context, which is the ordering everything else already assumes.

## Tried and ruled out
Did not touch `.dfoot`'s matching `position:relative;z-index:1` -- that one is
correct as-is: the footer is meant to sit *below* the shade too (tapping over the
footer while the drawer is open should dim/close it, not activate a footer link).
Only `.dlayout` was wrong, because it's the one with a child that needs to escape
upward (.dside) rather than stay pinned down.

## Watch out
Any element with `position:relative`/`absolute`/`fixed` + an explicit `z-index` 
creates a new stacking context, and **any descendant's z-index is scoped to that
context** -- it cannot out-rank a sibling of the ancestor no matter how high the
descendant's own z-index is. When a fixed/absolute overlay inside a positioned
container isn't clickable (or renders in the wrong order) even though its z-index
"should" win, check every ancestor for an unnecessary position+z-index pair before
reaching for an even bigger z-index number, which will not fix it.
