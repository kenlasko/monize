# Report breakdown by tag key

Approved specification for letting the built-in reports optionally break their
figures down by the VALUE of a single `KEY:VALUE` tag key (e.g. `scope`), and
for making tagged transfers visible in that breakdown without turning a transfer
into income. Written before the implementation, per
`docs/financial-calculation-contract.md` section 9.

Approved to build: discussion
[kenlasko/monize#1381](https://github.com/kenlasko/monize/discussions/1381)
(`approved-to-build`). The tag primitive, the `KEY:VALUE` naming convention
(`backend/src/tags/tag-key-value.util.ts`, `frontend/src/lib/tag-key-value.ts`),
the tag-key filter clause (`backend/src/transactions/tag-key-filter.util.ts`) and
the value-aggregation precedent
(`TransactionAnalyticsService.getTransactionBreakdownByTagKey`) all already
exist; this feature wires a tag-key dimension into the built-in reports and adds
the transfer-visibility rule.

## 0. Why a tag, not a redefinition of income

The reporter is retired and funds daily life by moving money out of registered /
investment accounts into a checking account. Those movements are transfers, so
"Income vs Expenses" shows zero income against real expenses. The rejected fix
was to reclassify the withdrawal as income: a salary of 100 that is invested and
later withdrawn would then read as 200 of income (the maintainer's
counterexample). The accepted fix keeps categories describing financial meaning
and adds tags describing flow/context: the withdrawal stays a transfer, is
tagged (e.g. `scope:household`), and the report gains an opt-in view that slices
by tag value and shows tagged transfer flows **as their own figure, never folded
into income**.

## 1. The dimension

A report gains one optional query parameter, `tagKey` (a bare tag key such as
`scope`). Its presence is the only switch:

- **`tagKey` absent -> the report is byte-for-byte what it is today.** No new
  rows, no new fields, no changed numbers. This is a mechanical guard
  (section 9), not a claim.
- **`tagKey` present -> the report returns the same answer partitioned by the
  values of that key**, plus the tagged-transfer figure defined in section 3.

Tag keys are discovered client-side from `GET /tags` via `collectTagKeys`
(already how `CategoryTagBreakdownPanel` populates its selector); no new
discovery endpoint is added. The server treats `tagKey` as an opaque,
case-insensitive key string and never trusts a client-supplied value list.

### 1.1 Value buckets

For key `K`, every base row is attributed to the value(s) of its own `K:<value>`
tags, parsed by the same SQL the filter clause uses
(`POSITION(':' IN name) > 1`, key = `SPLIT_PART(name,':',1)` trimmed, value =
text after the first colon trimmed, non-empty). Rules:

| # | Rule |
|---|---|
| B1 | A row tagged `K:v` contributes to bucket `v`. A row carrying two `K:*` tags (`K:a`, `K:b`) contributes to **both** `a` and `b`; per-value shares therefore can sum past 100%, exactly as `getTransactionBreakdownByTagKey` already documents. This is disclosed in the UI, not silently summed into a misleading total. |
| B2 | A row with no `K:*` tag contributes to a single reserved bucket, the **untagged** bucket (stable id, not a value a user can create; see section 6 for its label). |
| B3 | The **All** bucket is the report computed over the same base rows with no tag partition. `All` equals today's report exactly (it is the same query without the tag join); it is the reconciliation anchor, not the sum of the value buckets (which double-count multi-valued rows). |
| B4 | Attribution reads BOTH transaction-level tags (`transaction_tags`) and split-level tags (`transaction_split_tags`), matching `buildTagKeyFilterClause`; a split-level tag attributes that split's own amount, a transaction-level tag attributes the reportable amount of the whole transaction. A tag present at both levels attributes once (no leg is counted twice). |

## 2. Invariants

| # | Invariant |
|---|---|
| I1 | **Opt-in is inert by default.** With no `tagKey`, every built-in report in scope returns a response deep-equal to its pre-feature response for the same inputs. Guarded by a snapshot/parity spec per report (section 9). |
| I2 | **A tagged transfer is never income, an expense, or net.** In every value bucket and in All, `income`, `expenses` and `net` are computed from exactly today's base rows (categorized cash, transfers excluded). Tagged transfer flows are a separate, separately-named figure (`taggedInflows` / `taggedOutflows`) and are never added into income, expenses or net. INV-REPORT-003. |
| I3 | **Each leg counts once, under its own tags.** A transfer leg contributes to `taggedInflows[v]` if its reportable amount is > 0 and it carries `K:v`, to `taggedOutflows[v]` if < 0, under each value `v` of its own `K:*` tags. The two legs of one transfer are two rows; each is judged on its own tags and sign. No leg is counted in two buckets of the same value, and the parent/leg dedupe of B4 applies. |
| I4 | **The completeness model is preserved per bucket.** Each bucket keeps the existing FX-completeness discipline: a value converted through a missing rate is excluded, `missingCurrencies` lists the offending codes, `excludedCount` counts the excluded aggregate rows, and a bucket's `totals` are `null` while that bucket is incomplete (`knownIncome`/`knownExpenses`/`knownNet` still carry the partial). Completeness is per bucket; one incomplete value does not blank another. `docs/financial-calculation-contract.md` s.1.3. |
| I5 | **Investment linkage exclusion is unchanged.** `investmentExclusionSql` / `reportableTransactionAmountSql` still decide investment membership on every base row and every transfer-flow row; the tag dimension never reintroduces a brokerage sleeve or an investment cash leg. INV-REPORT-001. |
| I6 | **VOID rows never contribute**, to any bucket or to tagged flows (`status != 'VOID'` stays on every branch). A VOID tagged transfer moves no money and appears nowhere. INV-TRANSFER-001. |
| I7 | **The tag clause does not inflate aggregates.** Split-tag matching keys on `transaction.id` (as `buildTagKeyFilterClause` does), so joining the tag dimension into a `GROUP BY` query never multiplies a row's amount by its split or tag count. Guarded by a fan-out numeric test (a transaction with two matching split tags is not double-summed). |

### INV-REPORT-003 (new)

```text
Statement   A transfer appears in a report only under an explicit tag-key
            breakdown (tagKey set), only in a dedicated tagged-flows figure
            (taggedInflows / taggedOutflows), and never in the report's income,
            expenses or net. Without tagKey, every report excludes transfers
            exactly as before.
Mechanism   The transfer-flow subquery is emitted only when tagKey is present
            and writes only the taggedInflows/taggedOutflows fields; the
            income/expenses SQL keeps is_transfer = false and the split
            transfer-leg exclusion on every branch. A parity spec proves the
            no-tagKey response is unchanged; a numeric spec proves a tagged
            transfer lands in taggedInflows and not in income.
Status      enforced (once this feature ships)
```

**Amended (Cash Flow Sankey).** The named-flow model is shared: a "named flow"
is a tag-key bucket's tagged inflows/outflows **or** a Cash Flow Sankey
destination class (`docs/specs/sankey-cash-flow.md` section 5). The
statement that a transfer never enters income, expenses or net is unchanged.
The catalog entry is `docs/system-invariants.md` INV-REPORT-003.

## 3. Tagged transfer flows (Income vs Expenses / Cash Flow only)

Only the income/expense reports carry a transfer-flow figure; the
category-oriented reports (Spending by Category, Income by Source) have no
transfer rows to show, so they gain only value partitioning (section 5).

When `tagKey=K` is set, `getIncomeVsExpenses` additionally computes, per period
bucket and per value `v`:

- `taggedInflows[v]`  = SUM over transfer legs where the reportable amount > 0,
  the leg (or its parent) carries `K:v`, the leg is not VOID, and it is not an
  investment linkage row.
- `taggedOutflows[v]` = SUM over the same population where the reportable
  amount < 0, taken as a positive magnitude.

A transfer leg here is a row with `is_transfer = true` (parent) or a split with
`transfer_account_id IS NOT NULL`; the reportable amount is the leg's own signed
amount (destination legs are positive, source legs negative). These figures ride
the SAME per-currency conversion and completeness path as income/expenses, so a
missing rate blanks the bucket's totals (I4) rather than silently dropping a
flow.

### 3.1 Truth table -- one self-transfer, both legs tagged `scope:household`

RRSP cash sleeve (ordinary cash) -> Checking, 1,000, both legs tagged
`scope:household`, `tagKey=scope`, value bucket `household`:

| Figure | Value | Why |
|---|---|---|
| `income` (household, All) | +0 | A transfer is never income (I2). |
| `expenses` (household, All) | +0 | A transfer is never an expense (I2). |
| `net` | 0 | Unchanged from today. |
| `taggedInflows[household]` | +1,000 | The Checking leg is a positive transfer leg tagged `scope:household` (I3). |
| `taggedOutflows[household]` | +1,000 | The RRSP-sleeve leg is a negative transfer leg tagged `scope:household` (I3). |

The reader sees, under `household`, that 1,000 flowed in and 1,000 flowed out --
the honest picture. It does not read as 1,000 (or 2,000) of income. The UI
mirrors a transfer's tags onto BOTH legs (`syncTransferTags` in
`backend/src/transactions/transaction-bulk-update.service.ts`, and the rules
applier), so a user cannot tag only the destination leg. The way to see one side
is the account filter of section 10: scoping the report to the destination
account leaves only that account's leg in the figure. The report reflects
whatever is tagged inside the chosen accounts and never invents a one-sided
number the tags do not assert.

