---
title: "A category picker row with no icon or colour gets no icon slot at all, not a blank square"
author: Ken
date: 2026-11-20
branch: fix/category-picker-no-blank-icon
cost: { minutes: 2, tokens: 53829 }
id: l-4ec5539a
scope: repo
status: active
replaces: l-30143b
src: agent
touches:
  - frontend/src/components/categories/CategoryPickerIcon.tsx
  - docs/frontend/ui-conventions.md
---

## Decided
- Ken (2026-11-19): in category dropdowns, a category with neither an icon nor a colour (own or inherited) shows no icon space; its name starts at the left edge. This reverses the earlier "fixed square so rows align" choice.
- Everything else from the earlier picker-icon learning stands: `EntitySwitcherItem.icon` / `Combobox` / `MultiSelect` / `IconSelect` option `icon` carry the mark; accounts use `AccountPickerIcon` via `useInstitutionLogos`; payees `payeeOptionIcon` / `withPayeeIcons`; `EntitySwitcher` `tall` for account switchers.

## Tried and ruled out
- Returning null from `CategoryPickerIcon`: the pickers test `option.icon != null`, and a JSX element that renders nothing is still non-null, so the wrapper span and its `gap-2` stay. The option must have no `icon` at all.
- Decorating account `<Select>`s with icons: a native option cannot render one (that is why `AccountSelect` / `IconSelect` exist).

## Watch out
- Build category option icons with `categoryPickerIcon(category)` (returns undefined when there is no mark) or `withCategoryIcons`, never `icon: <CategoryPickerIcon .../>` directly, or the blank slot comes back.
- `useInstitutionLogos` skips setState on an empty list: a resolved `[]` setting a fresh Map caused act() warnings in AccountSwitcher tests.
- Test names with an apostrophe in single quotes break the vitest (oxc) parse; use double quotes.

In the code: frontend/src/components/categories/CategoryPickerIcon.tsx (`categoryPickerIcon`, `withCategoryIcons`); docs/frontend/ui-conventions.md picker-row paragraph.
