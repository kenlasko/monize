---
title: Security detail page jumping to mid-page on a phone (issue 2283)
author: Node
date: 2026-11-19
branch: claude/issue-2283
cost: { minutes: 8, tokens: 94855 }
touches:
  - frontend/src/components/ui/Tabs.test.tsx
  - frontend/src/components/ui/Tabs.tsx
---

## Decided
The jump was the shared `Tabs` component, not the switcher or the chart. Its "bring the selected tab on screen" effect called `button.scrollIntoView({ block: 'nearest' })`, which also scrolls the window, and it ran on mount and whenever the `tabs` prop changed identity. The security page rebuilds `tabs` on every render and remounts everything after the loading spinner, so a security switch or a Price/Value/Return toggle scrolled the page to the tab bar, which sits halfway down on a phone. Fix: set the row's own `scrollLeft` from the two bounding rects, keyed on the selected index (not `tabs`), so a re-render does not undo a sideways swipe.

## Tried and ruled out
Next.js `router.push` scroll handling and `EntitySwitcher` focus: neither moves the page here. Checked in real Chromium (mcr playwright image + `npm i playwright-core` inside it on a static repro page): the old call moved `window.scrollY` by about 400px at 390x844, the new one leaves it at 0.

## Watch out
jsdom has no layout and its `scrollIntoView` is a no-op, so a unit test only catches this by spying on `scrollIntoView` or faking `getBoundingClientRect`. Any `scrollIntoView` in a shared component scrolls every scrollable ancestor, including the page.
