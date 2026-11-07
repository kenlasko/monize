---
title: "In-app help batch 5d: rules, import, backups, empty states"
author: Node
date: 2026-11-07
branch: claude/issue-2055
cost: { minutes: 34, tokens: 304785 }
touches:
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/fr/import.json
  - frontend/src/i18n/messages/hi/import.json
  - frontend/src/i18n/messages/id/import.json
  - frontend/src/i18n/messages/it/import.json
  - frontend/src/i18n/messages/ja/import.json
  - frontend/src/i18n/messages/ko/import.json
  - frontend/src/i18n/messages/nl/import.json
  - frontend/src/i18n/messages/pl/import.json
---

## Decided
- Wired the already-merged #2052 mechanism (InfoTooltip.learnMore, EmptyState.help, HelpLink) into four new areas without inventing new patterns: extended `RuleSection` with an optional `learnMore` prop, and `Modal` with an optional `descriptionLearnMore` forwarded into its internal `InfoTooltip`, both additive/opt-in so every other call site is unaffected.
- An import wizard error's docs link is chosen by its error code through one map, `mnyErrorDocsLink` (frontend/src/lib/import-mny-error-docs.ts), used by all three places a Money-import failure renders (UploadStep, MnyReviewStep, MnyImportProgress) instead of each picking its own link.
- Added DOCS_LINKS keys with `section` anchors for rules (if-conditions, order-and-stop-processing, testing-a-rule, running-a-rule-on-existing-transactions), import (CSV mapping, amount sign, OFX, QIF, mny troubleshooting), and backups/security (encrypted-backups, restoring-from-a-backup, backup-codes, plus a new bankSync key) — all target website/docs/*.md sections already existed, so docs-links.test.ts caught any slug mistakes immediately without needing to write new guide content.
- For first-run EmptyState `help` links, added them only to the unfiltered/no-items-yet branch where a component had both a filtered and unfiltered empty variant (e.g. CategoryList, NotificationList, EmailReceiptsManager) — the filtered "no results" variant doesn't get the guide link.

## Tried and ruled out
- Considered skipping the restore-warning's paragraph entirely to avoid any risk of diluting the security warning; instead put the "Learn more" link in its own separate paragraph right after the (unmodified) description, never touching the warning text itself.
- Considered not forwarding `learnMore`/`descriptionLearnMore` through shared components (RuleSection, Modal) to avoid "touching shared/core code without agreement" — but since #2052 already established this exact additive-optional-prop pattern on InfoTooltip/EmptyState, extending it the same way on Modal/RuleSection was treated as in-scope mechanism reuse, not a fresh refactor.

## Watch out
- `npm run test:changed` timed out (>10 min) on this machine when the diff touches widely-imported files like docs-links.ts and Modal.tsx — `vitest related` pulls in a huge chunk of the import graph. Ran targeted `vitest run <files>` per touched component instead, plus the guard tests directly (ui-conventions.test.ts, docs-links.test.ts, messages.parity.test.ts) — all passed. Prefer this targeted approach over test:changed when a change touches a hub file.
- `npm ci` is required before any frontend test/lint/tsc in a fresh worktree — node_modules isn't pre-installed, and `npx vitest` fails confusingly (vitest.config.ts module-not-found) without it.
- i18n translations for en/*.json changes across ~17 locales are faster done with a small Python/Node script patching each locale's JSON in place (preserving existing translated proper nouns like "Importing from Microsoft Money" as untranslated per existing convention) than 17x manual Edit calls.
