---
title: "Picker icons: EntitySwitcher/Combobox take an icon; account icons come from useInstitutionLogos"
author: Node
date: 2026-11-19
branch: claude/issue-2288
cost: { minutes: 20, tokens: 206674 }
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/app/investments/page.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/accounts/AssetFields.tsx
  - frontend/src/components/accounts/LoanFeesEditor.tsx
  - frontend/src/components/accounts/LoanPaymentSetupDialog.tsx
  - frontend/src/components/accounts/OverpaymentRecognitionFields.tsx
  - frontend/src/components/accounts/shared/AccountPickerIcon.tsx
  - frontend/src/components/accounts/shared/AccountSwitcher.test.tsx
  - frontend/src/components/accounts/shared/AccountSwitcher.tsx
---

## Decided
- `EntitySwitcherItem.icon` and `Combobox` option `icon` (ReactNode, aria-hidden wrapper) carry the mark. Accounts: `AccountPickerIcon` (InstitutionLogo with AccountTypeIcon fallback, same order as AccountRow). Payees: `payeeOptionIcon` / `withPayeeIcons`. Categories: `CategoryPickerIcon` / `withCategoryIcons` (fixed square so rows align when a category has no icon or colour).
- Account switchers get institution data from `useInstitutionLogos` (institutionsApi.getAll is deduped and cached) rather than threading institutions through every caller.
- `EntitySwitcher` `tall` lets the menu use the viewport's room (placeMenu's 4th arg, Infinity) instead of MENU_MAX_HEIGHT 336; passed by AccountSwitcher, AccountIdentity and the Transactions/Investments collapsed-header switchers.

## Tried and ruled out
- Decorating account `<Select>`s: a native option cannot render an icon; doing it means replacing the Select (react-hook-form register, e2e selectOption specs).

## Watch out
- `useInstitutionLogos` skips setState on an empty list: a resolved `[]` setting a fresh Map caused act() warnings in every AccountSwitcher test that mocks institutions with [].
- Test names with an apostrophe in single quotes break the vitest (oxc) parse; use double quotes.
