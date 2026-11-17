# Plan: Investment Account Consolidation (one visible account per brokerage/cash pair)

This design shipped: every task of its task list was completed on branch
`claude/investment-account-consolidation-8x3lvz`, answering GitHub discussion
#903. The plan is retired and this document is kept as the specification the
code is held to.

## Goal

An investment account pair -- an `INVESTMENT_BROKERAGE` account and its linked `INVESTMENT_CASH`
account -- presents as **one logical account everywhere the user reads**: one account-list row,
one combined value (holdings market value + cash balance), one name with the localized
" - Brokerage"/" - Cash" suffix stripped, one detail page with a brokerage/cash register toggle,
one entry in every picker, one row in every report. Underneath, the two-row data model stays
exactly as it is: two ledgers, linked by `linked_account_id`, with money on the cash half and
holdings on the brokerage half. This is the request in GitHub discussion #903, where a community
draft branch (`bcorob:investmentconsolidation`) validated the direction but stalled on the
missing UI path for editing the cash half and covered only the account list and detail view.

An investment account may or may not have a cash component. Three shapes exist today and all
three keep working on every surface: the **linked pair**, the **standalone** investment account
(`account_sub_type` NULL -- one row carrying both holdings and cash), and the **orphan** (one
half of a deleted pair, `linked_account_id` NULL).

The plan reuses the collapse logic that already exists in pieces -- `countLogicalAccounts`,
`isInvestmentCashHalf`, `getMainAccountName` in `frontend/src/lib/account-utils.ts`, the
`/investments` page's brokerage/cash register toggle, `InstitutionAccountsManager.tsx`'s
drop-the-cash-half pattern, `accountsApi.getInvestmentPair` -- and gives them one shared home
instead of a per-surface restatement.

## Data model (unchanged)

No migration. No change to pair creation, importers, or `linked_account_id` semantics.

- Both halves are `accounts` rows with `account_type = 'INVESTMENT'`. `account_sub_type`
  (`'INVESTMENT_BROKERAGE'` / `'INVESTMENT_CASH'` / NULL) discriminates roles;
  `linked_account_id` is a self-FK (`ON DELETE SET NULL`), bidirectional by convention. Nothing
  in the database enforces the pairing -- the orphan states are reachable and stay supported.
- Money lives on the cash half (an ordinary ledger). The brokerage half's `current_balance` is
  deliberately 0 (`resetBrokerageBalances` in `backend/src/accounts/accounts.service.ts`); its
  value is the market value of its `holdings`. Trades generate ordinary transactions on the
  settlement account resolved by `findCashAccount` in
  `backend/src/securities/investment-transactions.service.ts`: explicit `fundingAccountId` ->
  linked cash -> the account itself.
- Names are stored **with** the localized suffix (`account-name.util.ts` owns generation and
  `stripBrokerageSuffix`); the UI strips for display. That stays true -- see Naming below.

## The logical-account fold

One frontend abstraction, consumed by every surface. **No backend "logical accounts" payload**:
every input the fold needs is already on the client (`accountsApi.getAll()` and
`investmentsApi.getPortfolioSummary()`, both cached in `apiCache.ts`), and the backend already
states the pairing rule in its own canonical places (`getLlmAccounts`,
`logicalAccountsQuery` in `backend/src/institutions/institutions.service.ts`, the net-worth
summation). A second server-side statement of the rule would drift, not help.

New `frontend/src/lib/logical-accounts.ts` (+ `logical-accounts.test.ts`), pure functions:

```ts
export interface LogicalAccount {
  id: string;               // canonical id: the brokerage half of a pair, else the account itself
  primary: Account;         // the row that represents the entity
  cash: Account | null;     // the linked cash half (pairs only; null otherwise)
  memberIds: string[];      // 1 or 2 ids belonging to this entity
  displayName: string;      // suffix-stripped via caller-supplied strip fn
  isInvestment: boolean;
  // The ledger the user posts money to: pair -> cash half; standalone -> self;
  // null for a brokerage with no cash half.
  cashRegisterId: string | null;
  // The ledger carrying securities: brokerage half, orphan brokerage, or a
  // standalone account; null when the entity holds none.
  holdingsAccountId: string | null;
  // market value + cash balance (+ cash futureTransactionsSum);
  // null when unpricedHoldingsCount > 0 or market value is unknown for an account with holdings
  combinedValue: number | null;
}

export function buildLogicalAccounts(
  accounts: Account[],
  stripName: (name: string) => string,
  portfolio?: { marketValues: Map<string, number>; unpricedCounts: Map<string, number> },
): LogicalAccount[];
```

