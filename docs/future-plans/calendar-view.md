# Calendar view for the Transactions and Investments pages

Design for a month-grid calendar that can stand in for the register on the
Transactions page and for the transactions section on the Investments page.
Inspiration: the Quicken for Mac calendar (colour-coded transactions per day,
actual daily balances for past dates and projected balances for future dates,
a day's detail on click, and a per-day investment gain/loss summary). This is
the approved-spec half of a two-document plan; the task list is
[`calendar-view-tasks.md`](./calendar-view-tasks.md).

This document is the specification `docs/financial-calculation-contract.md`
section 9 asks for: it reports money and reads two time series, so it carries
the invariants, truth tables, numerical examples, missing-data policy and test
matrix, and it is committed before any implementation. Per `CONTRIBUTING.md`
it is also the proposal: nothing in the task list starts until a Discussion
has agreed it.

The two choices the proposal asked the maintainer to confirm explicitly are
settled, and the answer to both is the one this document already argued for:
the app's own palette colours the chips (decision 4), and the daily change is
the movement net of external flows (decision 8). Neither alternative is open.

## 1. Goal

- A **Table / Calendar** toggle on both pages. Table is what exists today and
  is unchanged. Calendar replaces the register card (Transactions) or the
  brokerage-and-cash register section (Investments) with a month grid.
- **Transactions page, calendar mode:** two layers the user can switch on
  independently, at least one always on: **Transactions** (the register's rows
  and the scheduled occurrences that fall in the month, as colour-coded chips)
  and **Balances** (one end-of-day total across the accounts in scope; actual
  through today, projected after it).
- **Investments page, calendar mode:** three layers: **Transactions** (brokerage
  trades and the cash sleeve's rows), **Values** (the scope's market value plus
  cash per day, history only) and **Daily change** (the day's market movement
  as a percentage, green or red, with a read-only gain/loss popup listing the
  securities that rose and fell).
- Clicking a day opens a day panel listing that day's items with the figures'
  provenance; clicking a real transaction opens the same edit modal the
  register uses; clicking an occurrence goes to Bills & Deposits with that
  schedule highlighted; a day offers "New transaction on this day".
- **A note on any day.** One free-text note per user per date, written and
  read from the day panel on either calendar, shown as a marker and its first
  line in the cell. It is the calendar's only write path, and it moves no
  money (section 6.4).

## 2. What exists, and what this composes

The calendar adds no write path and no new financial arithmetic on the client.
Every figure it prints comes from an endpoint that already owns the rule, or
from one of three new read models built out of those endpoints' services.

| Need | Existing piece | Notes |
|---|---|---|
| A month's real transactions | `transactionsApi.getAllPages` over `GET /transactions` with the page's filters | The server applies the filters (`docs/frontend/api-and-cache.md`, "A filter the server can apply"). |
| A month's brokerage rows | `investmentsApi.getAllTransactionPages` over `GET /investment-transactions` | Same. |
| Scheduled occurrences with the amount each would post | `scheduledTransactionsApi.getOccurrences({ through })` (`ScheduledOccurrenceService`) | INV-OCCURRENCE-003. The Bills page calendar expands recurrences in the browser and is exempt only because it prints no amounts; the new calendar prints amounts, so it is not. |
| Per-account daily ledger balances | `GET /accounts/daily-balances` (`AccountsService.getDailyBalances`) | Per account, in the account's currency, no conversion. |
| Per-account projected balances | `GET /accounts/:id/balance-forecast` (`BalanceForecastService`) | Withholds the whole series when one occurrence cannot be priced; names the gaps. |
| Daily investment value | `GET /net-worth/investments-daily` (`NetWorthService.getDailyInvestments`) | One point per calendar day at the latest accepted close on or before it; carries `fxComplete` / `missingRatePairs` but, today, silently skips an unpriced holding (section 6.2). |
| "Was this a trading day for this portfolio" | `GET /net-worth/investments-first-priced-day` | The predicate generalised to a set of dates is what the change layer needs. |
| The day's market movement, net of the user's own contributions | `docs/specs/portfolio-movement-notifications.md`, `PortfolioMovementAlertService.externalFlow`, `portfolio-movement.util.ts` | The measure and its invariants are already decided there; this plan reuses them rather than adopting the price-only measure (which misreports a dividend). |
| Per-security close-to-close change | `PortfolioService.getMonthOverMonthMovers` | The right shape at the wrong granularity; the template for the popup's rows. |
| Week start | `user_preferences.week_starts_on`, `usePreferencesStore(...weekStartsOn)` | Already read by the Transactions page. The Bills calendar hardcodes Sunday; the new grid does not. |
| Today | `useFinancialToday()` on the client, `todayYMD()` on the server | Projected-or-actual is decided by the server's `today`, echoed in the response (invariant I2). |
| A month grid | `app/bills/page.tsx` (calendar mode) and `components/reports/UpcomingBillsReport.tsx` | Two hand-rolled copies. This plan extracts one `MonthGrid`; the two copies migrate in a follow-up task. |
| A segmented view toggle | `components/investments/InvestmentViewToggle.tsx` | The control pattern (`aria-pressed`) `ViewModeToggle` copies. |
| Per-surface browser-local preference | `store/densityStore.ts` + `useDensityPreference(view)` | The store pattern `viewModeStore` copies, including its entry in `persisted-storage.guard.test.ts`. |
| Colours | `ACCOUNT_TYPE_META` (`lib/account-type-meta.tsx`), `SCHEDULED_KIND_CHIP_CLASSES` / `occurrenceKind` (`lib/scheduled-kind.ts`), `balanceColor` and `gainLossColor` (`lib/format.ts`) | Each is the one mapping for its question; `ui-conventions.test.ts` fails a second. |

## 3. Product decisions

1. **The toggle is per surface and browser-local.** `viewModeStore` holds
   `{ transactions, investments }` -> `{ view: 'table' | 'calendar', layers }`
   in one persisted store, the density store's pattern: which view a screen
   shows is a fact about the screen, not the user, and a laptop and a desktop
   need not agree. It is not a `user_preferences` column and not a URL param.
2. **The calendar's month is its own state, not the register's date filter.**
   Prev / next / Today controls; opens on the current month each visit. In
   calendar mode the date-range selector is hidden (the month is the date
   filter); every other filter (accounts, categories, payees, search, statuses,
   tags, attachments) still applies to the Transactions layer because the
   server applies it. The Balances and Values layers are scoped by **accounts
   only**: a balance is not a filtered figure.
3. **Scope is the page's account filter.** Transactions page: the filter's
   accounts, or every active account when none is chosen. Investments page:
   the selected investment accounts (with their linked cash sleeves), or all.
4. **Colour is the app's own palette, not Quicken's three families.** Confirmed
   by the maintainer. A real
   transaction's chip takes `ACCOUNT_TYPE_META[account.accountType].pillClass`,
   the same colour the account list already shows for that type. A scheduled
   occurrence's chip takes `SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(...)]`,
   drawn with a dashed border and a clock icon so a pending item cannot be
   read as a posted one, and an overdue occurrence (due before today, not
   posted) carries an "overdue" marker. A legend lists the account types and
   the "scheduled" treatment present in the month. Inventing a three-colour
   family mapping would be a second type-to-colour switch, which the guard
   fails, and would disagree with the rest of the app.
5. **One economic event, one chip.** On the Investments calendar a cash-sleeve
   row that carries `linkedInvestmentTransactionId` is dropped when its
   brokerage row is in scope; the trade is the chip. Both legs of an ordinary
   transfer stay, one per account, labelled through `transferDirection`.
6. **A balance is projected after the server's today, actual on and before it.**
   The Balances layer reads one new endpoint (section 6.1) that stitches the
   ledger history to the per-account forecasts and converts each day at that
   day's rate (history) or today's rate (projection). A projected figure is
   printed in italics with a clock marker and the word "projected" in the day
   panel; it is never printed under an actual's caption.
7. **An investment value is never projected.** The Values layer stops at today.
   A market value has no honest forward series, and projecting the cash sleeve
   alone would put a subtotal under the value's caption.
8. **The daily change is the movement net of external flows** (confirmed by the
   maintainer), exactly the
   measure `docs/specs/portfolio-movement-notifications.md` adopted and for the
   same reason: a price-only measure shows an ex-dividend drop as a loss the
   user did not take, and a deposit day as a gain the market did not produce.
   `movement(d) = MV(d) - MV(d-1) - externalFlow(d)`, `pct = movement / MV(d-1)`.
9. **A non-trading day shows no percentage.** A weekend or holiday carries the
   previous close forward, so the arithmetic yields exactly zero, which is
   indistinguishable from a flat session (`docs/time-series-contract.md`
   section 2.3). A day on which no held security has an accepted close dated
   that day is blank in the change layer; blank and "unknown" are two different
   renderings (section 8).
10. **The gain/loss popup is read-only and reconciles to the headline.** Its
    rows are per-security price moves on the position held at that day's
    close; a single "Cash, distributions and trades" line carries the
    difference between the headline movement and the sum of the rows, so the
    popup adds up to the number the cell shows.
11. **The two legacy month grids migrate to `MonthGrid` afterwards, as their own
    PRs** (task M1). Until then a shrink-only baseline in `ui-conventions.test.ts`
    names the two files.
12. **A day note is one row per user per date, owner-only, plain text.** The
    same note appears on both calendars because it belongs to the day, not to
    a page or an account.

    > **Amended after the plan shipped.** A note now covers a RUN of
    > consecutive days -- `note_date` through `end_date`, inclusive -- so a
    > vacation is one note rather than nine. Everything else in this decision
    > stands. "One row per date" becomes "at most one note covering any date",
    > and the mechanism for it is no longer the UNIQUE constraint but the
    > exclusion constraint `ex_calendar_day_notes_user_span` over
    > `daterange(note_date, end_date, '[]')`, which is what lets the editor be
    > opened from any day the span touches. See INV-DAYNOTE-001 and
    > `docs/backend/modules-and-runtime.md`, both of which are canonical over
    > the sketch in section 6.4 below.
 It is bounded at `CALENDAR_DAY_NOTE_MAX_LENGTH`
    (2000 characters), mirrored in both layers the way
    `TRANSACTION_NOTE_MAX_LENGTH` is, so the textarea stops the user at the
    cap instead of the save reporting it. A delegate acting for an owner sees
    no note and no note affordance: a note is personal, and the route is not
    `@AllowDelegate`. Saving is an explicit Save (this is a form, not a
    settings screen); clearing is Delete. The note is rendered through
    `LinkifiedText`, never as HTML.

## 4. Definitions

- **Grid day**: a `YYYY-MM-DD` string. The grid for month `M` under week start
  `w` is the whole weeks from the `w`-day on or before the 1st of `M` to the
  day before the next `w`-day after the last of `M` (`monthGridDays`,
  `lib/calendar-month.ts`). That is 35 or 42 days for almost every month, and
  28 for a non-leap February whose 1st falls on `w`, where four whole weeks
  already cover the month and a fifth would hold days neither `M` nor the
  week-completion rule asks for.
- **Scope**: the ordered set of account ids a layer is asked about. The
  Investments page's scope resolves linked pairs server-side exactly as
  `getDailyInvestments` does today.
- **today**: the server's `todayYMD()` echoed in every response that
  distinguishes actual from projected. The client marks a day projected by
  `date > response.today`, never by its own clock.
- **MV(d)**: the scope's market value plus cash at the close of `d` in the
  reporting currency, as `getDailyInvestments` computes it, with both
  completeness bits (`fxComplete`, `pricesComplete`).
- **externalFlow(d)**: net cash that crossed the scope's boundary on `d`, as
  the portfolio-movement spec defines it (deposits and withdrawals in scope
  accounts, transfer legs whose counterparty is outside the scope; never an
  investment-linked leg, never a transfer within the scope, never a VOID or
  future-dated row).
- **Trading day**: `d` on which at least one security held at the close of
  `d` has a `security_prices` row dated `d`, whatever its source (a provider
  bar, a manual price, a transaction-derived price all count, as they do for
  valuation).

## 5. Invariants

| # | Invariant | Mechanism |
|---|---|---|
| I1 | **Every figure the calendar prints is the server's.** A day's rows come from the register endpoints under the page's own filters; an occurrence's amount, date and direction from `/scheduled-transactions/occurrences`; a balance, value or change from the endpoints in section 6. The client expands no recurrence and sums nothing across days or accounts. | `scheduled-effective-amount.guard.test.ts` is not widened; `calendar.guard.test.ts` fails a `.reduce(` or `+=` over an amount, a `balance`, a `value` or a `movement` under `components/calendar/`. INV-OCCURRENCE-003, INV-BALANCE-001, INV-HOLDING-002. |
| I2 | **Projected is decided by the server's day.** `isProjected` is `date > response.today`; a day cell never consults the client clock to choose the caption. | The response carries `today`; the client helper `classifyCalendarDay` takes it as an argument and has no default. |
| I3 | **Unknown is not zero and not empty.** A `null` total, value or movement renders the unknown marker in the cell and its cause in the day panel and in a banner above the grid; a non-trading day renders nothing in the change layer, which is a third state. | `partial-total-marker.guard.test.ts`; component tests per row of truth tables A and B. `docs/financial-calculation-contract.md` section 1. |
| I4 | **A change needs two complete values of two different observations.** `movementPercent` is non-null only when `isTradingDay`, both `MV(d)` and `MV(d-1)` carry `fxComplete && pricesComplete`, the flow is complete and `MV(d-1) > 0`. | Decided once in `DailyMovementService.decide` (a pure function, table-tested); the client reads `complete === true` and never recomputes. `docs/time-series-contract.md` sections 2.3 and 3. |
| I5 | **One economic event, one chip** (decision 5). | `dedupeInvestmentLegs` in `lib/calendar-rows.ts`, unit-tested against a BUY with its cash leg, a cash-only deposit, and a scope holding the cash sleeve without its brokerage. |
| I6 | **Colour comes from the existing mappings** (decision 4). | `ui-conventions.test.ts` already fails a second type-to-pill mapping; `calendar.guard.test.ts` fails a `text-green-`/`text-red-` literal outside `gainLossColor`/`balanceColor` and a `bg-*-100` literal outside the two chip maps under `components/calendar/`. |
| I7 | **A layer's data belongs to its request key**: month, scope, the filter signature, the display currency. A stale month may stay on screen while the next loads, marked `aria-busy` and non-actionable; a failed fetch renders the retryable error state, never an empty month. | `useCalendarMonthData` stamps `dataKey`; tests follow the deferred-promise matrix in `docs/frontend/api-and-cache.md`. |
| I8 | **A write from the calendar invalidates what the register's writes invalidate.** The calendar opens the pages' existing modals and handlers; the three new client caches use the `accounts:` and `investments:` prefixes so `invalidateBalanceCaches()` drops them. | `balance-cache.guard.test.ts`, `cache-prefix-classification.guard.test.ts`. INV-CACHE-001. |
| I9 | **The calendar adds no money-moving write path and changes no register contract.** Its one write is the day note (section 6.4), which touches one table nothing financial reads. Table mode is byte-identical after every task. | Each task's acceptance re-runs the register suites untouched; `balance-cache.guard.test.ts` has nothing to say about the note client because it moves nothing. |
| I10 | **The three new read models are `withScopedDb` reads** with `userId` from the JWT, `@AllowDelegate` + the same joint-account widening `daily-balances` uses, DTO-bounded dates (`IsCalendarDate`) and a range cap of `CALENDAR_RANGE_MAX_DAYS = 93`. | DTO specs; `docs/backend/database-access-and-tenancy.md`. |
| I11 | **A day note is written once, whole, by its owner.** The upsert is a single `INSERT ... ON CONFLICT (user_id, note_date) DO UPDATE` under `withScopedDb` with `userId` from the JWT, so two saves of the same day cannot interleave and a save never reads first; the body is bounded by the DTO and the mirrored constant; the table carries the direct RLS policy in its own migration. | `UNIQUE (user_id, note_date)`; `calendar-day-note.contract.spec.ts` (the two layers' constants agree); the RLS enforcement suite; the DTO spec. |
| I12 | **A note belongs to the date it was opened for.** An edit captures its date when editing starts; the response is adopted only while the panel still shows that date; a dirty note survives a month change behind a confirmation. | Component tests follow the keyed-form matrix in `docs/frontend/api-and-cache.md`. |

## 6. Data contracts (new and changed)

### 6.1 `GET /accounts/daily-balance-totals` (new)

Query: `startDate`, `endDate` (calendar dates, `endDate - startDate <= 93`),
`accountIds` (CSV UUIDs, optional; absent means every active account of the
user), `displayCurrency` (optional; defaults to `preferredCurrency`).

```typescript
interface DailyBalanceTotalsResponse {
  startDate: string;
  endDate: string;
  today: string;              // the server's financial today; decides isProjected
  currencyCode: string;       // the one currency every scoped account shares, else displayCurrency
  days: Array<{
    date: string;
    total: number | null;     // null unless every scoped account converted (history) or every forecast is complete (projection)
    knownSubtotal: number;    // FxAggregate.knownSubtotal; equals total when total is known
    isProjected: boolean;     // date > today
    missingRatePairs: string[]; // "USD->CAD", history days: the day's rate; projected days: today's rate
  }>;
  forecast: {
    complete: boolean;        // false withholds total on EVERY projected day
    gaps: BalanceForecastGap[]; // union over the scoped accounts, each naming its schedule and reason
  };
}
```

Service `DailyBalanceTotalsService` (`backend/src/accounts/daily-balance-totals.service.ts`):

- History (`date <= today`): the per-account rows `AccountsService.getDailyBalances`
  already produces for the range (no downsampling inside 93 days), summed per
  day through `FxAggregate` with a rate index by date. The rate index is the
  one `NetWorthService.buildRateIndex` builds; it moves to
  `backend/src/common/time-series/rate-index.util.ts` so the two services read
  one table the same way (task B1 extracts it; the net-worth suite proves the
  move is a no-op).
- Projection (`date > today`): `BalanceForecastService.getBalanceForecast(userId, id, days)`
  per scoped account. If any is incomplete, `forecast.complete` is false, every
  projected `total` is `null`, and `gaps` is the union. Otherwise per-day
  points are summed through `FxAggregate` at **today's** rate (a projection is
  priced today; the day it is about has no rate yet).
- A scope in one currency converts nothing: `currencyCode` is that currency and
  `missingRatePairs` is always empty. This is what makes a single account's
  calendar agree with its register's balance column to the cent.
- `currentBalance` is never read; both halves are ledger sums under
  `LEDGER_MOVEMENT_PREDICATE`, as `getDailyBalances` and the forecast already are
  (INV-BALANCE-001, INV-TRANSFER-001: a VOID row moves nothing on either side).

### 6.2 `GET /net-worth/investments-daily` (changed, additive)

Each point gains `pricesComplete: boolean` and `unpricedSecurityIds: string[]`.
Today the walk skips a held position with no accepted close on or before the
day (`if (price != null)`), so `value` is a subtotal with nothing beside it to
say so. The flags are added without changing `value`, so every existing chart
keeps drawing; the calendar reads `pricesComplete === false` as unknown
(`docs/system-invariants.md` INV-HOLDING-002 says the replay is shared; the
completeness bit is what was missing).

Making `value` itself `null` on such a day is the contract's real answer and a
behaviour change to four charts; it is reported to the maintainer as a
separate proposal, not done here. The client type `DailyInvestmentValue` gains
both fields.

### 6.3 `GET /portfolio/daily-movements` and `GET /portfolio/daily-movements/detail` (new)

Query for both: `accountIds` (optional), `displayCurrency` (optional); the
month endpoint takes `startDate`/`endDate` (`<= 93` days), the detail endpoint
takes `date`.

```typescript
type DailyMovementReason =
  | 'notTradingDay'      // no held security has a close dated d
  | 'unpricedHolding'    // MV(d) or MV(d-1) has pricesComplete false
  | 'missingRate'        // MV(d) or MV(d-1) has fxComplete false, or a security's rate on d is absent
  | 'flowIncomplete'     // an external flow on d could not be converted
  | 'noPriorValue'       // d-1 precedes the scope's inception
  | 'zeroBaseline';      // MV(d-1) === 0: no percentage

interface DailyMovementsResponse {
  currencyCode: string;
  today: string;
  days: Array<{
    date: string;
    isTradingDay: boolean;
    movement: number | null;        // display currency, roundMoney
    movementPercent: number | null; // PORTFOLIO_MOVE_PERCENT_DECIMALS
    complete: boolean;              // movement and movementPercent are non-null iff complete
    reasons: DailyMovementReason[];
  }>;
}

interface DailyMovementDetailResponse {
  date: string;
  currencyCode: string;
  movement: number | null;
  movementPercent: number | null;
  complete: boolean;
  reasons: DailyMovementReason[];
  gains: SecurityDayMove[];         // change > 0, sorted by |change| desc
  losses: SecurityDayMove[];        // change < 0
  unchangedCount: number;           // rows with a close dated d whose close did not move
  remainder: number | null;         // movement - sum(gains) - sum(losses); null when any component is unknown
}

interface SecurityDayMove {
  securityId: string; symbol: string; name: string; currencyCode: string;
  quantity: number;                 // held at the close of d (replayed, INV-HOLDING-002)
  close: number; previousClose: number; previousCloseDate: string;
  priceChange: number;              // close - previousClose, in the security's currency, at price precision (not money)
  changePercent: number | null;     // null when previousClose is 0
  change: number | null;            // quantity * priceChange converted at d's rate; null when the rate is absent
}
```

Service `DailyMovementService` (`backend/src/securities/daily-movement.service.ts`):

- `MV` for `[startDate - 1, endDate]` from `NetWorthService.getDailyInvestments`
  (with 6.2's flags). Days after `today` are not evaluated (no future).
- `externalFlow(d)` through `backend/src/securities/external-flow.util.ts`,
  extracted from `PortfolioMovementAlertService.externalFlow` so the
  notification producer and the calendar are one writer of the rule
  (`investmentLinkedTransactionExclusion` / `investmentLinkedSplitExclusion`
  from `investment-filter.util.ts`, never a hand-written action list;
  INV-REPORT-001).
- `isTradingDay` from one query over `security_prices` for the securities held
  on each day, the `getFirstPricedDay` subquery generalised to a date set.
- `decide(input): { movement, movementPercent, complete, reasons }` is a pure
  function beside `decideMovement` in `portfolio-movement.util.ts`, table-tested
  against truth table B.
- The detail endpoint replays holdings to `d` and reads each security's close
  through `positionCloseAsOf` for `d` and for the previous accepted close, the
  two doors valuation already uses; a security whose latest accepted close is
  not dated `d` contributes no row (its carried close moved nothing).
- Both are `@AllowDelegate` + `@DelegateRequiresSection("investments")` like
  the net-worth investment routes.

### 6.4 Day notes (new table and endpoints)

> **Superseded in part.** The table and the routes below shipped as written and
> then gained multi-day spans (see the amendment to decision 12). `end_date`
> joins `note_date`, the UNIQUE constraint is replaced by an exclusion
> constraint over the inclusive daterange, `PUT` takes an optional `startDate`
> and `endDate` and treats `:date` as the day the note is being written FROM,
> `DELETE` removes the note covering that day, and `DayNote` carries
> `startDate` and `endDate` instead of `date`. `docs/backend/modules-and-runtime.md`
> and INV-DAYNOTE-001 describe what is actually there; the rest of this section
> is kept as the record of what was planned.

Table `calendar_day_notes`, created by a timestamped migration
(`YYYYMMDDHHMMSS_calendar_day_notes.sql`, per `database/CLAUDE.md`) that also
ships the policy and enables row-level security, with `database/schema.sql`
updated in the same commit:

```sql
CREATE TABLE IF NOT EXISTS calendar_day_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_date DATE NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_calendar_day_notes_user_date UNIQUE (user_id, note_date),
    CONSTRAINT ck_calendar_day_notes_body_length CHECK (char_length(body) BETWEEN 1 AND 2000)
);
ALTER TABLE calendar_day_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_day_notes_isolation ON calendar_day_notes;
CREATE POLICY calendar_day_notes_isolation ON calendar_day_notes
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

Two corrections to the sketch above, both made when B4 shipped. The policy
needs **both** arms: `USING` alone filters reads while permitting a write of a
row owned by anyone, which is what `scripts/verify-schema.sh` caught against
`schema.sql`'s uniform loop. And there is **no separate index**: the unique
constraint already builds a btree on exactly `(user_id, note_date)`, which is
the only predicate this table is ever read by, so a second one would be an
extra write per save buying nothing.

The **Direct** bucket, owner only: no delegate arm (decision 12), so the
enforcement suite's uniform-policy check covers it with no map entry. The
`CHECK` is the same number as the mirrored constant; the contract spec pins
all three.

Backup: an export query (`SELECT * FROM calendar_day_notes WHERE user_id = $1
ORDER BY note_date`) in `backend/src/backup/export-table-queries.ts`, a
`restore-plan.ts` entry (`scopeToUser: true`, after `users`), and a
`support-backup-rules.ts` allowlist with everything `keep` except `body`; the
support-backup golden test fails until that decision is made. `body` is
`konst("***")` rather than `drop`: the column is NOT NULL with a minimum-length
`CHECK`, and a support backup restores through the same path as any other, so a
null there is a row no restore can insert.

Module `backend/src/calendar/` (`calendar.module.ts`,
`entities/calendar-day-note.entity.ts`, `calendar-day-notes.controller.ts`,
`calendar-day-notes.service.ts`, `dto/day-notes-query.dto.ts`,
`dto/upsert-day-note.dto.ts`), the constant in
`backend/src/common/calendar-day-note.ts` mirrored by
`frontend/src/lib/calendar-day-note.ts` and held equal by
`backend/src/common/calendar-day-note.contract.spec.ts`.

```typescript
// GET /calendar/day-notes?startDate&endDate   (<= 93 days; AuthGuard('jwt'), not @AllowDelegate)
interface DayNote { date: string; body: string; updatedAt: string }
// -> DayNote[] ordered by date

// PUT /calendar/day-notes/:date   body { body: string }  (1..CALENDAR_DAY_NOTE_MAX_LENGTH after trim)
// -> DayNote. One statement: INSERT ... ON CONFLICT (user_id, note_date) DO UPDATE SET body, updated_at.
// A blank body is a 400, never a delete.

// DELETE /calendar/day-notes/:date -> 204; deleting a day with no note is 204 too (idempotent).
```

`:date` is validated as a calendar date by a param pipe built on
`isCalendarDate` (`backend/src/common/validators/is-calendar-date.validator.ts`);
`ParseUUIDPipe` does not apply because the key is the date. The DTO runs with
`whitelist` + `forbidNonWhitelisted`; `body` is `@IsString() @MaxLength(...)`
and trimmed. `userId` comes from the JWT on every route. The client keeps the
list under `calendar:day-notes:<start>:<end>` (classified in
`cache-prefix-classification.guard.test.ts` as not balance-derived) and drops
it on its own writes.

## 7. Truth tables

### A. Balance cell (Transactions page), day `d`

| `d` vs `today` | History FX on `d` | Forecast | Cell | Day panel |
|---|---|---|---|---|
| `d <= today` | every pair known | n/a | total, `balanceColor` | "Balance at end of day", per-account rows |
| `d <= today` | a pair missing | n/a | unknown marker | names the pair(s) and the fix (Currencies) |
| `d > today` | n/a | complete, today's rates known | total, italic, clock marker | "Projected", the occurrences that moved it |
| `d > today` | n/a | complete, a pair missing at today's rate | unknown marker | names the pair(s) |
| `d > today` | n/a | incomplete | unknown marker | names each gap: schedule, reason (`unresolvedSettlementRate` / `crossCurrencyTransfer`) |
| any | scope empty | n/a | layer not rendered | notice "no accounts in scope" |
| any | request failed | n/a | retryable error state over the layer | never an empty month |

A scope in a single currency is always "every pair known".

### B. Change cell (Investments page), day `d`

| `isTradingDay` | `MV(d)` complete | `MV(d-1)` complete | flow complete | `MV(d-1) > 0` | Cell | `reasons` |
|---|---|---|---|---|---|---|
| no | any | any | any | any | blank | `notTradingDay` |
| yes | yes | yes | yes | yes | percentage, `gainLossColor`; exactly zero is neutral | none |
| yes | no | any | any | any | unknown marker | `unpricedHolding` and/or `missingRate` |
| yes | yes | no | any | any | unknown marker | `unpricedHolding` / `missingRate` / `noPriorValue` |
| yes | yes | yes | no | any | unknown marker | `flowIncomplete` |
| yes | yes | yes | yes | no | blank | `zeroBaseline` |
| `d > today` | | | | | blank, layer stops | not evaluated |

The client renders from `complete` and `reasons`; it never re-derives a row of
this table.

### C. Transactions-layer chip

| Item | Chip | Label | Click |
|---|---|---|---|
| Real transaction on account type `T` | `ACCOUNT_TYPE_META[T].pillClass` | payee (`usePayeeDisplay`) and amount (`formatCurrency(amount, currencyCode)`) | the page's edit modal |
| Real, `status === 'VOID'` | same, struck through | same | same |
| Real, `transactionDate > today` | same, dimmed like `TransactionRow.isFuture` | same | same |
| Cash-sleeve row with `linkedInvestmentTransactionId`, brokerage in scope | dropped (I5) | | |
| Brokerage row | `ACCOUNT_TYPE_META.INVESTMENT.pillClass` | symbol, action label, total | the investment edit modal |
| Occurrence, `dueDate >= today`, `amountComplete` | `SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind]`, dashed, clock | name and amount in its own `currencyCode` | `/bills?highlight=<scheduledTransactionId>` |
| Occurrence, `amountComplete === false` | same | name and `UnknownAmount` | same |
| Occurrence, `dueDate < today`, unposted | same plus overdue marker | same | same |
| More than `CALENDAR_DAY_CHIP_LIMIT` on a day | first N chips plus "+K more", from `sm` up | | the day panel |
| More than `CALENDAR_MAX_ROWS` (1000) in the grid | layer withheld with a notice to narrow the filters | | |

An occurrence is in scope when `occurrenceTouchesAccounts(occ, scope)` says so,
a helper added beside `occurrenceSettlementAccountId` in
`lib/scheduled-effective-amount.ts` so the account an occurrence charges is
decided in the one file the guard already watches.

### D. Gain/loss popup row, security `s`, day `d`

| `s` has an accepted close dated `d` | `quantity(d)` | Rate `s.currency -> display` on `d` | Row |
|---|---|---|---|
| yes | non-zero | known | in `gains` / `losses` / `unchangedCount` by the sign of `priceChange` |
| yes | non-zero | absent | row listed with `change: null`; `complete` false, `remainder` null |
| yes | zero | any | no row |
| no | any | any | no row |
| yes, but no previous accepted close | any | any | no row; the position's whole value sits in `remainder` |

### E. Day note, day `d`

| Session | Note on `d` | Cell | Day panel |
|---|---|---|---|
| owner | exists | note glyph and the first line, truncated; on a phone the glyph only | body through `LinkifiedText`; Edit; Delete |
| owner | none | nothing | "Add a note" |
| owner, editing `d`, month or day changed | any | | confirmation; the draft survives a cancel |
| owner, Save for `d` in flight, panel now shows `d2` | any | | response for `d` discarded; the list refetched; `d2`'s form untouched |
| owner, Save fails | any | unchanged | the error beside the form; the draft kept |
| delegate acting for the owner | any | nothing | no note section at all |
| list request failed | | notes absent, marked as failed in the banner | other layers untouched |

## 8. Numerical examples

All money at 4dp internally, printed at 2dp; percentages at 2dp.

1. **Balances, two currencies, reporting CAD.** Scope: Chequing (CAD) and
   Savings (USD). On 2026-06-15 Chequing closes at 1,234.5600 and Savings at
   1,000.0000; the USD->CAD rate on 2026-06-15 is 1.3650. `total` = 1,234.56 +
   1,365.00 = **2,599.56 CAD**. On 2026-06-16 no USD->CAD rate exists for that
   date: `total: null`, `knownSubtotal: 1234.56`, `missingRatePairs: ["USD->CAD"]`;
   the cell shows the unknown marker and the panel names the pair.
2. **Projection.** `today` = 2026-09-11. Actual total at the close of today is
   2,600.00 CAD. Occurrences: rent -1,500.00 on 09-15, payroll +2,000.00 on
   09-19. 09-14 projects 2,600.00; 09-15 projects 1,100.00; 09-19 onward
   projects 3,100.00, all italic with the clock marker. If the rent schedule
   is a cross-currency transfer with no rate, `forecast.complete` is false,
   every projected day is `null`, and the panel names the rent schedule and
   `crossCurrencyTransfer`; 09-11 itself still shows 2,600.00 because it is
   history.
3. **Daily change, a deposit and a trade on the same day.** `MV(09-10)` =
   100,000.00; on 09-11 the user deposits 1,000.00 into the cash sleeve
   (external) and buys 500.00 of ABC (internal); ABC's 100 shares close
   50.00 -> 52.00, XYZ's 40 shares close 25.00 -> 24.50, DEF pays a 20.00
   dividend and closes unchanged. `MV(09-11)` = 101,200.00. `movement` =
   101,200 - 100,000 - 1,000 = **+200.00**, `movementPercent` = **+0.20%**,
   green. Popup: gains ABC +200.00; losses XYZ -20.00; `unchangedCount` 1;
   `remainder` = 200 - (200 - 20) = **+20.00**, the dividend cash. The popup
   sums to the headline.
4. **Weekend.** 09-12 (Saturday): no held security has a close dated 09-12;
   the cell is blank, `reasons: ["notTradingDay"]`, even though a 500.00
   deposit landed that day. On Monday 09-14, `MV(d-1)` is Sunday's carried
   value, which already holds the weekend deposit as cash, and `externalFlow`
   counts Monday's flows only, so the deposit is neither a gain nor a loss.
5. **First day of holdings.** `MV(d-1)` = 0: `movementPercent: null`,
   `reasons: ["zeroBaseline"]`, the cell blank; `movement` may still be shown
   in the panel as an absolute figure when otherwise complete.
6. **An unpriced holding.** A GIC held since 2026-03-01 with no price row at
   all: `pricesComplete` false on every day, so the Values layer shows the
   unknown marker (with `unpricedSecurityIds` naming it) and the change layer
   shows unknown with `unpricedHolding` on every trading day. Entering one
   manual price repairs every day from that date forward.

## 9. Missing-data policy

- A total, value or movement is `null` unless every component is known
  (`docs/financial-calculation-contract.md` section 1); the partial sum, where
  returned, is `knownSubtotal` and is printed only under a "partial" caption in
  the day panel, never in the cell.
- No rate defaults to 1, no price to the purchase price or 0, no flow to 0
  (INV-FX-001; `fx-fallback.guard.spec.ts`).
- A projected series with one unpriceable occurrence is withheld whole and the
  gaps are named (`BalanceForecastService`'s existing rule, carried through).
- A non-trading day is blank, an unknown day shows the marker; the two never
  share a rendering, and the day panel states which it is.
- A completeness flag absent from a response (an older backend mid-deploy) is
  read as no information for a **displayed** value (`pricesComplete === false`
  withholds; absent does not), and the change layer needs the new endpoint, so
  its flags are never absent.
- A failed request is the retryable error state over the affected layer, with
  the other layers untouched; never `days = []`.
- Every withheld figure names its cause where it is withheld: the cell's
  marker, the day panel's reason list, and one banner above the grid composing
  every cause present in the month (missing pairs, forecast gaps, unpriced
  securities, the row cap), with the fix each one has.

## 10. Frontend structure

- `lib/calendar-month.ts` (pure): `monthGridDays(month, weekStartsOn)`,
  `rotateWeekdayLabels(labels, weekStartsOn)`, `shiftMonth(month, delta)`,
  `monthOf(ymd)`, `classifyCalendarDay(date, today)`. Tested against the dates
  table in `docs/testing-contract.md` (leap day, century boundaries, month end,
  year end) for every `weekStartsOn` 0..6.
- `components/ui/MonthGrid.tsx`: layout only. Props `month`, `weekStartsOn`,
  `today`, `selectedDate`, `onSelectDay`, `renderDay(day)`, `labelledBy`.
  Renders `role="grid"` with weekday `columnheader`s from `common.weekdaysMin`
  rotated, `gridcell`s with `aria-selected`, roving tabindex and arrow-key
  navigation, `aria-current="date"` on today. Below `sm` a cell is the day
  number, a dot row coloured like the chips and a count; the day panel is the
  reading surface there. The page body never scrolls horizontally.
- `components/ui/ViewModeToggle.tsx` and `store/viewModeStore.ts`
  (`ViewModeSurface = 'transactions' | 'investments'`; `view`, `layers`), the
  store listed in `persisted-storage.guard.test.ts` with its reason.
- `components/calendar/`: `CalendarToolbar.tsx` (month navigation, Today,
  layer toggles, legend), `CalendarDayCell.tsx`, `CalendarDayPanel.tsx`
  (`Card` on desktop beside the grid, `Modal` below `lg`), `CalendarBanner.tsx`
  (composed causes), `TransactionsCalendarView.tsx`,
  `InvestmentCalendarView.tsx`, `DailyMovementDialog.tsx` (`Modal`, read-only),
  `calendar.guard.test.ts`.
- `lib/calendar-rows.ts` (pure): `groupRowsByDay`, `dedupeInvestmentLegs`,
  `chipForTransaction`, `chipForOccurrence`; no arithmetic beyond grouping.
- `hooks/useCalendarMonthData.ts` (rows and occurrences keyed by month, scope
  and filter signature), `hooks/useDailyBalanceTotals.ts`,
  `hooks/useDailyMovements.ts`; each stamps `dataKey` and exposes the five
  states (loaded, loading, failed, stale-previous, current).
- Clients: `accountsApi.getDailyBalanceTotals` (cache key
  `accounts:daily-balance-totals:...`, 30 s), `investmentsApi.getDailyMovements`
  and `getDailyMovementDetail` (`investments:daily-movements:...`, 60 s).
- `TransactionForm` and `InvestmentTransactionForm` gain `defaultDate?: string`,
  read only in create mode, beside `defaultAccountId`.
- Page wiring. Transactions: `ViewModeToggle` in the `PageHeader` actions
  beside New; in calendar mode the register card and `ListBottomPager` are
  replaced by `TransactionsCalendarView`, the filter panel stays with its date
  range hidden, and the chart card above is unchanged. Investments:
  `ViewModeToggle` beside `InvestmentViewToggle` in the transactions section's
  header; calendar mode replaces both registers with `InvestmentCalendarView`;
  everything above the section is unchanged.
- Figures: `useNumberFormat()` (`formatCurrency`, `formatPercent`) for every
  number; `useDateFormat().formatMonth` for the month caption and
  `formatDate` for the day panel title; `useFinancialToday()` only to decide
  which month opens and to dim a future-dated real row (the projected caption
  is the server's, I2).
- i18n: a new `calendar` namespace registered in `src/i18n/messages.ts`;
  weekday labels stay in `common.weekdaysMin`; `bills.calendar.*` is untouched
  until M1. Every string composed in the catalog (`docs/frontend/ui-conventions.md`,
  "Copy").
- Writes: the calendar calls the pages' existing `handleEdit`, `openCreate`,
  `refreshAfterWrite`; on the Transactions page the refresh hook is the page's
  `loadTransactions` counterpart for the month, keyed off `writeRefreshKey`.

## 11. Test matrix

| Layer | Test | Proves |
|---|---|---|
| frontend unit | `lib/calendar-month.test.ts` | grid days for every week start; leap day, 2100-02-28, month end, year end; `classifyCalendarDay` with `today` passed in |
| frontend unit | `lib/calendar-rows.test.ts` | I5 dedupe cases; grouping; VOID and future flags carried, never used to drop a row |
| frontend unit | `MonthGrid.test.tsx` | roles, arrow-key navigation, `aria-current`, phone layout, no horizontal overflow |
| frontend unit | `TransactionsCalendarView.test.tsx` | truth tables A and C row by row; the row cap withholds; the banner composes causes; the request-key matrix from `docs/frontend/api-and-cache.md` (A starts, B starts, B resolves, A resolves late -> B shown) |
| frontend unit | `InvestmentCalendarView.test.tsx`, `DailyMovementDialog.test.tsx` | truth tables B and D; blank vs unknown never share markup; popup sums to headline; exactly-zero is neutral |
| frontend unit | `viewModeStore.test.ts`, `ViewModeToggle.test.tsx` | persistence per surface; `aria-pressed`; at least one layer stays on |
| frontend guard | `components/calendar/calendar.guard.test.ts` | I1 (no client-side sum or recurrence walk under `components/calendar/`), I6 (no colour literal), no `new Date().toISOString()`, every completeness read is `=== false` / `=== true`, never truthiness |
| frontend guard | `ui-conventions.test.ts` (new block) | one month grid: a `grid-cols-7` outside `MonthGrid.tsx` fails, with `app/bills/page.tsx` and `UpcomingBillsReport.tsx` as a shrink-only baseline |
| frontend guard | `persisted-storage.guard.test.ts`, `cache-prefix-classification.guard.test.ts`, `balance-cache.guard.test.ts` | the store is listed; the new cache keys are classified; writes invalidate |
| backend unit | `daily-balance-totals.service.spec.ts` | table A on a two-currency scope; single-currency scope converts nothing; projection withheld whole on one gap; `today` echoed; range cap and DTO validation |
| backend unit | `rate-index.util.spec.ts` | the extraction is a no-op against the net-worth suite's fixtures |
| backend unit | `daily-movement.service.spec.ts`, `decide` table test | table B row by row; example 3 to the cent; example 4 (weekend); `zeroBaseline`; detail rows per table D; `remainder` reconciles |
| backend unit | `external-flow.util.spec.ts` | the extraction keeps `PortfolioMovementAlertService`'s spec green untouched; a dividend leg and a within-scope transfer are internal; a VOID row is nothing |
| backend unit | `net-worth.service.spec.ts` (extended) | `pricesComplete` false and `unpricedSecurityIds` named when a held position has no close; `value` unchanged (additive) |
| backend integration | `calendar-read-models.integration.spec.ts` | the three endpoints under RLS enforcement for an owner, a delegate with the investments section, and a joint grantee; a foreign account id returns nothing |
| backend unit | `calendar-day-notes.service.spec.ts`, `upsert-day-note.dto.spec.ts`, `calendar-day-note.contract.spec.ts` | upsert is one statement (the manager receives no SELECT); a blank body and a 2001-character body are 400; `2100-02-29` is 400 through the pipe; delete is idempotent; the constant, the DTO bound and the `CHECK` agree |
| backend integration | `calendar-day-notes.integration.spec.ts` | under enforcement an owner reads and writes their own note; a delegate acting for the owner gets 403 on every route; two users can hold a note on the same date; the support-backup golden test and a backup round trip carry the table |
| frontend unit | `CalendarDayNote.test.tsx`, `useCalendarDayNotes.test.ts` | truth table E row by row; the textarea carries `maxLength`; the origin-date matrix from `docs/frontend/api-and-cache.md`; the note renders through `LinkifiedText` and a `<script>` body renders as text |
| e2e | `tests/calendar.spec.ts` | seed an account, a past transaction, a scheduled bill and a future-dated row through the factories; toggle to Calendar; the chips appear on their dates; the balance cell for a past day matches the register's running balance; a future day reads "projected"; click a day, open the transaction, edit, reload, the change persists; toggle back to Table. Investments: seed a pair, a security with two closes, a BUY; the change cell shows on the second close's date and the popup lists the security; a Saturday cell is blank. Notes: add a note on a day, reload, it is on the cell and in the panel of both calendars; edit it; delete it; reload, it is gone |

A green suite after a behaviour change is a finding: each task's acceptance
names the test that turned red first.

## 12. Explicit v1 scope cuts

- Month view only: no week or day view, no agenda list.
- No drag-to-reschedule; an occurrence is edited on Bills & Deposits.
- No posting an occurrence from the calendar (the day panel links to Bills,
  where `PostTransactionDialog` already owns that write).
- No projected investment values (decision 7).
- No calendar CSV export and no dashboard widget.
- Making `investments-daily`'s `value` `null` on an unpriced day is reported,
  not done (section 6.2).
- The two legacy grids migrate in M1, each its own PR.
- Day notes are plain text, one per date, owner-only: no rich text, no
  attachments, no per-account notes, no sharing with a delegate, no search,
  no appearance in the register or the dashboard, and no AI-assistant or MCP
  tool. Each of those is its own proposal.

## 13. Critical files

Backend: `backend/src/accounts/accounts.controller.ts`,
`backend/src/accounts/accounts.service.ts` (`getDailyBalances`),
`backend/src/accounts/balance-forecast.service.ts`,
`backend/src/accounts/balance-forecast.util.ts`,
`backend/src/net-worth/net-worth.service.ts` (`getDailyInvestments`,
`buildRateIndex`, `getFirstPricedDay`),
`backend/src/net-worth/position-price.util.ts`,
`backend/src/securities/portfolio.service.ts` (`getTopMovers`,
`getMonthOverMonthMovers`), `backend/src/securities/portfolio.controller.ts`,
`backend/src/notification-center/portfolio-movement-alert.service.ts`,
`backend/src/notification-center/portfolio-movement.util.ts`,
`backend/src/common/investment-filter.util.ts`,
`backend/src/common/fx-aggregate.ts`,
`backend/src/common/validators/is-calendar-date.validator.ts`,
`backend/src/scheduled-transactions/scheduled-occurrence.service.ts`,
`backend/src/common/transaction-note.ts` and
`backend/src/common/transaction-note.contract.spec.ts` (the mirrored-constant
pattern the note length copies), `backend/src/backup/export-table-queries.ts`,
`backend/src/backup/restore-plan.ts`,
`backend/src/backup/support-backup/support-backup-rules.ts`,
`database/schema.sql`.

Frontend: `frontend/src/app/transactions/page.tsx`,
`frontend/src/app/investments/page.tsx`,
`frontend/src/hooks/useTransactionFilters.ts`,
`frontend/src/hooks/useInvestmentData.ts`,
`frontend/src/components/transactions/TransactionForm.tsx`,
`frontend/src/components/investments/InvestmentTransactionForm.tsx`,
`frontend/src/components/investments/InvestmentViewToggle.tsx`,
`frontend/src/store/densityStore.ts`,
`frontend/src/store/persisted-storage.guard.test.ts`,
`frontend/src/lib/scheduled-effective-amount.ts`,
`frontend/src/lib/scheduled-effective-amount.guard.test.ts`,
`frontend/src/lib/scheduled-kind.ts`, `frontend/src/lib/account-type-meta.tsx`,
`frontend/src/lib/format.ts`, `frontend/src/lib/currency-total.ts`,
`frontend/src/lib/accounts.ts`, `frontend/src/lib/investments.ts`,
`frontend/src/lib/net-worth.ts`, `frontend/src/types/net-worth.ts`,
`frontend/src/components/accounts/shared/balance-forecast-state.ts`,
`frontend/src/components/ui/CalendarPopover.tsx`,
`frontend/src/app/bills/page.tsx`,
`frontend/src/components/reports/UpcomingBillsReport.tsx`,
`frontend/src/test/ui-conventions.test.ts`, `frontend/src/i18n/messages.ts`,
`frontend/src/lib/transaction-note.ts`,
`frontend/src/components/ui/LinkifiedText.tsx`.

Docs to touch with the tasks: `frontend/CLAUDE.md` (one row: a month grid is
`MonthGrid`), `docs/frontend/ui-conventions.md` (the entry),
`docs/frontend/financial-figures.md` (calendar figures: projected is the
server's day; blank vs unknown), `docs/backend/transactions-and-money.md` (the
three read models), `docs/system-invariants.md` (INV-OCCURRENCE-003 and
INV-CACHE-001 gain the calendar as a consumer; no new ID).

## 14. Companion task list

[`calendar-view-tasks.md`](./calendar-view-tasks.md) breaks this into
one-session tasks with dependencies, deploy impact and acceptance.
