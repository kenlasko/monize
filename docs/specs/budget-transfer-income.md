# Incoming transfers as budget income

Specification of issue #2141: a budget can count money transferred into it as
income. Written from the maintainer's answers of 2026-11-14; the reference case
is a "bucket strategy" household that keeps a reserve in a high-interest
savings account (HISA) and transfers a set amount into chequing each month.

## 1. Goal

Two options, offered for every budget type and every strategy, in the
creation wizard and in the budget's settings:

- **(a) Budget-wide toggle**, `budgets.config.transfersInAsIncome`: transfers
  into the budget from the accounts it excludes (`config.excludedAccountIds`)
  count as income. Shown on the budget as one income figure, "Transfers from
  accounts outside this budget".
- **(b) Transfer income line**: a budget line with `is_transfer = true`,
  `is_income = true` and `transfer_account_id` naming the SOURCE account
  ("Transfers from HISA"), with a planned amount like any income line. Its
  actual is what arrived from that account in the period.

Both feed every place a budget's income is read: the summary's `totalIncome`,
an income-linked budget's percentages (`resolveBudgetIncome`), the period
close's `actual_income`, the income-shortfall alert, the savings-rate report,
the monthly summary email (through `actual_income`) and the assistant's and
MCP's budget status (through the summary). The budget generator suggests
transfer income lines.

## 2. What counts

A transfer is read from the leg in a budget account (not excluded) whose
counterpart is the source account, in both transfer shapes
(`budget-spending.util.ts`): a whole-row transfer (`t.is_transfer`, the
counterpart is `lt.account_id`) and a split line (`s.transfer_account_id`).
A counterpart row is never a split, so the two shapes cannot count one
transfer twice, and the source's own leg is never read (its counterpart is the
budget account, not itself).

**Net change.** The figure is the signed sum of those legs: money in from the
source is positive, money from a budget account back to the source is
negative. A line's actual is clamped at zero, like an income category's; the
income-linked base (`resolveBudgetIncome`) nets the signed figures of every
income line first and clamps the whole, as it already does for categories.

**Option (a)** reads the same legs with every excluded account as a source,
less any account a transfer line of the budget already names (that line
counts it). It is one figure, clamped at zero as a line. It needs no line: a
budget with the toggle on and no line at all still shows it on the summary
and freezes it at the period close (the spending read takes the budget's id
rather than reading it off the first line).

**One line per account.** An account is named by at most one transfer line
of a budget, outgoing or income: a transfer to it counted as savings progress
must not also reduce income. The refusal runs on every write path (the
generator's apply and the add-transfer-income route).

VOID rows never count. Every group converts into the budget's currency at its
own transfer rate or the market rate on its date (INV-FX-001, INV-FX-002), as
the outgoing transfer lines do; a group with no rate leaves the line's figure
the known subtotal and names the line in `incompleteTransferIncomeAccountIds`
(or clears `outsideTransferIncomeComplete`).

## 3. Truth table

Budget accounts: Chequing, Credit card. Excluded: HISA, RRSP.

| Period's transfers | Line "from HISA" | Toggle (a) |
|---|---|---|
| HISA -> Chequing 2,000 | 2,000 | 2,000 |
| HISA -> Chequing 2,000; Chequing -> HISA 500 | 1,500 | 1,500 |
| Chequing -> HISA 500 only | 0 (clamped) | 0 (clamped) |
| Chequing -> Credit card 800 | 0 | 0 (both in the budget) |
| HISA -> RRSP 1,000 | 0 | 0 (both excluded) |
| RRSP -> Chequing 300, HISA line present | 0 for RRSP on the line | 300 (HISA is the line's) |
| HISA -> Chequing 2,000, VOID | 0 | 0 |

With the HISA line and the toggle on, the HISA -> Chequing 2,000 above counts
once, on the line.

## 4. Generator

`GenerateBudgetResult.incomeTransfers` lists, per source account, the monthly
net of incoming transfers over the analysis window (each month clamped at
zero, as a period's actual is), with the same statistics and profile-based
`suggested` amount as the outgoing `transfers`. Accounts whose every month is
zero are left out.

A suggestion is a starting amount, not what the line will count:

- The analysis runs before the wizard's Configure step picks the excluded
  accounts, so it cannot leave out a leg whose receiving account the budget
  will exclude (truth table row 5: HISA -> RRSP with both excluded is
  suggested, but the line counts 0).
- Like the outgoing `transfers`, a source that paid into accounts of
  different currencies has its raw amounts summed, unconverted. Converting
  both analyses is a separate change.

The wizard lists them under Income, none preselected: a
chequing account that pays a credit card is a "source" too, and only the user
knows which source is a reserve. Selecting an income transfer for an account
deselects that account's outgoing transfer and vice versa.

## 5. Surfaces

- `GET /budgets/:id/summary`: `outsideTransferIncome` (the clamped figure,
  `0` with the toggle off), included in `totalIncome`; each breakdown row
  carries `isTransfer`.
- `POST /budgets/:id/categories/transfer-income`: adds a transfer income line
  (`transferAccountId`, `amount`, optional rollover and notes). Refuses an
  account the user cannot see or one a transfer line of the budget already
  names.
- `PATCH /budgets/:id/categories/:categoryId`: refuses a change of `isIncome`
  on a transfer line (resending the value it has is not a change). Flipping
  it would turn an outgoing savings line into an income line for the same
  account, or the reverse, and change what its figure means; the line is
  removed and a new one added instead.
- Period detail: a closed period's Income card is the frozen
  `actual_income`; the part of it no line row carries (the toggle's figure,
  `actual_income` less the income rows) is its own "Transfers from accounts
  outside this budget" row, so the rows add up to the card. An open period
  has nothing frozen yet: its Income card and rows are the lines' stored
  actuals alone, and the live figure, toggle included, is the budget
  summary's.
- Savings rate (`budget-health-reports.service.ts`): a transfer income line
  is an income line. A budget whose only income line is "Transfers from
  HISA" therefore reads its income from its lines and no longer falls back to
  "all non-transfer deposits", so a salary no line names is left out of its
  savings rate. This is deliberate: it is how the summary reads the same
  budget's income, and the two must agree.
- Wizard: the income transfer table on the Categories step; the toggle beside
  the excluded-accounts picker on the Configure step.
- Settings: the toggle in the budget form; transfer income lines in the income
  list, with an "Add transfer income" dialog.

## 6. Test matrix

- Spending util: parent and split legs, net of both directions, VOID, excluded
  receiving account, the (a) source set less the named accounts, buckets.
- `resolveCategorySpent` / `resolveBudgetIncome` with transfer income lines
  and the (a) figure.
- Summary, period close, income-shortfall alert and savings rate include it.
- Generator: incoming analysis and the one-line-per-account refusal in apply.
- Add-transfer-income route: ownership and duplicate refusals.
- Frontend: wizard selection and exclusivity, review payload, settings toggle
  and dialog.