Fold rule: an account matching `isInvestmentCashHalf` **whose partner is present in the input**
is absorbed into the partner's entry; everything else is its own entry. `countLogicalAccounts`
becomes a delegation to `buildLogicalAccounts(...).length` -- behavior-identical, held by its
existing tests. A `useLogicalAccounts.ts` hook wires `useMainAccountName()` in as the strip
function and memoizes; a `useAccountOptionLabel` hook (added to
`frontend/src/hooks/useMainAccountName.ts`) becomes the single place picker option labels are
built (`${strippedName} (${currencyCode})` + closed marker), so every picker labels accounts
through one function.

The fold does **no FX of its own**: the two halves of a pair share `currencyCode` by
construction (`update()` already propagates it), so `combinedValue` is a same-currency sum of
numbers the API already reports.

## Invariants (govern every task)

1. **No data-model change.** No migration; pair creation (`createInvestmentAccountPair`,
   `CreateAccountDto.createInvestmentPair`) and every importer are untouched.
2. **One entity on read surfaces; two ledgers on write surfaces.** A write always targets a real
   account id -- the cash half for money movement, the brokerage for holdings -- never a
   synthetic logical id. No API request shape changes.
3. **Canonical ids are resolved through `LogicalAccount`, never re-derived ad hoc.** Portfolio
   surfaces carry `id` (the brokerage half); transaction surfaces carry `cashRegisterId`. A
   surface that needs the mapping imports the fold; a second inline `linkedAccountId` hop is the
   defect the fold exists to prevent.
4. **A combined total with an unknown component is unknown** (`docs/financial-calculation-contract.md`
   section 1): `combinedValue` is null when any holding is unpriced, and renders as an em-dash
   with an explanatory tooltip -- never as the cash-only subtotal. An account with **no**
   holdings has a settled market value of zero and combines normally: "nothing to price" is
   known, "could not price" is not.
5. **Every shape works when the other half is absent.** Standalone: cash register = self. Orphan
   brokerage: **no cash register** -- its own ledger carries only the cash rows its trades
   generated, so it is not an account the user posts to, reconciles or transfers into, which is
   how the app already treated a brokerage in every money picker. (The plan first said "cash
   register = self" here, which contradicted its own truth table: reconcile hidden, money pickers
   excluded. The truth table won, and `holdingsAccountId` became a second field so a surface asks
   for the ledger it actually needs.) Orphan cash: fails `isInvestmentCashHalf` (the link is
   null) and renders as an ordinary account with its suffix stripped.
6. **Names stay stored with suffixes; the UI strips.** The server remains the sole owner of
   suffix generation -- at creation as today, and in the one new place: rename propagation
   (below). No stored-name migration.
7. **Non-investment behavior is untouched.** Every new branch is entered only for
   `account_type = 'INVESTMENT'` rows (or a `LogicalAccount` wrapping one). If a change alters
   how a chequing account lists, labels, closes or filters, the task is wrong.

## As-built notes

Six things the implementation settled that the plan above did not, each because the code or a
test insisted:

1. **A brokerage is identified by its sub-type alone.** Requiring `accountType = 'INVESTMENT'`
   as well is stricter than the data: a row marked `INVESTMENT_BROKERAGE` holds securities
   whatever else it claims, and only a standalone account -- which has no sub-type to go on --
   needs its type read.
