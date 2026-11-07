---
title: "Issue #2051 blocked on unmerged #2050 (help search)"
author: Node
date: 2026-11-07
branch: claude/issue-2051
cost: { minutes: 2, tokens: 122343 }
touches:
  - docs/future-plans/in-app-help-extras.md
  - docs/future-plans/in-app-help-search-tasks.md
---

## Decided
Before implementing plan 4 of in-app-help (docs/future-plans/in-app-help-extras.md,
issue #2051: header help menu, tour/guide cross-links, release-note/assistant
guide links, version stamp, every-page help guard), checked whether its stated
dependency #2050 (help search) is actually merged, since piece A's menu needs
a "Search help" entry wired to it.

## Tried and ruled out
Searched for any trace of #2050 having landed under a different name: no
`/help/search` backend endpoint, no `HelpSearchDialog`, no global `Ctrl/Cmd+K`
listener anywhere in frontend/src. `docs/future-plans/in-app-help-search-tasks.md`
has every box unchecked. The only "search help" hit in the codebase is the
unrelated transaction search-syntax popover in AppHeader.tsx. Confirmed via
`git log --all` that no PR merged anything matching #2050's scope.

## Watch out
Plan 4 (in-app-help-extras.md) explicitly says "Depends on: plan 2 (merged),
and #2050 (search) for the menu's search entry. Queue this once #2050 has
merged." Don't start building piece A's help menu assuming the search entry
exists -- check docs/future-plans/in-app-help-search-tasks.md's checkboxes
first. Also relevant context gathered before stopping: helpStore.ts has no
field yet for "current page's help key" (PageHeader's `help` prop isn't
published anywhere global), so piece A's "Help for this page" entry needs a
new helpStore field set/cleared by PageHeader on mount/unmount. isGuideUrl
(piece C) can be written by parsing href against DOCS_BASE_URL directly
(origin + pathname + hash), no need to reverse-map through DOCS_LINKS keys.
