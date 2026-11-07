# Tasks: help search from any screen

Task list for `docs/future-plans/in-app-help-search.md`. Needs plans 1 and 2
merged. Check a box only when its gate passes and is quoted in the commit or PR.

## Backend

- [x] `help-search.ts`: normalisation, prefix on the last token, weighted
      scoring, context boost, synonym table, plain-text excerpt.
- [x] `HelpService.search` and `GET /help/search` with a bounded, whitelisted
      query DTO.

## Backend tests

- [x] Scorer unit tests listed in the plan.
- [x] Real-question fixture: each question's expected section in the top three.
- [x] Controller validation and public-access spec.

## Frontend

- [x] `isEditableTarget` helper and one global listener for `Ctrl/Cmd+K` and `?`.
- [x] `PageHeader` registers its `help` key as the search context.
- [x] `HelpSearchDialog` on `Modal`: empty-query context list, debounced search,
      responses tied to their query, listbox keyboard navigation, Enter opens
      the panel, error state.
- [x] `help` namespace additions: English, pseudo-locale, every locale.

## Tests

- [x] Dialog and listener unit tests listed in the plan.
- [ ] E2E: `?` on Transactions; "backup" search opens Backup and restore.

## Docs

- [ ] User guide mentions the shortcuts.
- [ ] `docs/frontend/ui-conventions.md`: global shortcuts and the editable-target rule.

## Verification

- [ ] Backend and frontend gates green, quoted.
