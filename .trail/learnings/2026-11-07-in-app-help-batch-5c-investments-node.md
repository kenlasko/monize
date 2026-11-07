---
title: "In-app help batch 5c: Investments/Bills/Budgets Learn More links"
author: Node
date: 2026-11-07
branch: claude/issue-2054
cost: { minutes: 32, tokens: 446567 }
touches:
  - frontend/src/components/budgets/BudgetCategoryForm.tsx
  - frontend/src/components/budgets/BudgetVelocityWidget.tsx
  - frontend/src/components/budgets/BudgetWizardStrategy.tsx
  - frontend/src/i18n/messages/de/budgets.json
  - frontend/src/i18n/messages/en/budgets.json
  - frontend/src/i18n/messages/es/budgets.json
  - frontend/src/i18n/messages/fr/budgets.json
  - frontend/src/i18n/messages/hi/budgets.json
  - frontend/src/i18n/messages/id/budgets.json
  - frontend/src/i18n/messages/it/budgets.json
---

## Decided
- For a tooltip whose label text is short (e.g. "Price per Share"), never embed that exact label phrase inside another InfoTooltip's text: the InfoTooltip button's aria-label equals its full text, and testing-library's getByLabelText(/regex/) then matches both the real field and the unrelated tooltip button, breaking existing tests. Paraphrase instead (e.g. "per-share price").
- Where a component field used NumericInput/Select's built-in `label` prop and needed a learnMore tooltip added beside it, switched to the AccountForm pattern: custom `<div className="flex items-center"><label htmlFor=...>...</label><InfoTooltip .../></div>` above the input, with `label` prop dropped and `id`/`htmlFor` wired manually.
- For an inline "Learn more" sentence inside existing translated prose (not InfoTooltip/EmptyState), used `t.rich('key', { guide: chunks => <HelpLink .../> })` with a `<guide>...</guide>` tag embedded in the message, matching the existing pattern in currencies.json's nonIsoNotice/cryptoPrecisionNotice and CurrencyForm.tsx/UploadStep.tsx -- not a bespoke new key + plain HelpLink appended after the sentence.
- Added DOCS_LINKS keys split by area and committed in 3 separate commits (investments/bills/budgets) per the issue's "one PR, one commit per area" instruction, even though all keys live in one object in docs-links.ts: toggled the other areas' keys out of the file temporarily (Edit), committed, then added them back for the next commit.

## Tried and ruled out
- Running `npm run test:changed` with the default 10-minute Bash timeout: it legitimately takes ~18 minutes when 70+ files (18 locales x 3 namespaces) are touched, because vitest's "related" selection pulls in ~880 of 1266 test files. Re-ran with timeout=1200s and it passed everything; don't treat the first timeout as a real failure for a change this wide.
- Writing a Python script to insert new i18n keys into all 18 locale files by matching anchor text with ambiguous "title"/"rolloverType" substrings: too error-prone since those keys repeat many times per file. Switched to hard line-number anchors (verified identical across all locales first with grep -n) plus an assert on each anchor's content before inserting -- much safer for a mechanical multi-file edit.

## Watch out
- `trail check` flagged 7 "conflicts" that were all false positives: it appears to scan a touched file's *whole current content* against learnings, not just the diff, so pre-existing unrelated content in website/docs/*.html (generated, large, includes nav/content from other unrelated features) can trigger an old "ruled out" learning even though the PR's actual diff never touches it. Verify with `git diff origin/main -- <file>` before treating a trail conflict as real.
- A fresh worktree for this repo needs `cd frontend && npm ci --ignore-scripts` before `npm run docs:build` (fails with ERR_MODULE_NOT_FOUND otherwise) -- consistent with the existing memory note about test:changed.
