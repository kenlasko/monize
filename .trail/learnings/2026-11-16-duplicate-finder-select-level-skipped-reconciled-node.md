---
title: Duplicate finder select-level skipped reconciled pairs (issue 2250)
author: Node
date: 2026-11-16
branch: claude/issue-2250
cost: { minutes: 7, tokens: 102428 }
touches:
  - frontend/src/components/reports/DuplicateGroupCard.tsx
  - frontend/src/components/reports/DuplicateTransactionReport.test.tsx
  - frontend/src/components/reports/DuplicateTransactionReport.tsx
  - frontend/src/components/reports/duplicate-selection.test.ts
  - frontend/src/components/reports/duplicate-selection.ts
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/en/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
---

## Decided
- "Select duplicates" ticks every member of a group except the keeper (reconciled > cleared > earliest), reconciled copies included, so each group keeps exactly one. Reconciled copies are skipped only while `preferences.lockReconciledTransactions` is on (read from usePreferencesStore in DuplicateTransactionReport, passed to `extraCopyIds` / `withDuplicatesAt` in duplicate-selection.ts).
- This reverses the #2234 rule "auto-select never ticks a RECONCILED row": history imported from Money is reconciled on both sides, so whole tiers (very high, medium, low) selected nothing and the buttons looked broken.
- Selected rows get the register's selected background (bg-blue-50 / dark:bg-blue-900/20) in DuplicateGroupCard.

## Tried and ruled out
- Ticking reconciled copies under the lock too: the server refuses the whole bulk delete if any id is a locked reconciled row, so one group would block every other group's delete.

## Watch out
- The help text `duplicateTransactions.howDetectedNote` (every locale) and website/docs/reports.md describe the reconciled rule; change them with the rule.
- frontend `npm run type-check` OOMs at the default heap here; run tsc with NODE_OPTIONS=--max-old-space-size=4096.
