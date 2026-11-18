---
title: "Mobile swipe stuck part way: touchcancel and the persistent SwipeShell content element (issue #2273)"
author: Node
date: 2026-11-18
branch: claude/issue-2273
cost: { minutes: 11, tokens: 125025 }
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/hooks/useSwipeNavigation.test.ts
  - frontend/src/hooks/useSwipeNavigation.ts
  - frontend/src/hooks/useSwipeToPaginate.test.ts
  - frontend/src/hooks/useSwipeToPaginate.ts
  - frontend/CLAUDE.md
---

## Decided
- The "page stuck ~3/4 visible until reload" on a Pixel PWA came from the swipe hooks listening only for touchend. Android's edge Back gesture (also the notification shade, a call) cancels the touch mid-drag: touchcancel, no touchend, so the inline translateX stayed. SwipeShell's content div outlives the route, so the Back navigation carried the offset onto the next page, and every further edge swipe did the same.
- Fix in both useSwipeNavigation and useSwipeToPaginate: touchcancel and a second finger (touches.length > 1) snap back via a shared-in-effect snapBack/abandon; the effect cleanup resets styles if it drops listeners mid-drag; useSwipeNavigation's layout effect clears inline styles on any route change that has no `swipe-enter` marker.
- Rule written in docs/frontend/ui-conventions.md ("A drag that moves an element ends on touchcancel too"); frontend/CLAUDE.md is ~37 bytes under its ceiling, so no index line was added.

## Tried and ruled out
- Window horizontal scroll: SwipeShell's wrapper is overflow-x-clip and useRetainScrollPosition only restores Y, so it is not the cause.
- Bubbling transitionend from children ends animations early but cannot leave an offset, so it was left alone.

## Watch out
- The touch effect's cleanup runs after the entrance layout effect on a route change; resetting styles unconditionally there would kill the entrance animation. Reset only when the dropped state was 'swiping' (an exit sets state idle before animating).
- In a fresh worktree `npm ci` can stall; `npm ci --prefer-offline --ignore-scripts` finished in 17s. `tsc --noEmit` needs NODE_OPTIONS=--max-old-space-size=4096.
