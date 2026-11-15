---
title: Compact selects lose to the unlayered global select rule (issue 2222)
author: Node
date: 2026-11-15
branch: claude/issue-2222
cost: { minutes: 13, tokens: 157198 }
touches:
  - frontend/src/components/budgets/BudgetWizardBuckets.tsx
  - frontend/src/components/budgets/BudgetWizardCategories.sort.test.tsx
  - frontend/src/components/budgets/BudgetWizardCategories.tsx
  - frontend/src/components/budgets/BudgetWizardTableHead.tsx
  - frontend/src/components/budgets/utils/wizard-table-sort.test.ts
  - frontend/src/components/budgets/utils/wizard-table-sort.ts
  - website/docs/budgets.html
  - website/docs/budgets.md
  - website/docs/search-index.json
---

## Decided
- The wizard's bucket select keeps `h-7` and overrides with Tailwind v4 suffix-important utilities (`py-0! pl-2! pr-7! text-xs!`). globals.css styles `select` (and the text inputs) outside any cascade layer, so its `py-2`, `text-base` and `padding-right: 2.5rem` beat every plain utility; that is what pushed the text below the 28px box.
- Its width is `max(10rem, calc(<longest label + 1>ch + 2.25rem))` in a CSS variable on a `text-xs` wrapper, so `ch` measures at the select's text size; `max-w-full` lets a long name wrap the select onto its own line.
- Wizard Categories step sorting: per-table `useState` (no persistence), `SortableHeader` with a `default` field meaning the opening order. Category names arrive as "Parent: Child" (one level, built in budget-generator.service.ts), so `compareCategoryPaths` splits on the first ": " and compares parent, then the parent's own row first, then child.

## Tried and ruled out
- Plain `localeCompare` on the full name: it puts a top-level "Taxes Owing" between "Taxes" and "Taxes: Federal" (space collates before ':').

## Watch out
- Any other compact `<Select className="h-7 py-0 text-xs">` has the same bug; check the rendered result, not the class list.
- BudgetWizardCategories.tsx sits at the 800-line ceiling; put new wizard table logic in BudgetWizardTableHead.tsx or utils/.
- Verifying CSS cascade without the stack: compile globals.css with @tailwindcss/postcss from a script inside frontend/, then screenshot a static page with the chromium binary in the mcr.microsoft.com/playwright image (`--headless --screenshot`).
