---
title: "Issue #2051: help menu/tours/guide links/version/guard, and e2e docker OOMs here"
author: Node
date: 2026-11-07
branch: claude/issue-2051
cost: { minutes: 71, tokens: 675852 }
touches:
  - docs/future-plans/in-app-help-extras-tasks.md
  - frontend/src/app/page-help.guard.test.ts
  - frontend/src/components/help/HelpPanel.test.tsx
  - frontend/src/components/layout/AppHeader.tsx
  - frontend/src/components/layout/HelpMenu.test.tsx
  - frontend/src/components/layout/HelpMenu.tsx
  - frontend/src/hooks/useHelpMenuEntries.ts
  - frontend/src/lib/docs-links.test.ts
  - frontend/src/lib/docs-links.ts
  - frontend/src/lib/help-open.ts
---

## Decided
Implemented all five pieces of docs/future-plans/in-app-help-extras.md
(issue #2051) in separate commits: A header Help menu + mobile drawer
entries + keyboard shortcuts dialog (useHelpMenuEntries built once in
AppHeader and passed down, never re-derived by HelpMenu itself --
otherwise a gated tour's useTourRequirements fetch fires twice per
render); B TourDefinition.docs <-> lib/help-tours.ts cross-linking
(tour's last step offers "Read the full guide", the panel offers "Show
me" via tourIdForHelpPage, both gated through isTourOfferable the same
way TourOfferList is); C isGuideUrl (parses an href against the guide's
base URL+origin, never a prefix check a lookalike host would pass) plus
onGuideLinkClick wired into ReleaseNotesMarkdown/AssistantMarkdown; D a
useHelpManifest() hook feeding the panel footer's version stamp; E
page-help.guard.test.ts, scanning ALL of src/ (not just app/**/page.tsx)
for <PageHeader without help, because RuleEditorScreen renders it one
hop from rules/new and rules/[id] rather than in the page file itself.

The guard's own first run found ~26 real pre-existing PageHeader calls
missing help; fixed all but one with 6 new DOCS_LINKS entries
(reconcile, sharedAccess, emergencyAccess, tourSettings, aiSettings,
aiReviewInbox) -- settings-and-security.md and ai.md already had the
matching sections, just no DocsLink key yet. The one real gap
(/src/app/share/page.tsx, Web Share Target intake) is the guard's lone
EXEMPTIONS entry.

Translated the ~21 new keys (help.menu, help.shortcuts,
help.panel.tour/version/latestOnline, navigation.help,
tours.controls.readGuide) into all 18 full locales with a small Node
script that inserts by key-after-key (insertAfter helper), not by
anchor-text matching -- see "Tried and ruled out". Keyboard key names
(Ctrl/Cmd/Esc/Shift) stay in Latin script in every locale.

## Tried and ruled out
- Writing a Python/regex script to insert new i18n keys into all 18
  locale files by matching anchor text like "title" or a nearby label:
  too error-prone, those substrings repeat many times per file.
  Switched to parsing each file as JSON and inserting the new key
  right after a known, unique sibling key (`insertAfter(obj, 'admin',
  {...})`), which can't land in the wrong place.
- Attempted the full e2e Docker stack (docker-compose.e2e.yml, the
  website/README.md screenshot recipe) to retake
  images/navigation-bar.png for the new header `?` icon: the backend
  container's own `nest build` step (TS compile on container start)
  OOMs and the container exits 134 before Playwright ever runs, even
  with nothing else running concurrently. This machine's docker
  containers (6Gi each) plus the shared 10Gi host limit cannot fit the
  e2e backend's build step today. Did not retry with a smaller/tuned
  NODE_OPTIONS inside the compose file -- stopped after one clean
  attempt + teardown rather than risk OOM-killing the whole session.
- A naive regex scan for `<PageHeader\b[^>]*\/?>/gs` to find calls
  missing `help=`: stops at the first `>` inside nested JSX (e.g. a
  `<Switcher ... />` in `titleAdornment`), so it both false-reports
  compliant multi-prop calls as violations and (worse) can silently
  absorb the rest of a file into one "call" if no indentation-matched
  closing line is found. The guard test bounds that lookahead to 60
  lines so an unmatched shape fails loud instead of reading clean.

## Watch out
- `useHelpStore.contextPage` (the slug `PageHeader`'s `help` prop
  resolves to) already existed before this issue started (landed with
  #2050, the search plan) -- don't re-add it.
- `trail check` flags ~20 "conflicts" on this branch that are all
  false positives from whole-file lexical-overlap scanning (same
  pattern as the Nov 7 "in-app-help batch 5c" note): e.g. the word
  "test" + "cover" in this guard's own docstring matches an unrelated
  persisted-storage learning. Verify with `git diff` before treating a
  trail conflict as real on a new guard-test file full of prose.
- `isGuideUrl`'s fragment decode (`decodeURIComponent(url.hash.slice(1))`)
  needs its own try/catch -- a malformed `%` escape in the hash parses
  fine as a URL but throws on decode, and that call sits in a click
  handler with no other catch around it.
