# Investment Transaction Status

Approved specification for adding reconciliation status (`UNRECONCILED`,
`CLEARED`, `RECONCILED`, `VOID`) to investment transactions, matching the
statuses regular transactions already carry. Written before the implementation,
per `docs/financial-calculation-contract.md` section 9.

## 1. The model

`investment_transactions` gains a `status VARCHAR(20) NOT NULL DEFAULT
'UNRECONCILED'` column reusing the `TransactionStatus` enum values from
`backend/src/transactions/entities/transaction.entity.ts`. The enum is imported,
never forked. There is no `reconciled_date` on investment rows: the reconcile
screen operates on cash accounts only, and stamping a date nobody reads would be
a claim with no reader (revisit if a brokerage reconcile flow is ever built).

An investment transaction can produce up to three kinds of sibling rows, and the
status relationship with each is defined here:

| Sibling | Link | Relationship |
| --- | --- | --- |
| Linked cash transaction | `investment_transactions.transaction_id` | Created with the investment row's status. Afterwards, **only the VOID boundary is shared**; reconciliation states (`UNRECONCILED`/`CLEARED`/`RECONCILED`) are per-ledger, because the cash sleeve is reconciled against a bank statement independently of the brokerage. |
| Linked transfer leg (`TRANSFER_IN` ↔ `TRANSFER_OUT`) | `linked_transaction_id` | Two rows describing one movement of shares. **VOID boundary shared** (crossing propagates to the pair, both legs' holdings move); reconciliation states per-leg. |
| Parent split transaction (embedded rows) | `transaction_split_id` | The parent's status **owns** the embedded row's. The row is created with the parent's status, follows the parent across the VOID boundary, and a direct status change on the embedded row is refused with a pointer at the parent (same rule as `splitTransferLegStatusLocked`). |

## 2. Invariants

1. **VOID means nothing happened, on every axis at once.** A VOID investment
   row moves no shares, no cost basis, and no cash. `UNRECONCILED`, `CLEARED`
   and `RECONCILED` are purely presentational; only crossing the VOID boundary
   moves holdings or balances (mirror of
   `TransactionReconciliationService.applyStatusTransition`).
2. **One row, one event.** A VOID investment row's linked cash transaction is
   VOID; an active row's cash leg is active. Voiding a cash leg directly (via
   `PATCH /transactions/:id/status`, `PATCH /transactions/:id`, or bulk update)
   is refused with a pointer at the investment transaction, exactly as a
   split-transfer counterpart leg is refused today. Reconciliation-state cycling
   on the cash leg stays allowed (per-ledger).
3. **A status crossing that would oversell is refused, atomically.** Voiding a
   BUY whose shares a later SELL disposed of, or un-voiding a SELL the position
   cannot cover, fails `validateNoNegativeHoldingsHistory` inside the same
   transaction — a rejected command must not already have written (contract
   section 7).
4. **Every consumer of investment rows decides whether it reads records or
   effects.** Effects readers (share replays, cost basis, realized/capital
   gains, valuations, net-worth history, cash projections, Monte Carlo inputs,
   import verification) exclude VOID rows. Records readers (the register list,
   row counts, delete guards, backup export, action history, the LLM row lists)
   include them — a VOID row is still a row. The decision is a named predicate
   written once, with a guard spec that fails on an unregistered new query site.
5. **A future-dated VOID row is still VOID.** Future-dated rows never applied
   holdings; VOID rows never will. Crossing the boundary on a future-dated row
   touches no holdings and resolves cash by recalculation, not by delta —
   same as `applyVoidTransitionToMirrorLeg`.
6. **Status is part of what a row is created with**, not applied after: create,
   import, scheduled posting and split-embedding all pass it down, so no path
   can create an active effect for a VOID event.

## 3. Truth table — VOID boundary crossing on one investment row

For a BUY of 10 shares at 100 with commission 10 (cash leg −1,010 in the cash
account, holding +10 shares at unit cost 101):

| Transition | Holdings | Cash leg row | Cash balance |
| --- | --- | --- | --- |
| UNRECONCILED → CLEARED / CLEARED → RECONCILED / etc. | unchanged | unchanged (per-ledger) | unchanged |
| active → VOID | −10 shares | status → VOID | +1,010 |
| VOID → active | +10 shares | status → new status | −1,010 |
| active → VOID, future-dated row | unchanged (never applied) | status → VOID | recalculated (future rows contribute nothing) |
| VOID → VOID (idempotent) | unchanged | unchanged | unchanged |
| active → VOID where cash leg already VOID (pre-migration half-void state) | −10 shares | skipped (already on target side) | unchanged (a VOID leg contributed nothing) |

The reversal reverses only what the row actually contributed
(`deletionBalanceEffect` doctrine): a VOID cash leg deleted or skipped moves no
balance; a future-dated one triggers recalculation.

## 4. Migration and backfill

Migration `157_investment_transaction_status.sql` (idempotent, replayable on
top of `schema.sql`):

- `ADD COLUMN IF NOT EXISTS status VARCHAR(20)`.
- Backfill, only where `status IS NULL`:
  - a row with a linked cash transaction takes the cash leg's status **except
    VOID**, which backfills as `UNRECONCILED`;
  - an embedded row takes its parent transaction's status, same VOID carve-out;
  - everything else `UNRECONCILED`.
- `SET DEFAULT 'UNRECONCILED'`, `SET NOT NULL`, and an index on `(status)`.

