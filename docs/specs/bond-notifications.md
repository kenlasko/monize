# Spec: bond notifications

Notifications about a person's engine-priced bonds: what is about to happen to
the money in them, what has happened and still needs booking, and which data
the figures wait for. Written before the implementation
(`docs/financial-calculation-contract.md` section 9). Country-agnostic: the
producer reads the engine's valuation and never names a country, a program or a
benchmark.

Requested by the owner on 2026-10-13 ("Zrob 1-6" of a proposal of seven).

## 1. What this adds

Six notification types in one new category, raised by one daily producer from
the engine valuation of every bond-linked security a person holds:

| # | Type | When | Severity |
| --- | --- | --- | --- |
| 1 | `BOND_MATURITY_SOON` | a held series matures within `BOND_MATURITY_NOTICE_DAYS` (14) | INFO |
| 2 | `BOND_INTEREST_PAYMENT` | a held series pays interest today (a coupon, not the maturity payment) | INFO |
| 3 | `BOND_RATE_RESET` | a held lot enters a new interest period today whose rate comes from a benchmark or an announcement | INFO |
| 4 | `BOND_REDEMPTION_UNBOOKED` | a held series has matured and the ledger has no redemption for it | WARNING |
| 5 | `BOND_BENCHMARK_PUBLISHED` | a new observation of a benchmark a held series reads was stored | INFO |
| 6 | `BOND_DATA_MISSING` | a held lot's figures cannot be worked out: an observation, the terms, or a valid purchase date is missing | WARNING |

Every type is at most 30 characters (`notifications.alert_type VARCHAR(30)`); the
category `BONDS` is at most 20 (`notification_preferences.category`). Neither
column has a CHECK constraint, so no migration is needed.

## 2. Invariants

- **INV-BONDNOTIFY-001 (read only).** The producer reads stored terms,
  observations and the ledger; it fetches nothing and writes nothing but
  notification rows (INV-BOND-008).
- **INV-BONDNOTIFY-002 (one row per event).** Each event has a dedupe key
  (section 4); `NotificationService.create` refuses a second row with the same
  key per user, so a re-run, a second replica or a restart raises nothing new.
