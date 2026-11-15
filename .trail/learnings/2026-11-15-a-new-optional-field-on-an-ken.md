---
title: A new optional field on an MCP tool result can be left out of the output schema to stay inside the tools/list byte budget
author: Ken
date: 2026-11-15
branch: feat/bucket-budget
cost: { minutes: 24, tokens: 68021 }
id: l-ab508f49
scope: repo
status: active
src: agent
touches:
  - backend/src/budgets/budget-reports.service.spec.ts
  - backend/src/budgets/budget-reports.service.ts
  - backend/src/mcp/tool-output-schemas.spec.ts
  - docs/system-invariants.md
  - "frontend/src/app/budgets/[id]/page.test.tsx"
  - frontend/src/components/budgets/BudgetCategoryForm.test.tsx
  - frontend/src/components/budgets/BudgetCategoryList.test.tsx
  - frontend/src/components/budgets/BudgetFlexGroupCard.test.tsx
  - frontend/src/components/budgets/BudgetForm.test.tsx
  - frontend/src/components/budgets/BudgetForm.tsx
---

## Decided
- The bucket section of get_budget_status (buckets, bucketIncome, unallocated) is returned but not declared in the tool's output schema. Output schemas are loose objects and the server sends the handler's object unmodified, so undeclared fields still reach the caller and cost no tools/list bytes.
- Ken was told and may still choose to declare them.

## Tried and ruled out
- Declaring a fully typed buckets array: +~570 bytes, over both the per-tool cap (2877 vs 2550) and the total.
- Declaring buckets as untyped rows plus two nullable numbers: clears the per-tool cap but the total lands at 69,542 against 69,369 (173 over).
- Raising the ceiling: it is a reviewed-decision ratchet, the owner's call, not an agent's.

## Watch out
- An MCP client then sees the fields in the result but not in the advertised schema.

In the code:
- backend/src/mcp/tool-output-schemas.ts (getBudgetStatusOutput, unchanged), backend/src/mcp/tools-list-budget.spec.ts (TOTAL_BYTE_BUDGET), backend/src/budgets/budget-reports.service.ts (getLlmBudgetStatus).
