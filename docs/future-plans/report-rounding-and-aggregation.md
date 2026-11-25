# Plan: a report figure is rounded once, from its own components

Executes [`docs/specs/report-rounding-and-aggregation.md`](../specs/report-rounding-and-aggregation.md)
(issue #2384); read the spec first. The task list is
[`report-rounding-and-aggregation-tasks.md`](./report-rounding-and-aggregation-tasks.md).

## Assumptions (verified against the tree, 2026-11-24)

- `FxAggregate` (`backend/src/common/fx-aggregate.ts`) accumulates each
  component at twelve places in a `BigInt` and rounds to four on read
  (`knownSubtotal`, `total`), since issue #2360. `merge` folds another aggregate
  exactly; there was no negated fold and no sign read before rounding.
- `sumMoney` (both layers) rounds every input to four places before it sums;
  it is right for posted amounts at their own precision and wrong for a sum of
  reporting-only conversions or of rounded parts.
- Until stage 2 the backend rounded no report figure at a currency's display
  places: the wire carried four places (`FIAT_MONEY_DECIMALS`), except the
  custom report's transaction list, whose `value` was the unrounded conversion,
  and the client rounded once more for display
  (`useNumberFormat().formatCurrency`). Stage 2 (issue #2410) rounds each report
  figure once on the server at the currency's places.
- No report CSV or PDF is built on the server; the client writes them
  (`frontend/src/lib/csv-export.ts`, `frontend/src/lib/pdf-export-tables.ts`).
- The instruction files are at their byte ceilings
  (`backend/src/common/instruction-files.spec.ts`), so the rule lives in the
  spec and in `docs/financial-calculation-contract.md`; `AGENTS.md` carries
  only "fold parts with `merge`" beside `FxAggregate`.

## Stages

1. **Backend folds and the client accumulator (issue #2384, first PR).** The
   spec's section 5. Observable: the section 4 table; the property specs named
   in the spec's section 8.
2. **The precision of a figure on the wire.** The spec's section 6: option
   (b), each report figure rounded once on the server at the reporting
   currency's own places, chosen on issue #2384, landed by issue #2410.
   Observable: a figure 0.00002 under a cent's midpoint reads the same on
   screen, in the CSV and in the PDF.
3. **Client surfaces.** One PR per group in the task list: each total the client
   builds from rounded rows reads the server's total, chart values rounded to
   whole units stay in the chart, and every export writes the figure the screen
   shows (or the documented export precision) with totals from the server.

## What to run

- Backend: `npx jest src/common/fx-aggregate.spec.ts src/built-in-reports src/reports src/ai`,
  then `npm run test:changed`, lint and both type-checks.
- Frontend: `npm run test -- currency-total` and the components touched, then
  `npm run test:changed`, lint and type-check.
