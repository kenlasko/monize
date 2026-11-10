---
title: "MCP tag tools (issue 2094): tag edits, tag cards, split-tag carry"
author: Node
date: 2026-11-10
branch: claude/issue-2094
cost: { minutes: 27, tokens: 124617 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en-US/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
- Owner approved (issue #2094): raise tools-list-budget TOTAL by the measured bytes of list_tags/manage_tags/manage_transactions growth (not trim); split-line tag add/remove is a follow-up; no "replace all tags".
- Tag changes on transactions are manage_transactions update fields (addTagNames/removeTagNames); manage_tags only does tag CRUD by name through TagToolPrepService; MCP commits an approved tag card via AiActionsService.commitApproved (no second executor).
- Every commit of an approved edit maps the signed descriptor through updateTransactionCommitArgs / updateTransferCommitArgs (ai/actions/edit-commit-args.ts). The MCP bulk and per-card commits had silently dropped splits before.
- A transfer's tag change runs inside the transfer write via TransferEditHook (transaction-transfer.service.ts), so a refused tag rolls back the whole edit.
- A tag-only edit is signed tagsOnly (decided by value difference, not field presence) and commits dto {}, so the card snapshot never overwrites a concurrent edit.

## Tried and ruled out
- Applying transfer tags after transferService.updateTransfer in a second withScopedDb: not atomic (review finding).
- Stripping markup from every tag name: breaks matching of legacy stored names with < or >; only a name the write creates is stripped.
- delete_tag count from getUsage: misses void and future rows that also lose the tag; the card counts carrying rows (tagCarriedCount).

## Watch out
- Install with `npm ci --ignore-scripts` skips frontend patch-package, and src/test/next-body-streams.test.ts then fails. Run `npx patch-package` before trusting the suite.
- Local `main` in worktrees can be stale; use origin/main for diffs and locale comparisons.
- Backend locale catalogs use different words from the frontend ai.json (de Etikett/Buchung, nl label, fr opération); match each catalog's own words.
- The loan-payment-frequency guard fails outside UTC; run backend specs with TZ=UTC.
