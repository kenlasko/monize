# Sankey cash flow report

Shipped (v1, issue #1490, which also answered K1 and K2 in section 13) and
kept as the specification: a built-in report that draws where money came from
and where it went over a date range as a flow diagram, income categories into
one Income node, out to expense categories (and their children), to savings
and investment accounts, to debt payments, with what was unspent or drawn
from balances closing the diagram. It reports money and classifies transfer
legs, which no report does outside the tag-key breakdown, so sections 4 to 8
are the specification `docs/financial-calculation-contract.md` section 9 asks
for and section 5 amends INV-REPORT-003.

## 1. Goal

- A new built-in report `cash-flow-sankey` in the `insights` category:
  nodes in four columns (sources, the Income hub, destinations, destination
  children), links weighted by amount in the reporting currency, a legend, a
  table twin, drill-down to Transactions from any node, PDF and CSV export
  through the existing toolbar.
- Every figure comes from one new endpoint. The browser merges small nodes
  into "Other" for drawing only; the table and the totals come from the full
  response (INV-REPORT-002).
- Phones get the table by default; the diagram is available behind the
  toggle.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| Income and expense rows, per currency, complete-or-null | `IncomeReportsService.getIncomeVsExpenses` (`backend/src/built-in-reports/income-reports.service.ts`), `SpendingReportsService.getSpendingByCategory` (`spending-reports.service.ts`) | The SQL shape (VOID exclusion, `parent_transaction_id IS NULL`, the asset-category `NOT EXISTS`, split handling) is the template; the Sankey service composes the same predicates through the shared helpers. |
| What a row is | `investmentExclusionSql`, `reportableTransactionAmountSql` (`backend/src/common/investment-filter.util.ts`) | INV-REPORT-001 on every branch. |
| Net spending | `NET_SPEND_AMOUNT`, `isNetSpending` (`spending-reports.service.ts`) | A category is its signed sum; only categories that net to spending are expense nodes; a category that nets to income appears on the income side. |
| Transfer legs as named flows | `docs/specs/report-tag-key-breakdown.md` sections 2-3, `getTagKeyBuckets` (`income-reports.service.ts`), INV-REPORT-003 | A leg counts once, by its own sign, through the same conversion and completeness path. This plan generalises "named flow" from tag buckets to destination classes (section 5). |
| Account types | `AccountType`, `AccountSubType` (`backend/src/accounts/entities/account.entity.ts`); `ACCOUNT_TYPE_META` (`frontend/src/lib/account-type-meta.tsx`) | The destination class is a function of the counterpart's type (decision 3). |
| Loan payments | `backend/src/accounts/loan-payment-setup.service.ts` | A principal split with `transferAccountId` = loan, an interest split with a category: interest is already an expense; principal becomes a debt-payment flow. |
| Convert before summing | `FxAggregate`, `resolveFxRate` | Per-link buckets; totals null when a pair is missing. |
| Report registration | `builtInReports` (`frontend/src/components/reports/report-definitions.tsx`), `reportComponents` (`frontend/src/app/reports/[reportId]/page.tsx`), `report-definitions.test.ts`, `reports.json` names and descriptions | The most recent full-stack precedent is the Monthly Breakdown report. |
| Report chrome | `ReportToolbarActions`, `ChartViewToggle`, `ChartLegend`, `ChartTooltip`, `IncompleteDataDetails`, `PartialTotal`, `useReportData`, `exportToPdf`, `exportToCsv` | Reused, not copied. |
| Colours | `chartColors` tokens (`frontend/src/lib/chart-colors.ts`), `buildCategoryColorMap` | Category nodes take the category's colour; class nodes take `income`, `expense`, `primary`, `neutral`. |
| Recharts | `recharts` 3.7 ships `Sankey`; nothing imports it today | A lazy-loaded report, so the import costs nothing on other pages. |
| Drill-down | `useTransactionFilters` reads `categoryId`, `accountIds`, `startDate`, `endDate`; `SPECIAL_CATEGORY_FILTER_IDS` (`frontend/src/lib/categoryUtils.ts`) | Today every report builds its own URL (about 56 sites); this report introduces the first shared helper and uses it alone (decision 9). |

## 3. Product decisions

1. **Scope is a set of cash-flow accounts.** The account filter defaults to
   every active account whose type is `CHEQUING`, `SAVINGS`, `CASH`,
   `CREDIT_CARD`, `LINE_OF_CREDIT` or `CRYPTO` and that is not an investment
   sleeve (`DEFAULT_SANKEY_SCOPE_TYPES`; a `CRYPTO` wallet is a banking account
   the reader spends from, `docs/specs/crypto-accounts.md` decision 7).
   Income and expenses are the rows of in-scope accounts. The user can widen
   or narrow it.
2. **A transfer between two in-scope accounts is internal and invisible.**
   Moving money from chequing to a savings account that is also in scope is
   not a flow; the user who wants to see savings as a destination leaves the
   savings account out of scope.
3. **A transfer leg from an in-scope account to an out-of-scope account is
   a flow to a class decided by the counterpart's type:** `SAVINGS`,
   `INVESTMENT` (either sub-type or none), `ASSET`, `OTHER` -> "Savings &
   investments"; `LOAN`, `MORTGAGE`, `LINE_OF_CREDIT` -> "Debt payments";
   `CHEQUING`, `CASH`, `CREDIT_CARD`, `CRYPTO` -> "Other accounts"
   (`classifyCounterpart` in `cash-flow-sankey-assembly.ts`). The destination
   node lists the counterpart accounts under it (depth 2).
4. **A transfer leg into an in-scope account from an out-of-scope account is
   an inflow by the same classes:** "From savings & investments", "Borrowed"
   (from a loan, mortgage or line of credit), "From other accounts". They sit
   beside the income categories on the source side.
5. **A credit-card payment is not a debt payment.** The spending it settles
   was counted as expense on the purchase date. With the card in scope the
   payment is internal (decision 2); with the card out of scope the payment
   is "Other accounts". Only `LOAN`, `MORTGAGE` and `LINE_OF_CREDIT` are
   debt (decision 3). The report's help text says so.
6. **Investment-generated cash legs are not flows.** `investmentExclusionSql`
   drops a BUY's or DIVIDEND's cash leg on every branch, including the
   transfer branches, exactly as the tag-key breakdown does (its I5).
7. **The diagram closes.** `income + inflows + deficit = expenses + outflows
   + unspent`, with exactly one of `deficit` / `unspent` non-zero (truth
   table A). "Unspent" flows out of the hub; "Drawn from balances" flows
   into it. Neither is a transaction; both are the arithmetic residual,
   printed as such.
8. **Uncategorized is a node, not a hidden remainder.** Uncategorized income
   and uncategorized expenses each have a node (the `uncategorized` pseudo-id
   for drill-down).
9. **One drill-down helper.** `buildTransactionsHref({ categoryId?,
   accountIds?, startDate, endDate, categoryType? })` in
   `frontend/src/lib/transactions-href.ts`, used by this report only in this
   plan; migrating the other reports onto it is a separate cleanup.
10. **"Other" is drawing only.** More than `MAX_NODES_PER_COLUMN` (10)
    categories in a column merge into one "Other" node coloured
    `chartColors.neutral` whose tooltip lists what it holds; the table shows
    every category and the totals come from the full response
    (INV-REPORT-002). Depth 2 (child categories) is a toggle, default off.
11. **A phone shows the table.** The Sankey's horizontal layout does not
    reflow; `ChartViewToggle` defaults to `table` below the `sm` breakpoint
    and the user can switch.

## 4. Definitions

- *In scope*: an account in the request's `accountIds` (or the default of
  decision 1).
