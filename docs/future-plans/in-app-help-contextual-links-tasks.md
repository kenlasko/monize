# Tasks: help where the question arises

Task list for `docs/future-plans/in-app-help-contextual-links.md`. Needs plan 2
merged. Check a box only when its gate passes and is quoted in the commit or PR.

## Mechanism (one PR)

- [x] `InfoTooltip` `learnMore?: DocsLink`; the popover stays reachable on hover.
- [x] `EmptyState` `help?: DocsLink`.
- [x] `HelpLink` component; the four existing inline docs links migrated to it.
- [x] Guard: a docs URL only in `HelpLink`, `PageHeader` and `HelpSection`.
- [x] `help` namespace additions: English, pseudo-locale, every locale.
- [x] Unit tests listed in the plan.
- [x] `docs/frontend/ui-conventions.md` entry; `frontend/CLAUDE.md` rows.

## Batches (one PR each; add keys, add missing guide sections)

- [ ] 1. Transactions
- [ ] 2. Currencies
- [x] 3. Investments (issue #2054): `learnMore` on Cost Basis/TWR/MWR and the
  Value Change/Investment Result chart tooltips, a new tooltip on Total
  Amount, and two new guide sections ("Total Amount or Price: Which One
  Wins", "Cash vs. Investment Performance").
- [x] 4. Bills and deposits (issue #2054): `learnMore` in the occurrence
  picker and the override editor, a new tooltip on Funding Account, and an
  extended "Investment Scheduling" guide paragraph.
- [x] 5. Budgets (issue #2054): `learnMore` on Rollover Rules (wizard and
  per-category), Excluded Accounts, and the Spending Velocity heading, plus
  a new "Excluded Accounts" guide section.
- [ ] 6. Rules
- [ ] 7. Import wizard errors
- [ ] 8. Backups and security
- [ ] 9. Empty first-run screens

## Verification (each PR)

- [x] Frontend gates green, quoted (batches 3-5, issue #2054): `npm run
  lint` -- `eslint .` clean; `tsc --noEmit` clean; `npm run i18n:check` --
  pseudo-locale up to date; `npm run docs:build` -- `0 written, 0 removed,
  27 total` after the guide edits; `npx vitest run src/lib/docs-links.test.ts
  src/components/help/HelpMarkdown.test.tsx` -- `135 passed`;
  `src/i18n/messages.parity.test.ts` -- `1867 passed`; `npm run test:changed`
  -- `Test Files 877 passed (877)`, `Tests 16382 passed (16382)`.
