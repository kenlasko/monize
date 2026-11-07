---
title: "help search endpoint adds no new fs read; trail check's 20 flags were lexical"
author: Node
date: 2026-11-07
branch: claude/issue-2050
cost: { minutes: 91, tokens: 614153 }
touches:
  - docs/future-plans/in-app-help-search-tasks.md
  - e2e/tests/help-search.spec.ts
  - docs/frontend/ui-conventions.md
  - frontend/src/components/help/HelpSearchDialog.tsx
  - website/docs/getting-started.html
  - website/docs/getting-started.md
  - website/docs/index.html
  - website/docs/index.md
  - website/docs/search-index.json
  - frontend/src/components/help/HelpPanel.tsx
---

## Decided
- `HelpService.search` and `help-search.ts` (plan 3, Ctrl/Cmd+K search) build their section list from `index`/`options` already parsed in `readBundle()` -- no new `fs` call, no new Bearer fingerprint risk. Confirms the pattern Ken's `2026-11-06-bundled-guide-file-reads-clear-codeql-ken` learning already covers.

## Tried and ruled out
- Treating every `trail check` hit as a real conflict: 19 of 20 flagged on this branch were lexical overlaps (common words like "page", "slug", "title", "request" in docstrings/tests) against learnings about unrelated code (an i18n insertion script, RulesList sorting, a payee-logo cache). Checked each matched line against the learning's actual code pattern before deciding whether to act.

## Watch out
- `website/docs/search-index.json` is also touched by `claude/issue-2054` (pushed 2026-11-06); whichever of the two branches merges second should expect a conflict there and regenerate with `npm run docs:build` rather than hand-resolving the generated JSON.