- *Income row*: an in-scope, non-transfer, non-investment, non-VOID parent
  row (or split line) whose category `is_income`, or an uncategorized row
  with a positive amount, summed by category with `NET_SPEND_AMOUNT`'s
  sign convention inverted; a category that nets negative moves to the
  expense side under its own name (the `isNetSpending` rule, applied
  symmetrically).
- *Expense row*: the complement, summed by category; only categories that
  net to spending.
- *Outflow leg*: a transfer leg (parent with `is_transfer` or a split line
  with `transfer_account_id`) whose own account is in scope, whose
  counterpart account is out of scope, and whose amount is negative;
  classified by decision 3.
- *Inflow leg*: the same with a positive amount; classified by decision 4.
- `unspent = max(income + inflows - expenses - outflows, 0)`, `deficit =
  max(expenses + outflows - income - inflows, 0)`.

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| SANKEY-001 | The diagram closes: `income + inflows + deficit = expenses + outflows + unspent` in scaled integers | Computed once in the service from the same buckets the links are built from; the spec asserts the identity over the fixture matrix; a response where it fails is a 500 with the discrepancy logged, never a drawn diagram. |
| SANKEY-002 | A transfer leg is counted at most once, by its own account's scope and its counterpart's class | The transfer SQL selects legs by `t.account_id IN (scope) AND counterpart.account_id NOT IN (scope)`; both legs of an internal transfer fail the predicate; a leg's amount is its own signed amount. |
| SANKEY-003 | Investment linkage and VOID are excluded on every branch | `investmentExclusionSql` and the VOID predicate appear in the income, expense, outflow and inflow queries; a source-scanning spec asserts the four query builders call the helper (the INV-REPORT-001 guard pattern). |
| SANKEY-004 | A total carries a value only when every link converted | `FxAggregate` per link; `totals.*` null while any pair is missing; `knownTotals` carry the converted part; `missingCurrencies` and `excludedCount` as the other reports. |
| SANKEY-005 | A reduction never reaches a figure | "Other" merging happens in the component over a copy of the links; the table and the summary cards read the unmerged response; `ui-conventions.test.ts` gains a case that the Sankey component imports no aggregation helper. INV-REPORT-002. |
| INV-REPORT-003 (amended) | A transfer leg appears in a report only as a named flow, never inside income, expenses or net | The amendment adds "named flow" = a tag-key bucket's tagged inflows/outflows, or a Sankey destination class. The statement that transfers never enter income or expenses is unchanged. |