2. **A closed account's combined value is its cash, not unknown.** `getPortfolioSummary` filters
   `isClosed: false`, so a closed account is absent from the payload by design. Reading that
   absence as "could not price" would put an em-dash on every closed investment account; closing
   requires the account to hold no securities first, so "no holdings to value" is the settled
   answer. (Amended November 2026: a close no longer requires a zero cash balance, so a closed
   pair's combined value is the cash it was closed with.)
3. **The close guard checks both ledgers, not only the addressed half.** Once either half can
   close the pair, closing from the brokerage side would otherwise skip the other ledger. (Amended
   November 2026: the check over both halves is now the future-dated rows and the holdings; a cash
   balance no longer stops a close and stays in the closed cash half. See
   `docs/backend/transactions-and-money.md`, "A closed account keeps its balance".)
4. **`ReportAccountMultiSelect` keeps `filter` alongside the new `mode`.** `mode` expresses the
   pair split; `filter` stays for genuine domain restrictions (accounts with an FX fee,
   non-investment accounts) that several callers legitimately pass.
5. **The pair-mode form carries the cash fields on its payload; the modal issues the second
   update.** The form's contract is to collect data and call `onSubmit`, and the modal already
   owns every account write.
6. **`useAccountOptionLabel` takes `withCurrency`.** Split rows are narrow and never showed a
   currency; one labeller with an option beats two labellers.

## Per-surface truth table

| Surface | Linked pair | Standalone (sub-type NULL) | Orphan brokerage | Orphan cash |
|---|---|---|---|---|
| Account list | 1 row; combined value; caption "Investments X / Cash Y" | 1 row; market value + own balance | 1 row; market value + own balance; no cash caption | 1 row; own balance; suffix stripped |
| Row click | `/accounts/{brokerageId}` | `/transactions?accountId=` (no brokerage sub-type to go on) | `/accounts/{brokerageId}` | `/transactions?accountId=` |
| Detail `/accounts/{id}` | merged view; a cash-id deep link `router.replace`s to the brokerage id | merged view | merged view | investment detail fallback (as today) |
| Register toggle in detail | brokerage tab = investment transactions; cash tab = cash half's ledger | cash tab = own ledger | cash tab = own ledger | n/a |
| Reconcile | targets the cash half | targets self | hidden (own ledger is trade-generated rows only) | targets self |
| Money pickers (transfer/split/scheduled) | one option, stripped label, **value = cash id** | one option, value = self | excluded (as today) | one option, value = self |
| Report pickers | one option; transactions mode emits cash id, portfolio mode emits brokerage id | one option; both modes emit self | portfolio mode only | transactions mode only |
| Close / reopen | acts on the pair from either half (server cascades) | self | self (holdings guard applies) | self |
| Delete | one confirm naming both ledgers; frontend deletes brokerage, then cash | self | self | self |
| Favourites card | one card when either half is favourited | one card | one card | one card |

## Combined-value truth table

| Holdings | Unpriced holdings | Cash balance | `combinedValue` | Renders as |
|---|---|---|---|---|
| all priced, MV = 12,000.00 | 0 | 3,500.00 | 15,500.00 | 15,500.00 with caption "Investments 12,000.00 / Cash 3,500.00" |
| none | 0 | 3,500.00 | 3,500.00 | 3,500.00 (settled zero MV, not unknown) |
| some priced (subtotal 9,000.00) | 2 | 3,500.00 | null | em-dash + tooltip "Includes 2 holdings without a price" |
| all priced | 0 | cash half missing (orphan brokerage) | MV + own balance | as pair, no cash caption |

The subtotal (9,000.00) is never shown in the total's place. Today the backend collapses an
unpriced holding to zero inside `holdingsByAccount` (`h.marketValue ?? 0` in
`portfolio-calculation.service.ts`), so the client cannot distinguish the second and third rows;
the one backend addition this plan makes is `unpricedHoldingsCount` on each `AccountHoldings`
entry so it can.

## Surface specs

### Account list

`frontend/src/components/accounts/AccountList.tsx` currently orders a pair adjacently inside the
INVESTMENT group (brokerage first) and renders two rows. Replace that block with the fold: cash
halves whose partner is in the filtered set disappear; orphans stay. Details:

- `frontend/src/components/accounts/AccountRow.tsx` takes an optional `logical: LogicalAccount`
  prop (non-investment rows are untouched): stripped display name; type pill "Investment"
  (orphan cash keeps its "Inv. Cash" pill); balance cell shows `combinedValue` with a small
  caption "Investments X / Cash Y" replacing today's "Market value" caption; the chain-link
  icon and `pairedWith` sub-line are dropped for folded rows.
- `combinedValue === null` renders an em-dash plus a tooltip naming the unpriced-holdings count
  (invariant 4).
- Search matches against every member's raw name plus the display name, so searching "cash" or a
  suffix still finds the row. Balance sort uses `combinedValue ?? 0` as the key (sort key only;
  the display stays contract-clean).
- Group header counts already use `countLogicalAccounts`; the page summary math in
  `frontend/src/app/accounts/page.tsx` already iterates raw accounts correctly -- both are
  asserted unchanged.
- Action sheet (`buildAccountActions`): View transactions -> `/investments?accountId={id}`;
  Details -> `/accounts/{id}`; Edit -> pair mode (below); **Reconcile un-hidden** for logical
  investment rows, routing to `/reconcile?accountId={cashRegisterId}` (today it is hidden for
  brokerage rows -- the cash half's ledger is exactly what reconciliation is for); Close/Reopen
  call the API with the primary id (the server cascades -- below), Close disabled unless
  `combinedValue === 0` exactly (null disables with the unknown-value title); Delete runs the
  two-call pair delete behind one confirm dialog that names both ledgers.

### Detail view and canonical URL

- **One URL per entity.** In `frontend/src/app/accounts/[id]/page.tsx`, when the loaded account
  is a linked cash half, `router.replace` to `/accounts/{linkedAccountId}`. Old bookmarks and
  deep links to the cash id keep working; the switcher and history stay coherent. (The community
  draft rendered the merged view under either URL -- two URLs for one entity.)
- `AccountDetailShell.tsx` strips the title suffix for investment accounts, and
  `AccountSwitcher.tsx` receives the logical list so it stops offering both halves.
- **Register toggle.** The segmented `brokerage | cash` toggle currently appears twice inline in
  `frontend/src/app/investments/page.tsx`; extract it verbatim into a shared
  `InvestmentViewToggle.tsx` under `frontend/src/components/investments/` and swap the page onto
  it (visually identical, localStorage persistence unchanged). Then build
  `InvestmentRegisterPanel.tsx` beside it: a self-contained panel owning the toggle, the
  brokerage tab (`InvestmentTransactionList.tsx` with create/edit/delete via
  `InvestmentTransactionForm.tsx`) and the cash tab (the generic
  `frontend/src/components/transactions/TransactionList.tsx` scoped to `cashRegisterId`, with
  new-cash via the transaction form), paginated via `frontend/src/components/ui/Pagination.tsx`.
  `InvestmentDetailView.tsx` replaces its recent-transactions list with the panel; it already
  resolves the pair via `accountsApi.getInvestmentPair` and scopes its summary cards to both
  ids.
- The `/investments` page is **not** rebuilt on the panel in v1 -- its register is welded to
  `useInvestmentData.ts` (filters, density, undo/redo); only the toggle is shared. Migrating the
  page onto the panel is a named follow-up.
- Every write from the panel calls `invalidateBalanceCaches()` (the rule in
  `docs/frontend/api-and-cache.md`; `balance-cache.guard.test.ts` scans for it).

### Editing the pair (the gap that stalled the community branch)

`frontend/src/components/accounts/AccountForm.tsx` gains a **pair mode**, entered when the
edited account resolves to a pair via `getInvestmentPair`:

- One "Account name" field, pre-filled with the stripped base name. It submits to the brokerage
  id; the server propagates (below).
- Shared fields (institution, currency -- already server-propagated) appear once.
- A collapsed "Cash account" section holds the cash half's own fields: opening balance
  (`CurrencyInput`), account number, description. Saving issues a second `update()` to the cash
  id only when the section is dirty. The busy flag is a counter, not a boolean (nested-saves
  rule in `docs/frontend/api-and-cache.md`).
- Standalone and orphan accounts get today's single-account form unchanged; the
  `createInvestmentPair` checkbox on create is untouched.

Backend: in `update()` (`accounts.service.ts`), `name` joins `currencyCode` + `institutionId` as
pair-propagated fields. When the target is half of a linked pair and `name` changes, the server
derives the base by stripping its own known suffixes (the request locale's and English, same set
`getMainAccountName` strips), then re-suffixes **both** halves inside the same transaction. The
server stays the sole owner of suffix generation, and a name stored under a stale locale's
suffix self-heals on rename. No `UpdateAccountDto` change.

### Money pickers

**The option value stays the cash id.** Money genuinely lands in the cash ledger; changing the
submitted id would be a backend change for zero benefit. Only the **label** changes: every
picker that lists accounts for transfers, splits, or scheduled transactions labels options
through `useAccountOptionLabel`, so a linked cash half reads as "TFSA (CAD)" instead of
"TFSA - Cash (CAD)". Surfaces: `TransferTransactionFields.tsx`, `NormalTransactionFields.tsx`,
`SplitTransactionFields.tsx`, `SplitEditor.tsx`, `ScheduledTransactionForm.tsx`, the account
filter in `useTransactionFilters.ts` (its brokerage exclusion stays), and the transfer
other-side labels in `TransactionRow.tsx`. Stripping is safe to apply to every account name:
`getMainAccountName` strips only an exact trailing localized suffix, a behavior already accepted
across `/investments` and the reports.

A source-scan guard in `frontend/src/test/ui-conventions.test.ts` fails any file under the
transaction/scheduled-transaction component trees that builds an account option label from raw
`account.name` instead of the hook -- the same pattern as the existing raw-input scans.

### Reports and dashboard

- `frontend/src/components/reports/ReportAccountMultiSelect.tsx` replaces its free-form `filter`
  prop with `mode: 'transactions' | 'portfolio'`. Both modes render the **identical** logical
  option list (one entry per logical account, stripped labels); they differ only in the id they
  emit -- transactions mode emits `cashRegisterId`, portfolio mode emits the primary id. Orphans
  appear only in the mode that has a half for them. All callers migrate
  (`SectorWeightingsReport.tsx`, `GeographicAllocationReport.tsx`,
  `SecurityTypeAllocationReport.tsx`, `CurrencyExposureReport.tsx`,
  `DividendIncomeReport.tsx`, `PortfolioValueWidget.tsx`, and the transaction-based reports);
  the two opposite exclusion conventions (`exclude BROKERAGE` vs `excludeCashAccounts`) die.
- `AccountBalancesReport.tsx`: one row per logical account -- combined value with the same
  "Investments X / Cash Y" caption, em-dash on null. No expandable sub-rows in v1; the caption
  carries the split. Totals for fully priced data are identical to today's.
- `FavouriteAccounts.tsx`: one card per logical account when **either** half is favourited
  (dedupe when both are), combined value + caption + em-dash rule.
- `frontend/src/app/dashboard/page.tsx`: the investment-account count folds the pair (both
  halves are type INVESTMENT, so `countLogicalAccounts` over the active investment accounts is
  the fix).

### Close, reopen, delete

- **Close/reopen become symmetric server-side** (`close()` / `reopen()` in
  `accounts.service.ts`): closing or reopening the **brokerage** half cascades to the linked
  cash exactly as cash -> brokerage does today, in the same transaction under the same lock. The
  UI then issues one call with the primary id.
- **The close guard learns about holdings.** Today `close()` refuses only a nonzero
  `currentBalance` -- which for a brokerage is always 0, so the server happily closes a
  brokerage full of positions (only the frontend blocks it). Per the financial contract's
  "a rejected command must not already have written", `close()` additionally refuses any account
  whose own (or, when closing from the cash side, linked brokerage's) holdings include a nonzero
  quantity, with a locale-keyed error.
- **Delete stays unlink-don't-delete server-side.** A server-side cascade delete of the
  partner's entire ledger is a destructive semantics change to an existing endpoint. The
  frontend delete flow for a pair issues two deletes -- brokerage first, then cash -- behind one
  confirm dialog naming both ledgers. If the second call fails, the survivor is an orphan
  **cash** account: an ordinary, fully functional account, the least-bad failure shape, and one
  every surface already supports (invariant 5).

### Naming

Stored names keep their suffixes; every display surface strips through the shared helpers. The
generic `/transactions` register header and the transfer other-side labels join the stripped
world via `useAccountOptionLabel`. The only server-side naming change is the rename propagation
above. Import-wizard pickers keep raw names (cut).

## Deviations from the community draft

| Community draft | This plan | Why |
|---|---|---|
| combined = market value + cash, unconditionally | null + em-dash when any holding is unpriced | `docs/financial-calculation-contract.md`: a subtotal is not a total |
| no edit path for the cash half | AccountForm pair mode + server rename propagation | the gap that stalled the branch |
| `isInvestmentCashHalf` filtering re-implemented per surface | one `buildLogicalAccounts` fold consumed everywhere | ten-plus surfaces would each restate the rule and drift |
| merged view rendered under either half's URL | cash deep links `router.replace` to the brokerage id | one canonical URL per entity; switcher and history stay coherent |
| account list + detail view only | pickers, reports, dashboard, switcher, close/delete symmetry | the request is "a single account everywhere" |
| close symmetry not addressed | server-side symmetric close/reopen + holdings guard | a frontend-only cascade races, and the server-side guard hole (closing a brokerage full of positions) predates this feature |

## Adversarial test matrix (from `docs/testing-contract.md`)

- **Missing data:** one unpriced holding -> list row, balances report row and favourites card all
  show the em-dash, never the cash subtotal; zero holdings -> combined equals cash (settled
  zero, not unknown).
- **Aggregation:** group totals, page summary cards and report totals for fully priced data are
  byte-identical before and after the fold; a pair, a standalone and one orphan of each kind
  count as 1 + 1 + 1 + 1 logical accounts.
- **Ownership/identity:** the reconcile action carries the cash id, never the brokerage id; the
  pair delete issues brokerage-first; a rename from either half converges both names.
- **Concurrency:** close from the brokerage half cascades in one transaction -- a concurrent
  transaction insert on the cash half either lands before the close or is refused, never
  half-closed.
- **Dates:** `futureTransactionsSum` stays inside `combinedValue` exactly as it is inside
  today's per-row balances (no new date math).
- **Orphans:** every surface spec above is asserted for both orphan shapes, not only the pair.

## Explicit v1 scope cuts

No data-model merge and no migrations. Pair creation and all importers untouched. No
stored-name migration. The `/investments` page is not rebuilt on `InvestmentRegisterPanel` (only
the toggle is shared) -- named follow-up. Accounts-page group totals and summary cards keep
their known-components sums (a pre-existing contract gap, now documented -- fixing it means
threading nullable totals through the summary cards and is a named follow-up). No expandable
sub-rows in the balances report. Net-worth snapshot internals (two rows per pair in
`monthly_account_balances`) unchanged -- the month totals are already correct. AI Assistant and
MCP account listings (`getLlmAccounts`) unchanged -- they already state the per-account value
rule. Import-wizard account pickers keep raw names.

## Critical files

- `frontend/src/lib/account-utils.ts` -- the fold's building blocks; `logical-accounts.ts` lands beside it
- `frontend/src/hooks/useMainAccountName.ts` -- suffix stripping; gains `useAccountOptionLabel`
- `frontend/src/components/accounts/AccountList.tsx` + `frontend/src/components/accounts/AccountRow.tsx` -- the single-row fold, actions, dialogs
- `frontend/src/components/accounts/investment-detail/InvestmentDetailView.tsx` -- merged detail, hosts the register panel
- `frontend/src/components/accounts/AccountForm.tsx` -- pair mode
- `frontend/src/components/reports/ReportAccountMultiSelect.tsx` -- picker-mode unification
- `backend/src/accounts/accounts.service.ts` -- close/reopen symmetry, holdings guard, rename propagation
- `backend/src/securities/portfolio-calculation.service.ts` -- `unpricedHoldingsCount`, the contract-critical backend addition

## Follow-ups

None.