### 3.2 Truth table -- the maintainer's double-count case

Salary 100 categorized Income (not a transfer); later moved to a brokerage
(transfer, tagged `scope:household`); later withdrawn to Checking (transfer,
tagged `scope:household`). `tagKey=scope`, bucket `household`:

| Figure | Value |
|---|---|
| `income[household]` | +100 (the salary only; both transfers are excluded from income) |
| `taggedInflows[household]` | +100 (the withdrawal-into-Checking leg) plus the brokerage-side inflow leg if tagged |
| `taggedOutflows[household]` | the matching outflow legs |

`income` is 100, never 200. The transfers are visible as flows, distinct from
the one real 100 of income. This is I2 made concrete.

## 4. Response shape

The report responses gain an optional, additive breakdown. The existing
top-level fields are unchanged and continue to describe the **All** bucket, so an
old client ignores the new field and still renders today's report.

```jsonc
// IncomeVsExpensesResponse (additive fields only)
{
  "data": [ /* All bucket periods, exactly as today */ ],
  "totals": { /* All bucket, as today */ },
  "currency": "USD",
  "missingCurrencies": [],
  "excludedCount": 0,

  // present ONLY when tagKey was supplied:
  "tagKey": "scope",
  "buckets": [
    {
      "value": "household",          // or the reserved untagged id for B2
      "isUntagged": false,
      "data": [ /* IncomeExpensePeriodItem[] for this value */ ],
      "totals": { /* same shape as top-level totals, per bucket (I4) */ },
      "taggedInflows": 1000.0,       // Income vs Expenses / Cash Flow only
      "taggedOutflows": 1000.0,
      "missingCurrencies": [],
      "excludedCount": 0
    }
    // ... one per discovered value, plus the untagged bucket
  ]
}
```

For Spending by Category / Income by Source the per-bucket payload carries that
report's own item array (`data`) and total, and no `taggedInflows`/`Outflows`.
The exact TypeScript types live beside each report's existing response type in
`backend/src/built-in-reports/dto/` and are mirrored in
`frontend/src/types/built-in-reports.ts`.

## 5. Per-report scope and SQL hook points

| Report | Endpoint / service | Tag dimension | Transfer flows |
|---|---|---|---|
| Income vs Expenses | `income-reports.service.ts:getIncomeVsExpenses` | value partition | yes (section 3) |
| Cash Flow | same service (`built-in-reports.controller.ts:120`) | value partition | yes |
| Spending by Category | `spending-reports.service.ts:getSpendingByCategory` | value partition | no |
| Income by Source | `income-reports.service.ts:getIncomeBySource` | value partition | no |
| Budget vs Actual | budgets module `BudgetReportsService` | no partition; funding overlay (section 11.6) | n/a |

