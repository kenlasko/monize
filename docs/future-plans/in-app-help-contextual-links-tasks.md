# Tasks: help where the question arises

Task list for `docs/future-plans/in-app-help-contextual-links.md`. Needs plan 2
merged. Check a box only when its gate passes and is quoted in the commit or PR.

## Mechanism (one PR)

- [ ] `InfoTooltip` `learnMore?: DocsLink`; the popover stays reachable on hover.
- [ ] `EmptyState` `help?: DocsLink`.
- [ ] `HelpLink` component; the four existing inline docs links migrated to it.
- [ ] Guard: a docs URL only in `HelpLink`, `PageHeader` and `HelpSection`.
- [ ] `help` namespace additions: English, pseudo-locale, every locale.
- [ ] Unit tests listed in the plan.
- [ ] `docs/frontend/ui-conventions.md` entry; `frontend/CLAUDE.md` rows.

## Batches (one PR each; add keys, add missing guide sections)

- [ ] 1. Transactions
- [ ] 2. Currencies
- [ ] 3. Investments
- [ ] 4. Bills and deposits
- [ ] 5. Budgets
- [ ] 6. Rules
- [ ] 7. Import wizard errors
- [ ] 8. Backups and security
- [ ] 9. Empty first-run screens

## Verification (each PR)

- [ ] Frontend gates green, quoted; `docs:check` green when the guide changed.
