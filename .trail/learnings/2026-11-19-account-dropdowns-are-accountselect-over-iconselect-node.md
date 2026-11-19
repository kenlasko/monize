---
title: Account dropdowns are AccountSelect over IconSelect; native account selects are now banned
author: Node
date: 2026-11-19
branch: claude/issue-2288
cost: { minutes: 59, tokens: 354997 }
touches:
  - frontend/src/components/import/CsvTransferRules.test.tsx
  - frontend/src/components/import/CsvTransferRules.tsx
  - frontend/src/components/ui/IconSelect.test.tsx
  - frontend/src/components/ui/IconSelect.tsx
  - docs/frontend/ui-conventions.md
  - e2e/CLAUDE.md
  - frontend/src/test/ui-conventions.test.ts
  - website/docs/accounts.html
  - website/docs/search-index.json
  - website/docs/transactions.html
---

## Decided
- Supersedes the Nov 19 note that ruled out replacing account `<Select>`s: the maintainer chose to replace them (issue #2288). Every account dropdown is `AccountSelect` (components/accounts/shared/AccountSelect.tsx) over `IconSelect` (components/ui/IconSelect.tsx); options come from `buildAccountDropdownOptions` / `accountSelectOption`, which now carry `accountType` and `institutionId` for the mark. `ui-conventions.test.ts` fails on a `Select` or raw `<select>` built from account options.
- IconSelect keeps the form value in a hidden native `<select>` (aria-hidden, tabIndex -1, the caller's ref on it); a pick sets it with the native value setter and dispatches a real `change` event, so `register()` and `e.target.value` callers are unchanged. The visible control is a `combobox` button named by the label, with a portalled listbox, a filter past 8 rows, and Escape that stops propagation.
- A register-only field must also pass `value` (the watched one): the button cannot observe `reset()`/`setValue()` on the hidden select.
- Combobox shows the picked option's icon in the field; MultiSelect options take an `icon` (account filters use `useAccountPickerIcon`).

## Tried and ruled out
- Putting the option label in a `label` attribute instead of text: broke many existing `getByText(<account name>)` tests; kept text children, so only the picked label appears twice.
- Adding a row to frontend/CLAUDE.md: pushes it past its 16 KiB ceiling; the guard test carries the rule.

## Watch out
- Unit tests read/change the hidden select via `src/test/icon-select.ts` (`getSelectByLabel`, `nativeSelectOf`, `selectOptionLabels`); `getByLabelText('Account')` now returns the button. E2E picks via `e2e/helpers/select.ts` `chooseIconSelectOption` (by `data-value`, label or index).
- The error <p> is not inside the button's parent; assert errors with `toHaveAccessibleDescription` (aria-describedby is wired).
- Running E2E here: backend image build OOMs without NODE_OPTIONS=--max-old-space-size=4096 (compose override); scripts/e2e-playwright.sh's `--user` breaks under rootless Docker, so run the pinned image with `docker run` without `--user`. tests/share-target.spec.ts:136 timed out opening the share dialog in this environment, before reaching the account field.
