# Quick Add: task list

The task graph for `docs/future-plans/quick-add.md`. All of them ship in one PR.

| ID | Task | Depends on | Status |
| --- | --- | --- | --- |
| B1 | Pure reader `quick-add-parse.util.ts`, vocabulary for every language, the exported amount and date parsers, and their specs | none | Open |
| B2 | `QuickAddInterpretService`, the DTOs, `POST /transactions/quick-add/interpret`, and their specs | B1 | Open |
| F1 | Types, API client, `useQuickAddInterpretation`, `QuickAddDialog` and its chips, and their tests | the contract in the plan | Open |
| F2 | `draft` prop on `TransactionForm`, header button, phone + button, Full Form hand-off, and their tests | F1 | Open |
| F3 | Command palette "Quick add" row, `startQuickAdd`, the page consuming `quickAddRequest`, and their tests | F2 | Open |
| F4 | "The + button opens" setting: `mobileAddOpens` view default on both layers, the Mobile Navigation select, the + button and its fallback reading it, and their tests | F2 | Open |
| Q1 | Code review, adversarial review and security review; fix what they find | B2, F3 | Open |
| Q2 | Every locale's `transactions.json` `quickAdd` strings; `npm run i18n:pseudo` | F2 | Open |
| D1 | `website/docs/transactions.md` "Quick Add" section | F2 | Open |
| D2 | Retake the Transactions screenshots (`npm run docs:screenshots` in `e2e/`, needs the E2E stack) | D1 | Open |
| E1 | Playwright journey: type a line, save it, see the row (needs the E2E stack) | F2 | Open |
