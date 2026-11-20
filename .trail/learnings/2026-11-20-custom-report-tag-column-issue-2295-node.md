---
title: Custom report Tag column (issue 2295)
author: Node
date: 2026-11-20
branch: claude/issue-2295
cost: { minutes: 20, tokens: 159461 }
touches:
  - backend/src/reports/dto/execute-report.dto.ts
  - backend/src/reports/entities/custom-report.entity.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - frontend/src/components/reports/ReportChart.test.tsx
  - frontend/src/components/reports/ReportChart.tsx
  - frontend/src/types/custom-report.ts
---

## Decided
- Backend TableColumn enum (custom-report.entity.ts) was missing TAG even though the frontend enum already had it, so saving any report with a Tag column threw the @IsEnum rejection quoted in issue #2295. Fix: add TAG to the backend enum; the DTO's @IsEnum(TableColumn) picks it up automatically.
- AggregatedDataPoint (both layers) gets a new `tags?: string` field: the row's tag names joined with ", ". aggregateNoGrouping computes it per row via a new formatLineTags(tx, splitTags?) helper, merging the parent transaction's tags with a split line's own (same merge aggregateByTag already does for grouping by tag). sortData gets a TAG case: plain localeCompare, like CATEGORY/ACCOUNT.
- ReportChart.tsx: getColumnMap's TAG entry wrongly read item.label (a leftover placeholder) instead of item.tags, and the TABLE view's header/body/footer JSX never rendered a Tag column at all (getColumnMap having it made CSV/PDF exports silently work once columns included it, but the on-screen table dropped it). Added Th/body td/footer blank cell for TAG, placed after COUNT (end of the fixed column order) rather than near CATEGORY/ACCOUNT, to keep the test assertions on lastElementChild simple like the ACCOUNT_AMOUNT/ORIGINAL_AMOUNT tests.
## Tried and ruled out
- Placing the Tag column next to CATEGORY/ACCOUNT in the JSX (more intuitive grouping): works fine functionally, but breaks the lastElementChild-based test pattern used for ACCOUNT_AMOUNT/ORIGINAL_AMOUNT since the table's on-screen column order is a fixed JSX sequence, independent of the tableColumns array order the user picked (CSV/PDF export order does follow the array order, so there's already a visible-order vs export-order split in this component).
## Watch out
- Headers in ReportChart.tsx are hard-coded English strings (not i18n'd) for every transaction column except ACCOUNT_AMOUNT/ORIGINAL_AMOUNT (previously noted by Node's learning); the new Tag header follows the hardcoded-English majority pattern, not the translated one.