- **INV-BONDNOTIFY-003 (the engine's figures).** Every amount, rate and date in
  a notification is the engine's: `BondValuationService.valueSecurity` for the
  lot figures and `BondHoldingsService.redemptionSplit` for a payout, so the
  notification and the security page never disagree (a preview is the commit's
  code).
- **INV-BONDNOTIFY-004 (unknown is said, never zero).** An amount the engine
  cannot work out is `null` in `data`, and the copy says it is not known and why
  (the missing observation, the publisher). Never `0`, never omitted silently.
- **INV-BONDNOTIFY-005 (country-agnostic).** No country, program, publisher or
  benchmark literal in the producer; `country-agnostic.guard.spec.ts` covers the
  file.

## 3. The producer

`BondNotificationService` in `backend/src/bonds/`, a daily cron after the bond
jobs it reads (benchmarks 06:25, prices 06:45, series 07:15, all
`Europe/Warsaw`): `@Cron("40 7 * * *", { timeZone: "Europe/Warsaw" })`.

```
users = withSystemContext: SELECT DISTINCT user_id FROM securities
         WHERE bond_program_id IS NOT NULL AND is_active = true   (keyset batches)
for each user (one failure does not stop the others):
  withUserContext(userId):
    T = the user's financial today (as BondPriceService.financialToday)
    for each active bond-linked security of the user:
      v  = valueSecurity(userId, securityId, T)
      v3 = valueSecurity(userId, securityId, T - 3 days)   // for item 2 only
      if v.refusal (lots underivable) -> item 6 with cause LOTS_UNDERIVABLE; next security
      group v.lots by (accountId, instrumentId)
      evaluate items 1-4 and 6 per group, item 5 per user (below)
    dispatch.notify(...) for each event, OUTSIDE any transaction
```

Every notification's `target` is `/securities/<securityId>`. `data` always holds
`securityId`, `accountId` (null for item 5 and item 6 causes not tied to an
account), `instrumentId`, `seriesCode`, `currency` (the program's), and the
type-specific facts below. Amounts are decimal strings in the terms' money
decimals; rates are fractions as decimal strings.

### 3.1 Item 1, maturity soon

A group of OPEN lots whose `maturityDate` M satisfies `T < M <= T + 14`.
`quantity` is the group's sum. The payout is
`redemptionSplit(userId, securityId, accountId, instrumentId, M, quantity)`;
`data` carries `maturityDate`, `quantity`, `payout`, `interest`,
`principalReturned` (null when unknown) and `missing` (the split's refusal code,
or null). Dedupe: `bond:maturity:<accountId>:<instrumentId>:<M>`. The row is
raised by the first run inside the window, so a cron day missed does not lose it.

### 3.2 Item 2, interest payment

From `v3` (valued as of T - 3 days, the window start): each lot's flows after
that day (`knownCashflows` and `projectedCashflows`, so an UNKNOWN flow is
included) of type `INTEREST` dated in the window (T - 3, T] (T - 3 excluded, T - 2,
T - 1 and T included), for a lot whose `maturityDate` is after the flow's date
(the maturity payment is items 1 and 4). Summed per group and flow date; an
UNKNOWN flow makes the sum null. Suppressed when the ledger already holds an
`INTEREST` investment transaction of the security in the account dated the
flow's own date (the person booked it before the cron). `data`: `paymentDate`
(the flow's date), `amount`, `quantity`. Dedupe:
`bond:interest:<accountId>:<instrumentId>:<paymentDate>`, so a re-read of a day
already raised writes nothing. A skipped day is caught up within 3 days; a
longer outage loses the notice (section 6).

### 3.3 Item 3, new interest period

An OPEN lot whose `currentPeriod.start` is in (T - 3, T] (T - 3 excluded, T - 2
included), `currentPeriod.index >= 2`, and
`currentPeriod.rateSource` is `DERIVED` or `ANNOUNCED` (a FIXED or TERMS rate is
not news). Grouped per `(accountId, instrumentId, start)`. `data`: `periodStart`,
`periodEnd`, `periodIndex`, `annualRate`, `rateSource`, and from the matching
`rateSchedule` entry `benchmarkId`, `observation`, `benchmarkValue`, `addend`.
When `annualRate` is null the event is not raised here; item 6 reports it.
Dedupe: `bond:rate:<accountId>:<instrumentId>:<start>` (date-scoped: the
look-back is idempotent).

### 3.4 Item 4, matured and not redeemed

A group of lots with status `MATURED` as of T (the fold keeps a lot until a
REDEEM removes it). `data`: `maturityDate`, `quantity`, and the split at the
maturity date (`payout`, `interest`, `principalReturned`, null when unknown).
Dedupe: `bond:unbooked:<accountId>:<instrumentId>:<maturityDate>`; raised once,
for as long as the state lasts: `NotificationService.purgeOld` keeps a row with
this prefix (read or dismissed, past the 30 day retention) because the dedupe row
is the only memory that the event was raised, and forgets it only once it was
dismissed more than 365 days ago (a very old resolved event may be forgotten).

### 3.5 Item 5, new benchmark observation

Per user, for each benchmark a held OPEN lot's `rateRule.benchmarkId` names: the
newest stored observation (`benchmark_values`, greatest `observation_date`) if
its `retrieved_at` is within the last 7 days. Only the newest one, so a first
fetch of a long history raises one row, not one per month. `data`:
`benchmarkId`, `publisher`, `unit`, `observation` (`YYYY-MM` for a MONTHLY series, the
day for a STEP series), `value`, `publishedOn`, and `affected`: for each held
series reading it, `{ instrumentId, seriesCode, periodStart, annualRate,
rateSource }` of its first period starting after T (or starting on T), at most
20 entries plus `affectedMore` (the count left out). `securityId` and
`accountId` are null; `target` is `/securities/<first affected securityId>`.
Dedupe: `bond:bench:<benchmarkId>:<observation>`. A lot whose rate rule is
`DAILY_INDEX_PLUS_SPREAD` does not name its benchmark here
(`readsBenchmarkForLaterPeriod`): a weekly observation changes the current
period's daily accrual, and there is no later period whose rate is not known yet.

### 3.6 Item 6, missing data

Per security, the causes the valuation reports for its OPEN and REFUSED lots:

| Cause | From | What the reader is told to do |
| --- | --- | --- |
| `OBSERVATION_MISSING` | `valuation.missing[]` (`benchmarkId`, `observation`, `publisher`) with the security's `benchmarkCoverage` (`coveredThrough`, `lastFetchedAt`) | not published yet by the publisher, or the feed has not been fetched since `lastFetchedAt`: refresh on the bond page |
| `TERMS_INCOMPLETE` | `dataCompleteness.termsComplete === false` | refresh the series on the bond page |
| `PURCHASE_OUTSIDE_SALE_WINDOW` | `status === "REFUSED"`, `refusal.params` (`from`, `to`, `purchaseDate`) | correct the purchase date of the transaction |
| `PURCHASE_AFTER_MATURITY` | `status === "REFUSED"`, `refusal.params` (`maturityDate`, `purchaseDate`) | correct the purchase date of the transaction |
| `LOTS_UNDERIVABLE` | `v.refusal` (`code`, `params.action`, `params.date`, `params.quantity`, `rowId`) | names the row (its action and date) and by code: `SERIES_NOT_DETERMINED` / `SERIES_REQUIRED` choose the series on that transaction; `REMOVAL_EXCEEDS_SERIES` the removal exceeds what the account holds of that series; any other code correct the transaction |

`data.causes` is the sorted, de-duplicated list. Dedupe:
`bond:missing:<securityId>:<sha256 of the canonical causes, first 16 hex>`, so a
gap is reported once, and a changed gap is a new row. For `LOTS_UNDERIVABLE` the
hash covers the refusal code, the row id, the date and the action, never the
quantity or any translated text. Like item 4 the row is raised once for as long
as the state lasts: `purgeOld` keeps `bond:missing:` rows and forgets one only
once it was dismissed more than 365 days ago (a very old resolved event may be
forgotten). A rate that is null for
the current period appears here as `OBSERVATION_MISSING`.

## 4. Type, category and copy registration

- `NotificationType`: the six values above. `BOND_NOTIFICATION_TYPES` partition;
  `NotificationCategory.BONDS`; `notificationCategoryOf` maps the six to
  `BONDS`; `notification-category.spec.ts` updated for the new set.
- `NOTIFICATION_PREFERENCE_CATEGORIES` gains `BONDS` (user-configurable);
  `NOTIFICATION_CATEGORY_CHANNELS.BONDS` =
  `{ email: true, emailNotification: true, push: true, unifiedpush: true }`;
  `NOTIFICATION_CATEGORY_DEFAULTS` uses the global defaults.
- `PUSH_CATEGORY_COPY.BONDS` with `push.notification.bonds`.
- `composeLocalizedNotificationCopy` composes each type from `data` with
  `emailTranslator` and `number-locale.util.ts` (recipient locale), and says
  "not known yet" for a null amount, naming the missing observation.
- Stored `title` and `message` are the English fallback.
- Frontend: the type mirror (`frontend/src/types/notification.ts`), the
  category in `notification-preferences.ts` and the matrix, client copy in
  `useNotificationCopy.ts` from `data` with `useNumberFormat()`, the list's
  per-type branch, and the target mapping; held by
  `notification.contract.test.ts`, `notification-preferences.contract.test.ts`
  and `notification-target.contract.test.ts`.
- Every new string English-first, pseudo-locale regenerated, every locale
  translated.
- `docs/cron-jobs.md` gains the cron's row; the producer's file is added to
  `WITH_CONTEXT_ALLOWLIST`.

## 5. Worked examples

| Case | Inputs | Result |
| --- | --- | --- |
| EDO maturity | 40 x EDO1026 in account A, maturity 2026-10-25, T 2026-10-13 | item 1, `payout` per the engine's maturity split, dedupe `bond:maturity:A:<id>:2026-10-25` |
| Same, next day | T 2026-10-14 | `create` returns null; nothing sent |
| COI coupon | 10 x COI1029, period 2 ends 2026-10-13, T 2026-10-13, interest 5.10 per bond, not booked | item 2, `amount` 51.00 |
| Same, booked | an INTEREST row dated 2026-10-13 exists | nothing |
| EDO period 2 starts | lot bought 2025-10-13, T 2026-10-13, CPI 2026-08 4.9 %, margin 2 % | item 3, `annualRate` 0.069, `rateSource` DERIVED |
| TOS period 2 starts | FIXED rule | nothing |
| Matured, unbooked | lot of ROR matured 2026-10-01, no REDEEM | item 4 once |
| CPI published | `benchmark_values` row for 2026-09 retrieved 2026-10-13 | item 5 once per user holding a series reading it |
| CPI missing | period starting 2026-10-13 needs 2026-08, not stored | item 6 `OBSERVATION_MISSING`; item 3 not raised |

## 6. Deliberate trades

- **Fixed notice window.** 14 days before maturity, no per-person setting: a
  setting needs a column and a migration; it can follow when asked for.
- **A cron outage of more than 3 days loses an interest or period notice.**
  Items 2 and 3 look back 3 days (a skipped local day is caught up, the
  date-scoped keys make the look-back idempotent); catching up further would need
  a stored "last notified" date. Items 1, 4, 5 and 6 are window or state based
  and recover on the next run.
- **State-keyed rows are kept, not re-raised.** Items 4 and 6 are raised once
  while their state lasts, so their dedupe rows outlive the 30 day purge; one is
  forgotten only when dismissed more than 365 days ago, which bounds the growth
  and means a very old resolved event may be raised again if its state returns.
- **The interest title says "today"** even when a look-back row is raised a day or
  two late; the message carries the payment date.
- **One daily run at a fixed hour** after the bond jobs, not per the person's
  time zone; the day evaluated is the person's own financial today.
- **No new deep link.** The target is the security page, where the person books
  the redemption or the interest; a pre-filled form is a separate change.

## 7. Out of scope, reported

- `SECURITY_PRICE_MOVEMENT` on an engine-priced coupon bond: the stored daily
  price includes accrued interest, so it drops on every coupon date and a price
  alert can fire on a payment, not a market move. Proposed separately: skip
  engine-priced securities in that producer and hide the field.
- A notice for the exchange (rollover) window, after the purchase-price feature
  stores the exchange terms.

## 8. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Event rules | unit (pure functions over valuation fixtures) | each row of section 5; window edges T+14 and T+15; maturity day excluded from item 2; FIXED excluded from item 3; null amounts stay null |
| Dedupe keys | unit | stable for the same event, distinct for a different account, series, date or cause set |
| Producer | unit | per-user isolation (one user's failure does not stop the next); dispatch outside the transaction; item 2 suppressed by a booked INTEREST row |
| Registration | existing guards | category spec, preference contract tests, `never` exhaustiveness, i18n parity |
| Copy | unit | each type in English and one other locale, numbers by the recipient's locale, "not known" for a null amount |
| End to end | integration | a seeded EDO lot near maturity raises one row; a second run raises none |