## 6. Data contract (new)

### `GET /built-in-reports/cash-flow-sankey`

Query (`CashFlowSankeyQueryDto extends ReportQueryDto`): `accountIds?`
(csv, `@ArrayMaxSize(200)`, UUIDs), `depth?: 1 | 2` (default 1).

```ts
interface CashFlowSankeyResponse {
  startDate: string; endDate: string; currency: string;
  scopeAccountIds: string[];                      // the resolved scope (default echoed)
  nodes: Array<{
    id: string;                                   // stable: 'income:<categoryId>', 'hub', 'expense:<categoryId>', 'child:<categoryId>', 'class:savings', 'class:debt', 'class:other_accounts', 'inflow:savings', 'inflow:borrowed', 'inflow:other_accounts', 'account:<accountId>', 'uncategorized:income', 'uncategorized:expense', 'residual:unspent', 'residual:deficit'
    kind: 'income' | 'hub' | 'expense' | 'child' | 'class' | 'inflow' | 'account' | 'uncategorized' | 'residual';
    label: string; categoryId: string | null; parentCategoryId: string | null; accountId: string | null; color: string | null;
    total: number | null; knownTotal: number;     // in `currency`
  }>;
  links: Array<{ source: string; target: string; amount: number | null; knownAmount: number }>;
  totals: { income: number | null; inflows: number | null; expenses: number | null; outflows: number | null; unspent: number | null; deficit: number | null };
  knownTotals: { income: number; inflows: number; expenses: number; outflows: number };
  missingCurrencies: string[]; excludedCount: number;
}
```

Links are hub-centred: every `income:*`, `inflow:*`, `uncategorized:income`
and `residual:deficit` node links to `hub`; `hub` links to every
`expense:*`, `class:*`, `uncategorized:expense` and `residual:unspent` node;
with `depth: 2`, each `expense:*` links to its `child:*` nodes and each
`class:*` to its `account:*` nodes, and the child links sum to the parent's
link (the parent's own uncategorized-child remainder is a `child` node named
"(no subcategory)").

## 7. Truth tables

### A. Residual

| income + inflows | expenses + outflows | unspent | deficit |
|---|---|---|---|
| 5,000 | 4,200 | 800 | 0 |
| 5,000 | 5,000 | 0 | 0 |
| 5,000 | 5,600 | 0 | 600 |

### B. Transfer leg classification (scope = {chequing, credit card})

| leg account | counterpart | counterpart type | sign | node |
|---|---|---|---|---|
| chequing | savings (out of scope) | SAVINGS | - | `class:savings` |
| chequing | investment cash sleeve | INVESTMENT / INVESTMENT_CASH | - | `class:savings` |
| chequing | mortgage | MORTGAGE | - (principal split) | `class:debt` |
| chequing | credit card (in scope) | CREDIT_CARD | - | none (internal) |
| chequing | other chequing (out of scope) | CHEQUING | - | `class:other_accounts` |
| chequing | crypto wallet (out of scope) | CRYPTO | - | `class:other_accounts` |
| chequing | savings (out of scope) | SAVINGS | + | `inflow:savings` |
| chequing | line of credit (out of scope) | LINE_OF_CREDIT | + | `inflow:borrowed` |
| credit card | chequing (in scope) | CHEQUING | + | none (internal) |
| chequing | brokerage BUY cash leg | (investment-linked) | - | none (SANKEY-003) |

