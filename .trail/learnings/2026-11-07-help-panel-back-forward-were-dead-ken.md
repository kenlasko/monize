---
title: "Help panel: Back/Forward were dead by rule, resizable width, and the scrollbar report that did not reproduce"
author: Ken
date: 2026-11-07
branch: fix/help-panel-desktop
id: l-55f17514
scope: repo
status: active
src: agent
touches:
  - frontend/src/store/helpStore.ts
  - frontend/src/store/helpWidthStore.ts
  - frontend/src/components/help/HelpPanel.tsx
  - frontend/src/components/layout/SwipeShell.tsx
  - frontend/src/components/ai/AiChatBubble.tsx
  - e2e/tests/help-panel.spec.ts
---

## Decided
- Back and Forward were not broken mechanically: the buttons are enabled and hit-testable in Chromium and Firefox once there is history. The defect was the store rule that a move to another section of the page on screen REPLACED the entry. A table-of-contents click, an in-page link or a second help icon naming a section of the same page therefore never added history, and the arrows stayed disabled through a whole visit. Every move to a different page or section now pushes; the same target only rescrolls.
- The docked width lives in its own persisted store (`helpWidthStore`, key `monize-help-width`), not in `helpStore`, which stays unpersisted. The shell (which also renders /login) imports it, so the guard needed proof that importing writes nothing before login; a new case in persisted-storage.guard.test.ts pins that, and the pre-login footprint is unchanged.
- The width is clamped on every read (`useHelpPanelWidth`), never written back, so a window that shrinks and grows returns the reader's chosen width. The shell passes it to CSS as `--help-panel-width` read by the literal class `xl:pr-(--help-panel-width)`.
- Where the browser draws overlay scrollbars the panel's scroller is inset 16 px (`scrollbarsOverlay()`, a hidden scroll-box probe).

## Tried and ruled out
- Reproducing "the panel's scrollbar is hidden behind the main scrollbar" with classic scrollbars: in Chromium without `--hide-scrollbars` (viewports 1100 to 1920) the fixed panel's right edge equals `documentElement.clientWidth`, its scrollbar is inside that, and a point on it hits the scroller. The `100vw` and "under the page scrollbar" theories do not hold for a fixed element. The overlay-scrollbar reading is a hypothesis: Firefox in the Playwright image draws overlay scrollbars (innerWidth equals clientWidth) but nothing there shows the stacking, and `--enable-features=OverlayScrollbar` and `GTK_OVERLAY_SCROLLING=0` changed nothing in Chromium and Firefox. If the owner still sees it, ask whether their Windows scrollbars are classic.
- Re-rendering the guide on every pointer move: a 46,000 px Markdown page made a Firefox drag time out the E2E; `HelpMarkdown` is memoised.

## Watch out
- Headless Chromium passes `--hide-scrollbars`; `launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] }` must be top-level in a spec file (not in a describe) to get classic scrollbars.
- jsdom reports `clientWidth` 0, so the viewport hook falls back to `innerWidth` (1024); a width test above 716 px needs a stubbed width.
- An `afterEach` that sets a store the mounted panel reads fires an act() warning, because RTL cleanup runs after it.

In the code:
- frontend/src/store/helpStore.ts (moveTo), frontend/src/store/helpWidthStore.ts
- frontend/src/components/help/HelpPanel.tsx, HelpResizeHandle.tsx, useHelpPanelWidth.ts, help-layout.ts, scrollbar-gutter.ts
- frontend/src/components/layout/SwipeShell.tsx, frontend/src/components/ai/AiChatBubble.tsx
- e2e/tests/help-panel.spec.ts