Value partitioning is implemented by adding the tag key/value to the `GROUP BY`
(the `getTransactionBreakdownByTagKey` shape: `innerJoin transaction.tags`,
`POSITION(':' ...) > 1`, `LOWER(SPLIT_PART(...)) = LOWER(:key)`, group by the
trimmed value expression) for the value buckets, computed alongside the untagged
and All aggregates in the same request. Reuse the existing value/key SQL
expressions rather than re-spelling them; the split-level branch mirrors
`buildTagKeyFilterClause`'s `transaction_split_tags` subquery so split tags are
honoured (B4) without row inflation (I7).

## 6. Frontend

- **Control.** Each report component's controls card
  (`IncomeVsExpensesReport.tsx:311`, and siblings) gains a "Break down by tag
  key" `Select`, populated by `collectTagKeys(tags.map(t => t.name))` and hidden
  when the user has no `KEY:VALUE` tags (the `CategoryTagBreakdownPanel`
  precedent). The default option is "None", which sends no `tagKey` and renders
  today's report.
- **Rendering.** When a key is chosen, the report shows the value buckets. Reuse
  the existing tabs/series patterns; the untagged bucket is labelled from i18n
  (`reports.tagBreakdown.untagged`), never shown as an empty string. Tagged
  flows render as a distinct, clearly-labelled pair (`taggedInflows` /
  `taggedOutflows`), visually separated from the income/expenses bars so no
  reader mistakes them for income.
- **Disclosure.** Where multi-valued rows can push shares past 100%, the UI
  states it (reuse the existing breakdown-chart disclosure copy).
- **API client.** `frontend/src/lib/built-in-reports.ts` adds the `tagKey`
  param the same way it already special-cases `accountIds`.
- Completeness (`missingCurrencies`, incomplete `totals === null`) is surfaced
  per bucket using the components the reports already use for the All figure.
- **Account scope and the funding series (section 10).** Income vs Expenses
  gains the shared `ReportAccountMultiSelect` (empty = all accounts) and, when a
  non-untagged bucket is active, two indigo bar series on the main chart (and
  two table columns) read from that bucket's per-period flows.
  `TagKeyBreakdownBuckets` can be controlled (`activeValue` /
  `onActiveValueChange`) so the report owns which bucket the chart follows;
  Cash Flow does the same (section 10.7).

## 7. i18n

New keys under the `reports` namespace (English-first, then
`npm run i18n:pseudo`, then every locale as the final commit):
`reports.tagBreakdown.label` (control), `reports.tagBreakdown.none`,
`reports.tagBreakdown.untagged`, `reports.tagBreakdown.inflows`,
`reports.tagBreakdown.outflows`, `reports.tagBreakdown.sharesExceedNote`. Locale
lists in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` stay in
sync; no backend-composed copy is added (reports are request-scoped).

## 8. Out of scope (recorded so absence reads as a decision)

- **Budget vs Actual** breakdown: it is budget-period + category based in a
  different module, so it gets no value partition of its own. (Superseded in part
  by section 11.6: it gains the funding overlay, frontend only.)
- **The rules engine** (auto-adding tags by condition): explicitly NOT in scope
  by owner decision. Tags are applied manually (the transaction form's existing
  tag MultiSelect); this feature never auto-writes a tag.
- **Split-level tag editing UI**: the backend M2M exists and this report reads
  split tags (B4); exposing a split-tag editor in the form is a separate change.
- Persisting a chosen `tagKey` as a saved report preference.
- A `tagValue` single-select filter (the breakdown returns all values at once;
  narrowing to one value is a client concern for now).

## 9. Test matrix

From `docs/testing-contract.md`. String/date classes are N/A beyond the existing
date-window boundaries; the adversarial classes here are the double-count guard,
the FX-completeness-per-bucket guard, and the no-tagKey parity guard.

Backend (unit + integration, real PostgreSQL for the SQL):

- **Parity (I1):** for each report in scope, the response with no `tagKey` is
  deep-equal to the pre-feature response over the same fixture. This is the guard
  that "default behaves exactly as today".
- **Value partition (B1-B4):** a fixture with rows under `scope:household`,
  `scope:stall`, one row under both, and untagged rows; assert each value bucket,
  the untagged bucket, and that All equals the un-partitioned report; assert the
  multi-valued row appears in both value buckets (shares > 100% is expected).
- **Split-tag attribution (B4, I7):** a split transaction whose two split lines
  carry different `scope:*` tags attributes each line's amount to its value; a
  transaction with two matching split tags is summed once (no fan-out).
- **Transfer visibility (I2, I3, section 3.1/3.2):** the self-transfer truth
  table (both legs tagged) lands +inflow and +outflow under `household` and adds
  nothing to income/expenses/net; the double-count case yields income 100 not
  200; an untagged transfer appears nowhere.
- **VOID (I6):** a VOID tagged transfer contributes to no bucket and no flow.
- **Investment linkage (I5):** an investment cash leg tagged `scope:*` is still
  excluded; a salary deposit into an INVESTMENT-type cash sleeve still counts
  (issue #1257 regression stays green).
- **FX completeness per bucket (I4):** one value bucket with a missing-rate
  currency reports `totals === null` and lists the code, while another value
  bucket with only convertible rows reports complete totals.

Frontend:

- The key selector is hidden with no `KEY:VALUE` tags, shows keys otherwise, and
  "None" renders today's report (no `tagKey` sent).
- Choosing a key renders value buckets and the untagged bucket with its i18n
  label; tagged flows render as a distinct labelled pair, not as income bars.
- An incomplete bucket shows the existing missing-rate treatment.

E2E (Playwright): a smoke path that tags two transactions under a `scope` key,
opens Income vs Expenses, switches "Break down by tag key" to `scope`, and sees
the value tabs and a tagged-transfer flow figure.

## 10. Account scope and the funding series (Phase 1b)

### 10.1 Motivation

The reporter funds living costs by transferring from an RRSP to Checking and
tags the transfer `scope:household`. With "Break down by tag key = scope" the
Household tab showed income 0, expenses 0, tagged inflows 7,066 and tagged
outflows 7,066 (the tags are mirrored onto both legs, so both legs count), and
the main chart did not change. He could not see the funding next to the expenses
it pays for. Two additive fixes, called C and B.

### 10.2 C -- account filter on the Income vs Expenses page

`GET /built-in-reports/income-vs-expenses` already accepts `accountIds` and
applies it to the base query and to every tag-key query (value, whole-transfer
flow, split-transfer flow), and the frontend client already serialises it. The
page never sent it. C adds a `ReportAccountMultiSelect` to the report (same
non-investment account list as the dashboard widget); an empty selection means
all accounts, today's behaviour. No backend change is needed for C.

With the Checking account selected, the transfer's investment-side leg is
outside the filter, so only the Checking leg is counted: tagged inflows 7,066
and tagged outflows 0. This is how a one-sided view is obtained (section 3.1).

**Cash Flow gets the same filter (section 10.7).** An earlier draft left it out
because `getIncomeBySource` took no `accountIds`; section 10.7 closes that gap
so the whole page is scoped by one selection.

### 10.3 B -- tagged flows per period

`IncomeExpenseTagBucket.data` becomes `IncomeExpenseTagPeriodItem[]`, where
`IncomeExpenseTagPeriodItem extends IncomeExpensePeriodItem` adds
`taggedInflows: number` and `taggedOutflows: number` (additive; the top-level
`data` and `totals` keep the plain `IncomeExpensePeriodItem`).

```jsonc
// buckets[i].data[j]
{ "period": "2026-03", "periodStart": "2026-03-01", "periodEnd": "2026-03-31",
  "income": 0, "expenses": 0, "net": 0,
  "taggedInflows": 7066, "taggedOutflows": 7066 }