## 8. Numerical example

Scope {chequing}; September 2026; CAD reporting currency.

| Row | Account | Category / counterpart | Amount |
|---|---|---|---|
| 1 | chequing | Salary (income) | +5,000.00 |
| 2 | chequing | Groceries | -620.00 |
| 3 | chequing | Groceries (refund) | +20.00 |
| 4 | chequing | Mortgage payment, split: principal -> mortgage (transfer) / Interest (category) | -900.00 / -700.00 |
| 5 | chequing | -> savings (transfer, out of scope) | -1,000.00 |
| 6 | chequing | (uncategorized) | -45.00 |
| 7 | chequing | Dining, 50.00 USD at 1.35 | -67.50 CAD |

Nodes: `income:Salary` 5,000.00; `expense:Groceries` 600.00 (netted);
`expense:Interest` 700.00; `expense:Dining` 67.50; `uncategorized:expense`
45.00; `class:debt` 900.00; `class:savings` 1,000.00; `residual:unspent`
`5000 - (600 + 700 + 67.50 + 45) - (900 + 1000) = 1,687.50`. SANKEY-001:
`5000 + 0 + 0 = 1412.50 + 1900 + 1687.50`. With no USD->CAD rate for row 7:
`expense:Dining` `total` null, `knownTotal` 0, `totals.expenses` null,
`knownTotals.expenses` 1,345.00, `missingCurrencies: ["USD"]`,
`excludedCount: 1`; the residual is null too, and the diagram draws the
known links under the incomplete banner.

## 9. Missing-data policy

- A missing rate: SANKEY-004; the banner names the pair and the count; the
  residual is null and its node is drawn hollow with "unknown".
- A counterpart the reader cannot see (a transfer leg whose linked row was
  deleted, was never linked by an import, or is the other owner's leg of a
  cross-owner transfer): the leg is classified by the counterpart row if it
  is visible; otherwise it is an outflow to `class:other_accounts` under
  `account:unlinked`, labelled "(unlinked account)", so the identity still
  closes. The label is neutral because the report cannot tell those cases
  apart.
- No rows in the range: an `EmptyState` with the range, not an empty SVG.
- A category with both signs netting to zero: no node; the table shows it
  with 0.

## 10. Frontend structure

