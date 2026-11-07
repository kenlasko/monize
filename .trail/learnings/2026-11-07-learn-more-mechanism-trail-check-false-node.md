---
title: "Learn more mechanism: trail check false positives"
author: Node
date: 2026-11-07
branch: claude/issue-2052
cost: { minutes: 27, tokens: 353283 }
touches:
  - frontend/src/components/accounts/AccountForm.tsx
  - frontend/src/components/currencies/CurrencyForm.tsx
  - frontend/src/components/currencies/CurrencyList.tsx
  - frontend/src/components/import/UploadStep.tsx
  - frontend/src/components/settings/payee-lookup/PayeeLookupSection.tsx
  - frontend/src/components/ui/EmptyState.test.tsx
  - frontend/src/components/ui/EmptyState.tsx
  - frontend/src/components/ui/InfoTooltip.test.tsx
  - frontend/src/components/ui/InfoTooltip.touch.test.tsx
  - frontend/src/components/ui/InfoTooltip.tsx
---

## Decided
Added the in-app-help "Learn more" mechanism (issue #2052): `InfoTooltip.learnMore`,
`EmptyState.help`, and the shared `HelpLink` component, plus a source-scanning
guard restricting `docsUrl`/`DOCS_BASE_URL` use to `HelpLink`, `PageHeader`,
`HelpSection` and `HelpMarkdown`.

## Tried and ruled out
N/A — this is the first PR of docs/future-plans/in-app-help-contextual-links.md;
link batches land in follow-up PRs.

## Watch out
`trail check` flagged 5 conflicts against unrelated learnings (InsightsWidget's
empty-state button, the help panel's scroll-to-section mechanism, Table column
widths, ListTopToolbar paging props). All five are false positives: this PR
never touches InsightsWidget, the panel's scroll implementation, Table.tsx or
ListTopToolbar — the matches are keyword/semantic overlap ("button", "panel",
"section") with code that just happens to open the same help panel. Verified by
reading each flagged learning against the actual diff lines.
