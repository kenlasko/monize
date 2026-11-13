---
title: "Custom reports: a transfer leg converts at its transfer's posted amounts (#2150)"
author: Node
date: 2026-11-13
branch: claude/issue-2150
cost: { minutes: 19, tokens: 184202 }
touches:
  - backend/src/reports/report-net-cells.spec.ts
  - backend/src/reports/report-net-cells.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - backend/src/reports/transfer-counterpart.spec.ts
  - backend/src/reports/transfer-counterpart.ts
  - backend/test/integration/report-custom-transfer-fx.integration.spec.ts
  - docs/system-invariants.md
  - website/docs/reports.html
  - website/docs/reports.md
---

## Decided
- A foreign transfer leg in a custom report converts at the two posted amounts when the other side posted in the reporting currency (`backend/src/reports/transfer-counterpart.ts`). The amounts win over the incoming leg's stored rate, because an explicit toAmount is never cross-checked against it.
- The other side comes from same-owner left joins on the report's own fetch (`linkedTransaction`, `linkedTransaction.splits` ON linkedSplits.linkedTransactionId = transaction.id, and `splits.linkedTransaction`), so the filters never hide it and it never becomes a row. A link that does not point back, a cross-owner counterpart, or two currencies that are both not the reporting one fall back to the market rate.
- `RowConverter.convert(amount, row, split?)`: `NetLine.split` carries the split so a transfer line finds its own counterpart. A split counterpart reads the parent's LINE, never the parent's whole amount.
- Rows whose every line converts this way are dropped from `buildConverter`'s rows, so they do not widen the rate-index span.

## Tried and ruled out
- Expressing it as an `own_rate` (|sent|/|received|): `amount / own_rate` gives -89.99999999999999, and the NONE list does not round its values.

## Watch out
- Not fixed, left for a follow-up: the built-in reports, the Cash Flow Sankey and TransactionAnalyticsService still convert transfer legs at the market rate.
- In an integration fixture a transfer split line needs `kind: SplitKind.TRANSFER`, or `chk_split_kind_exclusive` rejects it.