- `frontend/src/components/reports/CashFlowSankeyReport.tsx`: `useReportData`
  over `builtInReportsApi.getCashFlowSankey`; `ChartViewToggle` with `sankey`
  and `table`; the `Sankey` from recharts with custom `node` and `link`
  renderers (`chartColors` tokens and the category colour map; no hex);
  `ChartTooltip` with `formatCurrency`; the "Other" merge in
  `sankey-layout.ts` (pure, tested, returns a new array); `ChartLegend`;
  summary cards from `totals` / `knownTotals` through `PartialTotal`;
  `IncompleteDataDetails`; `ReportToolbarActions` with `onExportPdf`
  (`exportToPdf` over the chart container) and `onExportCsv`
  (`exportCsvSections` of nodes and links); node click ->
  `buildTransactionsHref`. v1 limitation: a class or inflow node
  (`class:*`, `inflow:*`) drills to every transfer of the scope
  (`categoryId=transfer`), which includes the internal transfers the
  diagram hides and the other classes' legs, and it misses a split's
  transfer line (a mortgage payment's principal), because the `transfer`
  filter reads the parent row's own transfer flag; Transactions has no
  counterpart-type filter to narrow it or split-line filter to widen it. A
  "(no subcategory)" node has no drill-down: the category filter always
  includes descendants, so it would list the whole parent. An unknown
  figure with no converted part is drawn as a hollow sliver whose tooltip
  says "unknown". An `account:*` node drills to that
  account's transfers. A subcategory that nets to a refund is drawn
  parent -> child with a "net refund" marker, the reverse of the response's
  link, so recharts' column layout sees no cycle.
- The report keeps its range, depth, view and account scope in this browser's
  localStorage (`SANKEY_STORAGE_KEYS`), settings only, never a figure. The
  diagram, its renderers, tooltip and drill-down live in
  `CashFlowSankeyDiagram.tsx`, shared with the `cash-flow-sankey` dashboard
  widget (`frontend/src/components/dashboard/CashFlowSankeyWidget.tsx`), which
  offers the same settings through its widget config and reads the same
  endpoint.
- `frontend/src/components/reports/sankey-layout.ts` + `.test.ts`: the
  merge, `MAX_NODES_PER_COLUMN`, the mapping from the response's hub-centred
  links to recharts' `{ nodes, links }` with index references.
- `frontend/src/lib/transactions-href.ts` + `.test.ts` (decision 9).
- `report-definitions.tsx` entry `{ id: 'cash-flow-sankey', category:
  'insights', color: 'bg-teal-500' }`, the lazy entry in `reportComponents`,
  `reports.json` name and description, `report-definitions.test.ts` green.
- `frontend/src/lib/built-in-reports.ts` and `frontend/src/types/built-in-reports.ts`.
- A table twin with `role="table"` is the screen-reader rendering; the SVG
  gets `role="img"` and an `aria-label` that states the totals.

## 11. Test matrix

| Area | Cases |
|---|---|
| Scope | default scope resolves to the five types minus sleeves; explicit `accountIds`; a closed account excluded by default and included when named |
| Income and expense | category nets (refund); a category netting to income appears on the income side; uncategorized both signs; split lines by category; `is_income` child under an expense parent; depth 2 children sum to the parent |
| Transfers (SANKEY-002) | truth table B, every row; both legs of an internal transfer invisible; a split principal leg; the counterpart leg of an out-of-scope account never counted twice when the user widens the scope to include it (it becomes internal) |
| Exclusions (SANKEY-003) | VOID rows; BUY and DIVIDEND cash legs; the asset-category `NOT EXISTS`; the guard's source scan |
| Identity (SANKEY-001) | truth table A; the numerical example; random fixtures (property test over 200 generated ledgers) |
| FX (SANKEY-004) | the example's missing-rate case; a rate present on the row (INV-FX-002); a stale rate beyond `FX_MAX_RATE_AGE_DAYS` |
| Reduction (SANKEY-005) | 14 categories -> 10 + Other in the drawing, 14 in the table; totals unchanged; the `ui-conventions` case |
| Component | loading, empty, diagram, table, legend, tooltip formatting through `useNumberFormat`, phone defaults to table, PDF and CSV handlers call the shared helpers, node click builds the right href (category, class, uncategorized, residual has no link) |
| E2E | open the report for the demo data, toggle depth, click a category node, land on Transactions filtered |

## 12. Explicit v1 scope cuts

- No payee-level sources (Income by Source groups by category today; a
  payee column is a follow-up on that service, not here).
- No month-by-month animation or comparison; the range is one period.
- No tag-key breakdown of the Sankey (the two named-flow models are not
  composed in v1).
- No custom-report view type `SANKEY`; the custom report builder's
  `ReportViewType` is unchanged.
- No migration of the 56 existing drill-down URL sites onto
  `buildTransactionsHref` (decision 9).

## 13. Open questions (answered)

Both were answered as the plan proposed: **K1**, the default scope includes
`SAVINGS` and the report's help text documents the lever; **K2**, a credit-card
payment is "Other accounts" when the card is out of scope and internal when it
is in scope.

The catalog admits the five invariants of section 5 as `INV-SANKEY-001` to
`INV-SANKEY-005` in `docs/system-invariants.md`.

- **K1.** Should the default scope include `SAVINGS`? Including it makes a
  chequing-to-savings transfer internal and hides saving; excluding it shows
  saving but counts interest earned in savings as out-of-scope income. This
  plan includes it (decision 1) and documents the lever; the maintainer may
  prefer the opposite default.
- **K2.** Should credit-card payments be a debt flow after all when the
  card is out of scope? This plan says "Other accounts" (decision 5) to
  avoid double counting; a user who wants to see card payments as a flow
  takes the card out of scope and reads that node.

## 14. Follow-ups

- **M1 (optional, separate proposal).** Migrate the other reports' drill-down
  URLs onto `buildTransactionsHref` (decision 9): replace the per-report
  `URLSearchParams` and template-string sites, one report per PR, shrink-only
  against a baseline listing the current sites.