**Why VOID is not backfilled.** Historical half-void states exist (a Money
import writes the trade's status onto the cash leg only; a bulk update could
void a cash leg): the cash row says VOID while the shares are still counted.
Backfilling VOID would silently change holdings, gains and net-worth history at
migration time, with no rebuild triggered — a balance change without its
derived-state invalidation. Backfilling `UNRECONCILED` changes **no computed
number anywhere** (the suite staying green over the migration is then expected,
not a hole), keeps the mismatch visible in the UI, and gives the user an
explicit fix: voiding the investment row reverses the holdings and skips the
already-VOID cash leg (last row of the truth table), landing the pair coherent.

## 5. Defaults and creation paths

- Entity/DTO default is `UNRECONCILED`, matching the regular transaction form.
- The linked cash transaction is created with the investment row's status
  (replacing today's hard-coded `CLEARED`). A newly created trade therefore
  posts an `UNRECONCILED` cash leg unless the user picks otherwise — a
  deliberate behavioural change for consistency with the rest of the app.
- Scheduled postings and AI/MCP creations pass no status and get the default.
- `update()` keeps its reverse-then-reapply shape: the reversal keys on the
  row's stored (old) status, the reapplication on the new one, so an edit that
  crosses the boundary composes from the same two halves as everything else.
  An edit updates the cash leg in place (#2370), so its id, tags, attachments and
  links survive. The leg keeps its own status unless the edit changes its
  amount, account, date or currency, or crosses the VOID boundary; then it takes
  the row's status. A row that loses its cash side (BUY to ADD_SHARES) deletes
  the leg.

## 6. Imports

- **.mny**: `mapTransactionStatus(cs, grftt)` already produces the status; the
  writer now also persists it on the `investment_transactions` row (it already
  reaches the cash leg). A Money-voided trade imports fully VOID — no shares,
  no cash — and rows with no cash leg (SPLIT, share transfers) no longer drop
  the status on the floor. The import verification's expected share projection
  skips VOID rows, matching both Money's open tax lots and what the rebuild
  will now compute.
- **QIF/CSV**: the status derivation (`void > reconciled > cleared >
  unreconciled`) is extracted from the regular processor into one shared helper
  used by the regular processor, the investment cash-transfer path (which today
  ignores `void`), and the investment trade path (which today hard-codes
  `CLEARED` on both cash legs and carries nothing on the investment row).
- **QIF parser**: the `C` field accepts `c` (cleared) and `R`/`r` (reconciled)
  in addition to today's `*`/`X`/`x`, in one shared helper replacing the two
  byte-identical switch arms. Quicken writes both; today they silently import
  as unreconciled.
- OFX has no investment path and keeps its "posted = cleared" rule.

## 7. UI

Same conventions as the regular register, sharing the components rather than
copying them:

- The status cell (colored dense letter, click-to-cycle
  `UNRECONCILED → CLEARED → RECONCILED`, VOID excluded from the cycle with the
  existing toast pointing at the form) is extracted from `TransactionRow` into
  a shared component used by both registers, reading the existing
  `transactions` catalog namespace.
- VOID rows render with the same strikethrough/opacity treatment.
- The investment form gains the same four-option status `Select` as
  `TransactionForm` (the only place VOID can be set or cleared), disabled for
  embedded rows with a hint pointing at the parent split.
- `investmentsApi.updateStatus` mirrors `transactionsApi.updateStatus`,
  including `invalidateBalanceCaches()`.

Out of scope, recorded so absence reads as a decision: a brokerage-side
reconcile screen, bulk update for investment rows, status filtering on the
investment register (it has no filter panel), and a `statuses` query param on
`GET /investment-transactions`.

## 8. Missing-data policy

`status` is NOT NULL from this migration on; there is no unknown state. A VOID
row excluded from a total is a **known zero contribution**, not missing data:
it must not turn `totalPortfolioValue`, `fxComplete`, `pricesComplete` or
`valuationComplete` incomplete. Conversely an unpriced VOID row must stop
counting against completeness flags it can no longer affect (it contributes
nothing, so it cannot be the reason a total is unknown).

## 9. Test matrix

From `docs/testing-contract.md`, the classes this code can receive; dates/DST
and string classes are N/A (status is a closed enum; dates only via the
existing future-date boundary).

Backend:

- Create with each status; default when omitted; VOID create applies no
  holdings, posts a VOID cash leg, moves no balance.
- `updateStatus`: each row of the section 3 truth table, plus: no-op same
  status; unknown id; another user's id (404, nothing written); embedded row
  refused; linked transfer leg propagates VOID to the pair (both holdings);
  oversell refusal asserts the thrown error **and** the untouched stored row,
  holdings and balance (contract 7.1).
- `update()` crossing the boundary in both directions; a status-only `update()`
  does not re-resolve the exchange rate (presentation-only edit rule).
- Delete a VOID row: nothing reversed (adversarial: the naive `-amount`
  reversal fails this).
- Holdings rebuild, `getHoldingAt`, realized/capital gains, summary, net-worth
  share replay, portfolio calculation and import verification each exclude a
  VOID row — one adversarial case per formula where a VOID BUY inflates the
  result if included.
- Cash-leg guard: VOID via `PATCH /transactions/:id/status`, `PATCH
  /transactions/:id` and bulk update each refused for an investment-linked cash
  leg; reconciliation cycling still allowed.
- Guard spec: every `investment_transactions` query site is classified
  records/effects; an unregistered site fails.
- Imports: .mny voided trade → VOID investment row + VOID cash leg + excluded
  from verification share counts; QIF `C*`/`Cc`/`CX`/`CR` land on both the
  investment row and its cash legs; QIF trade with no `C` imports UNRECONCILED
  (adversarial against the old hard-coded CLEARED); CSV void row → VOID trade.

Frontend: status cell renders each state; cycle calls `updateStatus` with the
next status; VOID click shows the toast and calls nothing; VOID row styling;
form select present, defaulted, disabled for embedded rows; API helper
invalidates balance caches.