```

Both transfer-flow queries (whole transfer, split transfer leg) additionally
group by the period start, using the same `bucketStartSql` expression and week
offset as the value query. Every period of the window has a row, zero when
nothing happened, aligned with the bucket's existing `data` periods. When the
request has no start date, a period that only a flow touched is kept as an extra
row so the periods still sum to the window figure.

Invariants:

| # | Invariant |
|---|---|
| I8 | **Per-period flows sum to the window figure.** `taggedInflows` / `taggedOutflows` on the bucket are the integer-cent sum (`sumMoney`) of the per-period values, never a separately computed number. |
| I9 | **FX completeness per period.** A flow row converts through the report's converter (`ReportCurrencyService.buildConverter`), at its own rate or the market rate on its own date (issue #2106). A missing rate leaves that row out of its period, adds the currency to `missingCurrencies`, counts it in `excludedCount` and blanks the bucket's `totals` (I4); the other periods keep their flows. |
| I1, I2 | Unchanged. No `tagKey` returns today's response deep-equal; top-level `data` and `totals` (All) are unchanged; tagged flows are never added to `income`, `expenses` or `net` in any period (INV-REPORT-003). VOID (I6) and investment exclusion (I5) stay on both flow queries. |

### 10.4 Truth table -- RRSP cash -> Checking 7,066, both legs `scope:household`

| Figure | (a) no `accountIds` | (b) `accountIds=[Checking]` |
|---|---|---|
| `taggedInflows[household]` | 7,066 (Checking leg) | 7,066 |
| `taggedOutflows[household]` | 7,066 (RRSP leg) | 0 (RRSP leg outside the filter) |
| `income`, `expenses`, `net` (All and household) | unchanged | unchanged |

Two transfers in two months land in their own two periods; a month between them
carries zero flows.

### 10.5 Frontend rendering of B

When `tagKey` is set and the active bucket is not the untagged bucket, the main
chart adds two bar series from that bucket's per-period flows, labelled with the
value ("Tagged inflows: household"), in the indigo pair
`TagKeyBreakdownBuckets` already uses, never green or red. Savings bars and the
savings rate stay income minus expenses. The table view gets the same two
columns under the same condition; the tooltip shows them. With `tagKey` unset or
the untagged tab active there is no series.

### 10.6 Tests

Backend: per-period flows (two transfers, zero period, sums equal totals),
`accountIds` with `tagKey` (destination only: inflow counted, outflow 0, income
0), FX-missing per period, no-`tagKey` parity, VOID still excluded; the same
cases against PostgreSQL in the integration suite. Frontend: the account select
sends `accountIds`; series only with `tagKey` and a non-untagged tab; savings
unchanged by flows; `TagKeyBreakdownBuckets` controlled mode.

### 10.7 Opt-in stacking and Cash Flow parity (Phase 1c)

**Stacking toggle (Income vs Expenses and Cash Flow).** The reporter asked for
the tagged inflows to sit on top of the Income bar instead of beside it. Stacking
is presentation only and is opt-in:

- A switch "Stack tagged flows" (the `ToggleSwitch` the report toolbars already
  use), visible only when a tag key is selected and the active bucket is not the
  untagged bucket, which is exactly when the tagged series exist. Default OFF,
  persisted per report in localStorage (`useLocalStorage`, as the other report
  view preferences are; keys `monize-reports-income-vs-expenses-stack-tagged`
  and `monize-reports-cash-flow-stack-tagged`).
- OFF: the chart is exactly section 10.5 (separate tagged bars).
- ON: tagged inflows share a Recharts `stackId` with the Income bar (Inflows
  bar on Cash Flow) and tagged outflows share one with the Expenses bar
  (Outflows on Cash Flow). The Savings (Net) bar is not stacked. The tooltip
  always lists Income and Tagged inflows (and Expenses and Tagged outflows) as
  separate rows, in the `chartColors.inflow` / `chartColors.outflow` tokens, so a
  stacked segment is visibly not income green or expense red.
- **Why opt-in.** A user who uses `KEY:VALUE` tags for something else (for
  instance `trip:japan` on transfers) would otherwise watch the income and
  expense bars grow without having asked for it. A bar that looks taller than
  the income it is labelled with is a figure a reader can misread, so the reader
  chooses it.
- **No figure changes.** Savings, the savings rate, Net, the summary cards, the
  table values and the CSV are computed from income and expenses only, with the
  toggle in either position. INV-REPORT-003 holds: a tagged flow is never
  added to income, expenses or net; the stack is two series drawn on one
  column, not a sum.

**Cash Flow parity.** Cash Flow gains what Income vs Expenses has:

- `ReportAccountMultiSelect` (the same non-investment account list, empty = all
  accounts, persisted under `monize-reports-cash-flow-accounts`). The page reads
  three endpoints, and all three receive the same `accountIds` so the cards,
  chart and the two category lists describe one scope:
  `GET /built-in-reports/cash-flow` (passed through to `getIncomeVsExpenses`),
  `GET /built-in-reports/income-by-source` (new `accountIds`, filtering
  `t.account_id = ANY($n::uuid[])` like the other income queries, with
  investment exclusion, VOID exclusion and every other predicate unchanged) and
  `GET /built-in-reports/spending-by-category` (already accepted it).
  With `accountIds` absent, every endpoint is byte-for-byte what it was (I1).
- `TagKeyBreakdownBuckets` controlled by the report, and the two tagged series
  (and the stacking toggle) on the Monthly Cash Flow chart for the active
  non-untagged bucket. The Net figure and the summary cards are unchanged.
- A shared hook resolves "active bucket -> per-period flow map" for both
  reports so the fallback-to-first-bucket rule is written once.

Tests: backend `accountIds` on income-by-source (filtered; absent = unchanged;
callers that omit it unchanged) and on the cash-flow pass-through, plus the
integration spec; frontend toggle visibility (no key, untagged tab), default
off, shared `stackId` when on, savings/net unchanged, persistence, and the Cash
Flow account filter reaching all three calls.

### 10.8 Internal transfers are not tagged flows (Phase 1d)

Follow-up from the reporter's test of the build (discussion #1381). He tagged a
transfer Savings -> Checking and selected BOTH accounts in the account filter.
The report showed it as a tagged inflow and as a tagged outflow, stacked on
income and on expenses. Both legs are inside the selected scope, so no money
entered or left that scope; showing it is wrong.

**Rule.** Only when `accountIds` is non-empty, a transfer leg is left out of
`taggedInflows` / `taggedOutflows` when its counterpart account is also in
`accountIds`:

- Whole transfer (`is_transfer = true`): the counterpart is the account of the
  row `linked_transaction_id` points to, joined as `lt` only under an account
  filter (`LEFT JOIN transactions lt ON lt.id = t.linked_transaction_id`, a
  primary-key join that never multiplies a leg) and tested with
  `lt.id IS NULL OR NOT (lt.account_id = ANY($n::uuid[]))`, the same
  parameterised array as the account filter. A correlated `NOT EXISTS` over
  `transactions` would be a second ledger read the investment-exclusion guard
  (`backend/src/common/investment-filter.guard.spec.ts`) rightly cannot clear.
- Split transfer leg: the counterpart is `transaction_splits.transfer_account_id`;
  the leg is left out when it is in `accountIds`.
- A leg with no visible counterpart (unlinked, or a cross-owner counterpart that
  row level security hides) still counts: the report never invents an exclusion
  it cannot prove.
- No `accountIds` -> exactly today's behaviour (section 3.1: both legs count).
  The categorized income/expense queries are untouched, as are the investment
  exclusion (I5) and the VOID exclusion (I6).

Truth table, transfer Savings -> Checking 500, both legs tagged
`scope:household`:

| `accountIds` | taggedInflows | taggedOutflows | Why |
|---|---|---|---|
| none | 500 | 500 | Today's behaviour (section 3.1). |
| [Checking] | 500 | 0 | The Savings leg is outside the scope; the Checking leg's counterpart is outside it, so it counts. |
| [Savings, Checking] | 0 | 0 | Both legs inside the scope: nothing crossed its boundary. |
| [Savings] | 0 | 500 | Mirror of [Checking]. |

RRSP cash -> Checking 7,066 with `accountIds=[Checking]` stays inflow 7,066 /
outflow 0 (section 10.4). A split transfer leg follows the same table through
`transfer_account_id`.

### 10.8.1 "All Accounts" is every offered account (Phase 3 follow-up)

Follow-up from the reporter's test of the funding-view build. With the account
picker on its default "All Accounts", Income by Source showed no tagged entry and
Monthly Breakdown showed tagged inflows AND outflows; selecting every account in
the picker by hand (13 of them) showed the inflow only. The same label gave two
answers: no `accountIds` meant "both legs count" (section 10.8, last bullet),
while an explicit selection of every offered account left out the transfers
between those accounts and counted what came in from an investment cash sleeve
the picker does not offer.

**Rule.** "All Accounts" bounds the tagged flows by the accounts the picker
offers, so it reads exactly what selecting all of them reads:

- The client sends `transferScopeAccountIds` (comma-separated, `@IsUUID("4", {
  each: true })`, `@ArrayMaxSize(200)`, on `IncomeVsExpensesQueryDto` and
  `CashFlowQueryDto`) = the ids the picker offers, only while the selection is
  empty and a tag key is chosen (`frontend/src/lib/transfer-scope.ts`).
- The server applies it to the two tagged-flow queries exactly as section 10.8
  applies `accountIds` (leg on a boundary account, counterpart outside it), and
  to nothing else: income, expenses, net and the value buckets' totals stay the
  unfiltered report's. A non-empty `accountIds` wins and the field is ignored.
- The boundary is named by the client because "the accounts the picker offers"
  is the non-investment accounts by TYPE, a predicate the server must not spell
  (INV-REPORT-001, `common/investment-filter.guard.spec.ts`).
- While the offered accounts load, the breakdown (or the funding fetch) is not
  requested: the unbounded flows are not a figure to show first. A failed
  account load, no offered account, or more than 200 sends no boundary, which is
  section 10.8's unscoped behaviour.
- Applies to Income vs Expenses, Cash Flow and the funding fetch of all four
  section-11 reports (Budget vs Actual, which has no picker, uses the same
  offered accounts). Each report's OWN figures under "All Accounts" are
  unchanged.

Truth table, key `scope`, value `household`, offered accounts [Savings,
Checking]; RRSP cash sleeve -> Checking 7,066 and Savings -> Checking 500, all
legs tagged; 750 of income in the sleeve:

| Request | taggedInflows | taggedOutflows | income |
|---|---|---|---|
| no `accountIds`, no boundary (before) | 7,566 | 7,566 | 750 |
| `transferScopeAccountIds=[Savings, Checking]` ("All Accounts", now) | 7,066 | 0 | 750 |
| `accountIds=[Savings, Checking]` (every account selected) | 7,066 | 0 | 0 |

### 10.9 Balance view (Phase 1d)

The reporter wants, per month, Income, Tagged inflows, Expenses, then a Balance
and a Balance percent in place of Savings and Savings Rate. His example (August
2026): Income 3,279; Tagged inflows 4,516; Expenses 8,486; Balance -691; Balance
Percent -8.86%.

```text
balance        = income + taggedInflows - expenses - taggedOutflows
balancePercent = balance / (income + taggedInflows) * 100    (null when the denominator <= 0)
example        = (3279 + 4516 - 8486 - 0) = -691 ;  -691 / 7795 * 100 = -8.86
```

- **Opt-in.** The existing per-report switch becomes the single switch for the
  view and is relabelled "Include tagged transfers" (same persisted keys, same
  visibility: a tag key and a non-untagged active bucket). OFF: everything is
  exactly section 10.7's OFF behaviour, the labels "Savings", "Savings Rate" and
  "Net" are unchanged. ON: the stacking of section 10.7 stays, the Savings (Cash
  Flow: Net) bar becomes a Balance bar, and Balance % is added.
- **Surfaces.** Chart bar, tooltip (Income, Tagged inflows, Expenses, Tagged
  outflows only when non-zero for that period, Balance, Balance %), summary cards
  (Income, Tagged inflows, Expenses, Tagged outflows when the window total is
  non-zero, Balance, Balance %), the Income vs Expenses table and CSV, and Cash
  Flow's equivalents. Every surface reads one pure helper
  (`frontend/src/lib/tagged-balance.ts`); no component restates the formula.
- **Money math.** The helper sums in integer cents (`sumMoney` over the four
  figures with the signs above) and divides once; the percent is rounded to two
  decimals; a non-finite input yields null.
- **Completeness (financial-calculation-contract s.1.3).** Balance is a total.
  The window Balance is null (rendered through `PartialTotal`) when the All
  totals are null or the active bucket is incomplete (`missingCurrencies`
  non-empty or `excludedCount` > 0). A per-period Balance uses that period's own
  figures. Balance % is null whenever Balance is null or the denominator is not
  positive, and a null renders as a dash, never 0.
- **Why Savings is not renamed for everyone.** A user without tagged transfers
  reads Savings as income minus expenses; renaming it, or folding a tagged flow
  into it, would change a figure they did not ask to change. The new figures are
  separately named and appear only when the reader opts in.
- **INV-REPORT-003 still holds.** `income`, `expenses` and `net` stay the
  server's values in every position of the switch; Balance is a new client-side
  figure derived from them and from the tagged flows, never written back into
  them. A tagged transfer is still not income.
- **Tests.** Helper (the reporter's example, zero and negative denominator, float
  drift, null input); Income vs Expenses and Cash Flow with the switch OFF
  (unchanged labels and values) and ON (Balance and Balance % in the cards, the
  tooltip, the table and the CSV; Tagged outflows hidden when zero; Balance null
  when the bucket is incomplete). Backend: section 10.8's truth table, unit and
  against PostgreSQL.

## 11. Phase 2/3: the other reports (funding view)

Follow-up from the reporter (discussion #1381, maintainer approved): "an easy way
to see any regular income plus any transferred moneys as my total available
spending money for the month, and then compare my actual expenses to that total.
Both in reports and graphs." Sections 10.7 to 10.9 answer it for Income vs
Expenses and Cash Flow. This section carries the same view to Income by Source,
Spending by Category, Monthly Breakdown and Budget vs Actual. It supersedes the
"Budget vs Actual deferred" decision of section 8 and the "value partitioning
only" wording of the Phase 2 plan: these reports need the FUNDING figure beside
their own numbers, not a per-value copy of them.

### 11.1 Rules shared by all four

| # | Rule |
|---|---|
| F1 | **Inert by default.** With no tag key chosen, or no value chosen, or the switch off, every report, request, response and label is exactly what it is today. The only requests a report adds are the ones named below, and only while a tag key AND a value are chosen. |
| F2 | **A tagged transfer is never income, an expense, a category total or a budget actual (INV-REPORT-003).** The funding figure is separate and separately named ("Tagged transfers", "Available funds"). No report writes it into its own totals, shares or budget figures. |
| F3 | **One source for the funding figure.** Every surface reads the Income vs Expenses answer (`GET /built-in-reports/income-vs-expenses?tagKey=K&accountIds=...`, or `&transferScopeAccountIds=...` under "All Accounts" per section 10.8.1, bucket `month`) for the same window and the same account scope, and derives the figure through `frontend/src/lib/tagged-balance.ts` (`taggedBalance`, `taggedBalanceWindow`, `periodBalanceFields`, plus the new `taggedFunds` below). No component restates the arithmetic, and the server grows no second implementation of the tagged flows. |
| F4 | **Cents, not floats.** Sums go through `sumMoney` (integer cents); a percentage is divided once and rounded to two decimals; a non-finite input is unknown. |
| F5 | **Unknown is not zero.** A month or window the Income vs Expenses answer does not cover is unknown (a dash, a gap in a line), never 0. A missing exchange rate leaves the figure a subtotal: it is marked through `PartialTotal` (windows) or an asterisk and the missing currencies (series). Balance % is withheld when its base is not a total. |
| F6 | **The untagged tab never shows flows.** The value control offers the values of the chosen key and no "untagged" choice; a transfer that carries no `K:*` tag appears nowhere. |
| F7 | **The switch, not the value, turns the funding view on.** Choosing a key and a value narrows only what the report's own server query supports (11.3 and 11.4 say which); the switch "Include tagged transfers" (persisted per report, default OFF, shown only while a key and a value are chosen) adds the funding figure. |
| F8 | **Same account scope for every call of a page.** A page with an account filter sends one `accountIds` to its own report and to the funding fetch, or its figures would describe different sets of accounts. Internal transfers inside the scope are already left out of the tagged flows (section 10.8); under "All Accounts" the scope is every offered account (section 10.8.1). |

Funding arithmetic, `taggedFunds({income, taggedInflows, taggedOutflows})`:

```text
netTagged      = taggedInflows - taggedOutflows                  (integer cents)
availableFunds = income + netTagged                              (null when an input is unknown)
```

`netTagged` is what crossed the scope boundary under the chosen value over the
window: a tagged inflow into the selected accounts minus a tagged outflow out of
them. It is a transfer figure, not income.

### 11.2 Shared frontend pieces (one implementation each)

- `useTaggedFundsFilter(storageKey)`: the key, the value (reset when the key
  changes), the persisted switch, the key list (`useTagKeys`) and the value list
  of the chosen key (`collectTagValues`, new, beside `collectTagKeys`, from the
  same `GET /tags` list). `active` = key and value chosen; `include` = `active` and
  the switch on.
- `TaggedFundsControls`: key select (`TagKeyBreakdownSelect`), a value `Select`
  (aria-label "Tag value"; no untagged choice, F6) and
  `IncludeTaggedTransfersToggle`. Hidden when the user has no `KEY:VALUE` tags.
- **The empty value (follow-up from the reporter's test).** In Spending by
  Category an empty value is "no tag filter" and reads "All values". In Income
  by Source, Monthly Breakdown and Budget vs Actual the value only picks whose
  tagged transfers the funding view shows, and the view is per value (F7), so
  an empty value shows nothing: there it reads "Select a value", and choosing a
  key that has exactly one value selects that value. The reporter read "All
  values" there as "household included" and saw nothing. A true all-values
  funding figure is not offered: summing the value buckets would count twice a
  leg tagged with two values. `useTaggedFundsFilter(key, { valueRequired: true })`.
- `useTaggedFunding({ enabled, tagKey, tagValue, startDate, endDate, accountIds })`:
  the Income vs Expenses fetch of F3 (`tagKey` always sent, month buckets), and
  nothing at all while `enabled` is false. It returns the response, the bucket
  of the chosen value (`undefined` when the server found no activity under that
  value in the window), loading and error state.
- `useReportAccountScope(storageKey)`: the account list of the non-investment
  accounts, the persisted selection and its request key, for the three reports
  that gain the account filter. The existing Income vs Expenses and Cash Flow
  wiring is left as it is.
- `TaggedFundsStrip`: the labelled figures of one window (11.3, 11.4).

A bucket the server omitted means no row in the window carries that value: the
tagged flows are a known zero, not unknown. (The server emits a bucket per value
it finds on a categorized row or a tagged transfer leg; a value present only on
rows excluded by VOID or investment linkage has none, and is correctly zero.)

### 11.3 Income by Source

- **Account filter.** `ReportAccountMultiSelect` (non-investment accounts); the
  server already honours `accountIds` (section 10.7). Absent = all accounts.
- **Controls.** `TaggedFundsControls`. With a key and a value chosen, the report
  itself does not change: income sources are not partitioned by tag value (11.7).
- **Switch ON, value chosen.** `netTagged` of the chosen bucket (window
  `taggedInflows - taggedOutflows`):
  - `netTagged > 0`: the chart, legend and table gain ONE extra entry "Tagged
    transfers: <value>" equal to `netTagged`, in the indigo `chartColors.inflow`
    token, never the income palette, not clickable, labelled "not income" in the
    table. A strip shows `Total income + Tagged transfers = Available funds`.
  - `netTagged <= 0` (or the bucket absent): no entry, no Available funds, and a
    short note: "No net tagged transfer into the selected accounts in this period."
- **"Total income" is unchanged** (the donut centre, the bar total, the table
  footer, the PDF card). Shares remain a share of income: the tagged entry is
  EXCLUDED from percentage-of-income (its share cell is a dash, its tooltip and
  legend detail show the amount only), because a share of an income total that
  contains a transfer would be a figure the reader could mistake for income. The
  alternative (shares over Available funds) was rejected: two denominators on one
  chart is a misreading waiting to happen.
- **CSV / PDF.** CSV gains the tagged row (empty share) and an "Available funds"
  row only in this state; PDF gains an Available funds card.
- **Completeness.** Available funds is `PartialTotal` when the bucket is
  incomplete (`missingCurrencies`, `excludedCount`); the entry's amount is then
  the known subtotal. Income by Source reports no completeness of its own.

Truth table (Income by Source, key `scope`, value `household`; window income 3,279):

| Bucket `taggedInflows` / `taggedOutflows` | `netTagged` | Entry | Available funds | Shares |
|---|---|---|---|---|
| 4,516 / 0 | 4,516 | "Tagged transfers: household" 4,516 | 7,795 | of 3,279, entry excluded |
| 4,516 / 600 | 3,916 | 3,916 | 7,195 | same |
| 500 / 500 | 0 | none, note | not shown | unchanged |
| 0 / 1,000 | -1,000 | none, note | not shown | unchanged |
| bucket absent | 0 | none, note | not shown | unchanged |
| 4,516 / 0, bucket incomplete | 4,516 (subtotal) | 4,516, marked | 7,795 marked partial | unchanged |

### 11.4 Spending by Category

- **Account filter.** `ReportAccountMultiSelect`; the server already honours
  `accountIds`.
- **Server: `tagKey` and `tagValue` filter** (additive, optional, both or
  neither). A row (a transaction, or one split of it) counts when its own `K:*`
  tag values contain `tagValue`, read through the same per-row value expression
  the breakdown uses (`tagValuesArrayExpr`, extracted to a shared module, rules
  B1 and B4: transaction-level and split-level tags, a value present at both
  levels attributes once, no fan-out). The predicate is an extra `WHERE` clause
  on the existing query with a bound `$n = ANY(<values>)`, so the VOID, investment
  linkage, asset-category and transfer exclusions are untouched. With neither
  param the SQL and the response are byte-for-byte today's. `tagValue` without
  `tagKey` (or the reverse) is a 400: a half-specified filter is never silently
  ignored. This is the household-only view the reporter asked for ("so the user
  can see household spending only"); it is a FILTER, not a value partition, so
  the response shape does not change and the "shares past 100%" disclosure of B1
  does not arise (one value, one population).
- **Transfers do not apply** (no category on a transfer leg here).
- **Switch ON, value chosen.** A strip above the chart:
  `Available funds = income + tagged transfers`, `Spent`, `Balance`, from the
  Income vs Expenses answer of F3 through `taggedBalanceWindow`:
  - income `Y` = the All `totals.knownIncome` of that response (the same income
    the Balance view of section 10.9 uses), tagged transfers `Z` = the bucket's
    `taggedInflows - taggedOutflows`;
  - `Spent` = the report's OWN total (`knownSpending`, which carries the value
    filter), so the strip's Spent equals the donut total the reader sees;
  - `Balance = Y + Z - Spent`, `Balance %` over `Y + taggedInflows` as in 10.9.
  Completeness is the union of the spending response (`missingCurrencies`,
  `excludedCount`, `totalSpending === null`), the funding response's All
  totals and the bucket's own (F5): any gap makes Balance a subtotal and
  withholds Balance %.
- **Switch OFF** with a value chosen: the report is the filtered report, no
  strip, no funding fetch.

Numeric example (the reporter's August): `Y = 3,279`, bucket `taggedInflows =
4,516`, `taggedOutflows = 0`, household spending `8,486`:

```text
Z = 4,516      Available funds = 3,279 + 4,516 = 7,795
Balance = 7,795 - 8,486 = -691        Balance % = -691 / 7,795 * 100 = -8.86
```

### 11.5 Monthly Breakdown

- **Server: `accountIds`** on `GET /built-in-reports/monthly-category-breakdown`
  through its own query DTO (`MonthlyCategoryBreakdownQueryDto`, the same
  validation as `IncomeVsExpensesQueryDto`: comma-separated, `@IsUUID("4", {
  each: true })`, `@ArrayMaxSize(200)`), applied as `t.account_id =
  ANY($n::uuid[])` on BOTH the category query and the transfer-rows query (the
  uncategorized transfer "from/to" rows, which are rows of an account, are
  scoped like everything else). Absent or empty = today, byte for byte.
- **Frontend.** Account filter, `TaggedFundsControls`. All the new UI and logic
  live in new files; the 1,630-line report receives only wiring.
- **Switch ON, value chosen.** A summary block under the table, one column per
  month the table shows (the in-progress month follows the report's own "include
  current month" setting), from the Income vs Expenses answer (bucket `month`,
  `startDate` snapped to the first of the month exactly as the report does):
  rows Income, Tagged inflows, Expenses, Tagged outflows (only when any shown
  month is non-zero), Balance, Balance %, each month through
  `periodBalanceFields` / `taggedBalance`. The category rows, their subtotals and
  the table's own Balance row never include a transfer.
- A month the funding answer does not cover renders dashes, never zeros (F5).
- Completeness: a funding answer with a missing rate marks every Balance cell of
  the block with an asterisk and withholds Balance %, and says so in a note.

### 11.6 Budget vs Actual

- **Frontend only.** The budgets module is untouched: `budgeted`, `actual`,
  `variance` and `percentUsed` are exactly the server's.
- **Controls.** `TaggedFundsControls` in the report's toolbar. The report has no
  account filter and gains none: the budget's own actual is not account-scoped, so
  the funding fetch is not either.
- **Switch ON, value chosen.** The window is the first of the trend's earliest
  month to the last day of its latest month. The funding fetch (F3) feeds an
  "Available funds" series per month = `income + taggedInflows - taggedOutflows`
  (`taggedFunds`), drawn as an indigo bar beside the Budgeted and Actual bars on
  the overview chart (a bar, not a line: it keeps the chart a plain bar chart, so
  the three series read as three amounts of the same month). The tooltip adds "Available
  funds" and "Actual vs available" (`available - actual`; positive = money left).
  The variance line, the summary table and the by-category view are unchanged.
- Months are aligned by `monthKey` (YYYY-MM). A month missing from the funding
  answer has no point (a gap), and its tooltip rows show a dash. An incomplete
  funding answer (missing rate) marks the series name and tooltip rows with an
  asterisk and a note names the currencies.

### 11.7 Deferred and open

- **Income by Source value partition** (income sources split by tag value) is
  deferred: it needs a `tagKey` partition on `income-by-source` and a decision on
  what a multi-valued row's share means; the funding view above does not need it.
  Opening it later reuses the Spending by Category predicate (11.4).
- **Spending by Category value partition** (a per-value copy of the report in
  one response, rules B1 to B4) is likewise not built; the filter of 11.4
  answers the household question and keeps the response shape.
- **Open question (not guessed):** in 11.4 the strip's `Y` is the All-accounts-in-
  scope income while `Spent` is value-filtered. A reader who filters to
  household sees household spending against ALL income plus household transfers,
  which is the reporter's stated comparison (money available vs what the
  household spent). If the owner wants income value-filtered too, the strip's `Y`
  changes to the bucket's `totals.knownIncome` in one place (`taggedFunds` input),
  with no other change.

### 11.8 Test matrix

Backend: spending-by-category with `tagKey`/`tagValue` (value match, a split-level
tag attributing only its own split, a value on both levels summed once, VOID and
investment exclusion unchanged, only one of the two params is a 400, absent =
today's SQL and params byte for byte), monthly-category-breakdown `accountIds` (on
both queries, absent unchanged, DTO validation, array bound), each as unit specs
and against PostgreSQL.

Frontend, per report: switch off or no key = today's calls and labels (parity;
the funding fetch is NOT made); switch on = the figures of the numeric examples
above (income 3,279, tagged inflows 4,516, expenses 8,486 -> Balance -691, -8.86%);
the account filter reaches every call of the page; the untagged choice does not
exist; a missing rate marks figures partial; months align by key. Helpers:
`taggedFunds`, `collectTagValues`, the funding hook (no call while disabled).
