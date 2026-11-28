# Dashboard trivia that changes every day

The Trivia widget (`frontend/src/components/dashboard/TriviaWidget.tsx`) shows the same facts day after day. This plan makes it vary in five ways. Facts move with the calendar. Existing facts rotate their window and rank. Each day shows a deterministic subset of about eight. The model gets more to work with. The catalog sentences have wording variants. A question/reveal quiz format is out of scope.

The task list is `docs/future-plans/trivia-variety-tasks.md`. Every phase there points back to a section here, so read the section a phase names before starting it.

## Assumptions (restated so a fresh session can execute)

- The existing design holds (`docs/future-plans/dashboard-trivia.md`). The server builds a fact sheet in which a fact exists only when every figure in it is known. A model writes only the words, quoting each figure as `{placeholder}`. The browser fills placeholders with the reader's number and date format. Names (`text` figures) are never sent to a provider. The relay is never used. `GET /ai/trivia` (`getTrivia`) never calls a model.
- One row per user in `dashboard_trivia` (`backend/src/ai/entities/dashboard-trivia.entity.ts`). It has jsonb `items` and jsonb `figures`, and the daily cron replaces it whole. **No migration.** The row is the only history: when today's list is built, it still holds yesterday's list and figures. A new optional field on an item is a jsonb shape change only.
- The cron runs hourly (`17 * * * *`) and builds each user's list in the first four hours of their local day, under `claimOnce(DashboardTrivia, userId, "daily:<local YYYY-MM-DD>")` (`docs/cron-jobs.md`), so a user is built once per local day whichever tick reaches them. The per-user body runs under the reader's timezone (section 8).
- "Today" is the reader's local day: `todayInTimezoneOrUtc(getEffectiveTimezoneOfUser(...))`, as `TriviaLedgerLoader` already does. In this plan `T` is that day and `asOf` is `addDaysYMD(T, -1)`, the last complete day. Daily-moving facts end at `asOf`, never at `T`. A list built at one fixed UTC time would be built on the previous local day in the Americas and mid-afternoon in Asia and the Pacific, with day-relative figures (days to a warranty's end, bills in the next seven days, days since a purchase, the month so far) already wrong or late; the job therefore builds early in each reader's own day. A sentence names the dates it covers (a `day` figure) instead of saying "yesterday", so a row that outlives its day (a missed run) is still true.
- `Math.random` is banned in production source (`frontend/src/test/ui-conventions.test.ts`). Every deterministic choice here uses `seedHash`, the first 4 bytes of a SHA-256 read as an unsigned 32-bit integer, from `crypto.createHash` on the server and FNV-1a in the browser. Nothing in the selection is random. The cron and a page-load rebuild for the same user, day and data produce the same list.
- Repo rules that bind every phase: `withScopedDb` only; `roundMoney`/`sumMoney` on every money result; a subtotal is not a total (a report total that is `null` drops the fact, never `?? 0`); money comes from the report or aggregate services the reader can open (new SQL only for counts, dates and single rows, never for a converted total); a category's cost is its net signed sum (the reports already do this); the investment exclusion helpers on any new row read; files 200-400 lines; no emojis; every user string translated, English first, then `npm run i18n:pseudo`, then the other locales as the final commits; frontend files go through eslint only, never Prettier.

## 1. Identity: families, lanes, params

A **fact id** (`TRIVIA_FACT_IDS` in `backend/src/ai/trivia/trivia.types.ts`) names one catalog sentence. A **family** is a set of fact ids that say the same thing in alternative forms. For example `investmentsGain` / `investmentsLoss`, or `spendingTopCategory` (twelve whole months) / `spendingTopCategoryWindow` (another window). The table is `TRIVIA_FAMILIES` in the new `backend/src/ai/trivia/trivia-families.ts`:

```ts
export type TriviaLane = "daily" | "event" | "evergreen";
export const TRIVIA_FAMILIES = {
  netWorthSinceStart: { lane: "evergreen", ids: ["netWorthSinceStart"] },
  netWorthHighPoint: { lane: "evergreen", ids: ["netWorthHighPoint", "netWorthAtHighPoint"] },
  // ...one entry per family, every TRIVIA_FACT_IDS member in exactly one
} as const satisfies Record<string, { lane: TriviaLane; ids: readonly TriviaFactId[] }>;
export type TriviaFamily = keyof typeof TRIVIA_FAMILIES;
export function familyOf(id: TriviaFactId): TriviaFamily;
export function laneOf(family: TriviaFamily): TriviaLane;
```

Three rules make the flat `figures` map safe:

1. **A builder yields at most one fact per family.** The parametrised families pick their window and rank before loading (section 4), so there is never a choice among instances.
2. **A figure name belongs to one family.** Ids inside one family may share names (the windowed id reuses its legacy id's names). Two families never do.
3. **A day's list holds at most one fact per family.** The selection (section 5) enforces this.

Together these make every figure name in a day's list unique. The stored `figures` stays one flat `Record<string, TriviaFigure>`, and an older client keeps reading it as it does today. `backend/src/ai/trivia/trivia-families.spec.ts` builds every fact from `backend/src/ai/trivia/__fixtures__/trivia-pool.fixture.ts` (a full input that produces every id; `__fixtures__` is excluded from coverage). It asserts rules 1 and 2, that every id is in exactly one family, and that every fact of one family has one topic.

**Params.** A windowed fact carries `params: { window: TriviaWindow }`, where `TRIVIA_WINDOWS = ["d30", "d90", "ytd", "m12", "all"] as const`. A rank is not a param: it is a `count` figure (`rankedCategoryRank`), and the sentence says "number {rankedCategoryRank}". Ordinals ("2nd", "deuxième", gender agreement) do not survive twenty locales. "Number 2" / "Platz 2" / "n° 2" / "第2位" does. The catalog expresses the window with an ICU `select` on the `window` argument. The widget passes `item.params.window` as a real value, not as a placeholder (section 7).

**Old ids keep their meaning.** The 26 existing ids keep their sentences, figure names and windows (the twelve whole months of `triviaWindow`). A windowed variant of an existing fact is a new id in the same family (`spendingTopCategoryWindow`), used for every window but `m12`, which keeps the legacy id. A browser still holding an older bundle across a deploy reads a legacy id exactly as before. A new id there renders as a missing message until reload, which is the accepted cost; from phase A on, the widget skips an id its catalog lacks.

### Item and fact shapes (jsonb, backwards compatible)

```ts
export type TriviaFactParams = { window?: TriviaWindow };
export interface TriviaFact { id: TriviaFactId; topic: TriviaTopic; figures: TriviaFigures; params?: TriviaFactParams }
export type TriviaItem =
  | { topic: TriviaTopic; source: "calculated"; factId: TriviaFactId; params?: TriviaFactParams }
  | { topic: TriviaTopic; source: "ai"; text: string; factIds?: TriviaFactId[] };
```

`factIds` on a model's item is derived by the server from the placeholders it quotes (section 6). The selection reads it to know which families were shown yesterday, and the rewording path reads it to keep today's facts. A stored row from before this change has no `factIds` and no `params`, and both readers treat that as "unknown" (section 5).

## 2. New figure kinds and how the browser formats them

Added to both `TriviaFigure` unions (`backend/src/ai/trivia/trivia.types.ts`, `frontend/src/types/dashboard-trivia.ts`):

| Kind | Value | Browser output | Used for |
| --- | --- | --- | --- |
| `date` | `YYYY-MM-DD` | `formatChartDate(value, 'MMMM d, yyyy')` ("November 18, 2026"); the pattern is added to `ChartDatePattern` / `CHART_DATE_OPTIONS` in `frontend/src/lib/utils.ts` as `{ month: 'long', day: 'numeric', year: 'numeric' }` | anniversaries, a warranty's end, account first transaction |
| `day` | `YYYY-MM-DD` | `formatChartDate(value, 'EEEE MMMM d')` ("Wednesday, November 18"), the existing pattern | a recent day: the last complete day, a purchase, a mover's session, a bill |
| `days` | whole number | `t('trivia.units.days', { count: value, value: formatNumber(value, 0) })` = `{count, plural, one {{value} day} other {{value} days}}` | streaks, days since, countdowns |
| `years` | whole number | `t('trivia.units.years', { count, value })` = `{count, plural, one {{value} year} other {{value} years}}` | anniversaries |

The unit is inside the figure's chip, so a sentence never writes "days" after a `days` figure, and plural rules stay with each locale's translator. Figure constructors for every kind live once in the new `backend/src/ai/trivia/trivia-figures.ts` (`money`, `percent`, `multiple`, `rate`, `count`, `month`, `text`, `date`, `day`, `days`, `years`, and `fact(id, topic, figures, params?)`). `backend/src/ai/trivia/trivia-facts.ts` and `backend/src/ai/trivia/trivia-ledger-facts.ts` import them instead of their private copies.

The figure formatting moves out of the widget into `frontend/src/components/dashboard/trivia-format.ts` (`useTriviaFigureFormat()`, which returns `(figure) => string`). Its `default` branch returns `String(figure.value)`, so a kind this build does not know (a newer server) still shows its raw value rather than an empty chip.

## 3. The new facts

Every id below is added to `TRIVIA_FACT_IDS`, to `TRIVIA_FAMILIES`, and to `trivia.facts` in `frontend/src/i18n/messages/en/dashboard.json` with the English sentence given here. Figure names are exactly as listed. The catalog spec holds each sentence to its fact's figure set. "Report" means a `BuiltInReportsService` method (`backend/src/built-in-reports/built-in-reports.service.ts`), whose total is `null` when a row did not convert. A `null` total, or a source that threw, means no fact.

### 3.1 Daily lane (move every day)

Built by `buildDailyTriviaFacts(input: TriviaDailyInput)` in `backend/src/ai/trivia/trivia-daily-facts.ts`. The input is read by `TriviaDailyLoader` in `backend/src/ai/trivia/trivia-daily.loader.ts`, where each source goes through its own `attempt` (copy the pattern in `backend/src/ai/trivia/trivia-ledger.loader.ts`).

| Family / ids | Topic | Figures | Source and guards |
| --- | --- | --- | --- |
| `spendingMonthToDate`: `spendingMonthToDateLess`, `spendingMonthToDateMore` | spending | `mtdThrough` day, `mtdSpent` money, `mtdPreviousSpent` money, `mtdDifference` money (absolute) | `getSpendingByCategory(userId, first of T's month, asOf)` and `(first of the previous month, the same day-of-month as asOf clamped to that month's end)`. Only when T's day-of-month is 2 or more, both `totalSpending` are non-null, and the previous one is above 0. Less or More by sign. Skip when they are equal. |
| `spendingLastDay`: `spendingLastDay` | spending | `lastDayDate` day, `lastDaySpent` money | `getSpendingByCategory(userId, asOf, asOf)`, `totalSpending > 0` |
| `spendingLastSevenDays`: `spendingLastSevenDays` | spending | `weekFrom` day, `weekSpent` money | `getSpendingByCategory(userId, addDaysYMD(T, -7), asOf)`, `> 0` |
| `spendingBiggestRecentPurchase`: same id | spending | `recentPurchaseAmount` money, `recentPurchasePayee` text, `recentPurchaseDay` day | One row read over the purchase predicate (section 3.5), dated from T-7 to asOf. Only when every row in that window is in the reporting currency, because an amount in its own currency cannot be ranked against another currency's; see Open decisions. The largest `ABS(reportable amount)`, ties broken by newest date then id. The payee is `COALESCE(p.name, t.payee_name)`. If that is null, no fact (never "Unknown"). |
| `spendingNoSpendStreak`: same id | spending | `noSpendDays` days, `lastSpendDay` day | `MAX(transaction_date)` over the purchase predicate with `transaction_date <= asOf`. `noSpendDays = daysBetween(last, asOf)` (`backend/src/common/time-series/price-boundary.util.ts`). Only when it is from 2 to 30: past 30 days the ledger has simply stopped being kept. |
| `spendingDaysSincePayee`: same id | spending | `sincePayeeName` text, `sincePayeeDays` days, `sincePayeeDay` day | Payee chosen from the twelve-month `spendingByPayee` the ledger loader already reads (`payeeId !== null`, top five), index `seedHash(userId, "sincePayee", String(dayIndex(T))) % count`. `MAX(transaction_date)` for that `payee_id` over the purchase predicate, `<= asOf`. `sincePayeeDays = daysBetween(last, T)`, only when 2 or more. |
| `activityBillsDueThisWeek`: same id | activity | `billsDueCount` count, `billsDueTotal` money | `ScheduledOccurrenceService.findOccurrences(userId, { from: T, through: addDaysYMD(T, 6) }, { outflowsOnly: true })` (INV-OCCURRENCE-003, never a schedule's `amount` or `nextDueDate`). The total is `convertingTotal(occurrences.map(o => ({ amount: o.amount === null ? null : Math.abs(o.amount), currency: o.currencyCode })), currency, memoizedRateResolver(exchangeRateService, currency, T), undefined, moneyDecimalsForCode(places, currency))` (`backend/src/common/converting-total.ts`), read at the reporting currency's places. Only when the count is 1 or more and `total !== null`. |
| `activityNextBill`: same id | activity | `nextBillName` text (`schedule.name`), `nextBillAmount` money (absolute, in `currencyCode`), `nextBillDate` day | The first occurrence of the same read. If its `amount` is `null`, no fact. Never skip to the second one: it would not be the next bill. |
| `spendingBudgetPace`: same id | spending | `budgetName` text, `budgetSpent` money, `budgetTotal` money, `budgetUsedPercent` percent, `budgetMonthPercent` percent | The newest active budget, read as `BudgetsService.getDashboardSummary` reads it (`isActive: true`, the same `relations`, `order: { createdAt: "DESC" }`). Skip an `incomeLinked` budget. The period is `getMonthPeriodDates(year(T), month(T) - 1)` (`backend/src/budgets/budget-date.utils.ts`); the budget's period helper reads the server's day in a cron, which is why it is not used. Actuals come from `queryCategorySpending(m.getRepository(Transaction), m.getRepository(TransactionSplit), userId, budget.categories, start, end, budget.id)` inside `withScopedDb` (`backend/src/budgets/budget-spending.util.ts`, which honours the budget's excluded accounts). Each expense line (`!isIncome`) uses `resolveCategorySpentOrNull`; any `null` means no fact. `budgetTotal = sumMoney(lines.map(bc => resolveBudgetLineBudgeted(bc, false, 0)))`, only when above 0. `budgetMonthPercent` = day-of-month(T) / days in month × 100. Money is in `spending.currency`. |
| `investmentsTopMover`: `investmentsTopMoverUp`, `investmentsTopMoverDown` | investments | `moverSymbol` text, `moverPercent` percent (absolute), `moverSession` day (`priceDate`), `moverValueChange` money (absolute `dailyValueChange`, in the mover's `currencyCode`) | `PortfolioService.getTopMovers(userId)` (`backend/src/securities/portfolio.service.ts`), which already applies `resolveDailyPriceChange` and `keepNewestSession`. The first row, only when `dailyChangePercent !== 0` and `dailyValueChange !== null`. Its `todayYMD()` reads the request timezone, which section 8 supplies in the cron. |

### 3.2 Event lane (calendar moments)

Built by `buildCalendarTriviaFacts(input: TriviaCalendarInput)` in `backend/src/ai/trivia/trivia-calendar-facts.ts`, read by `TriviaCalendarLoader` in `backend/src/ai/trivia/trivia-calendar.loader.ts`. "Anniversary date" is the date's month and day in T's year, with 02-29 read as 02-28 outside a leap year. "In its week" means `0 <= daysBetween(anniversary, T) <= 6`.

| Family / ids | Topic | Figures | Source and guards |
| --- | --- | --- | --- |
| `activityAnniversary`: same id | activity | `anniversaryYears` years, `anniversaryFirstDate` date | `records.firstTransactionDate` (already read). Years = year(T) - year(first), only when 1 or more and T is in the anniversary's week. |
| `activityAccountAnniversary`: same id | activity | `anniversaryAccountName` text (`stripBrokerageSuffix`), `anniversaryAccountYears` years, `anniversaryAccountSince` date | One read: per open account, `to_char(MIN(t.transaction_date), 'YYYY-MM-DD')` over non-VOID top-level rows. Accounts have no opening-date column, so the first transaction is the opening. Rows whose stripped name repeats (a brokerage pair) count once, keeping the earlier date. Exclude a date equal to the ledger's first transaction (that is `activityAnniversary`). Of those in their anniversary week with 1 or more years, the oldest, ties by name. |
| `netWorthMilestone`: same id | netWorth | `milestoneAmount` money, `milestoneMonth` month | The monthly net worth series already passed to `buildTriviaFacts`: its newest row and the one before, both `fxComplete !== false`. The largest R in {1, 2, 5} × 10^k with R >= 1000 and `previous < R <= newest`. Upward crossings only. |
| `activityTransactionMilestone`: same id | activity | `transactionMilestone` count | `before` = the `countRecords` transaction count restricted to `created_at < now() - interval '30 days'` (recorded, not dated: an import of old rows is still "recorded this month"). Milestones are 100, 250, 500 and every multiple of 1000. The largest M with `before < M <= records.transactions`. |
| `warrantiesExpiresSoon`: same id | warranties | `expiringWarrantyName` text, `expiringWarrantyDays` days, `expiringWarrantyDate` date | The `nextExpiring` warranty the ledger loader already reads (WTY-002 bounds). Days = `daysBetween(T, expiresOn)`, only when from 1 to 30. When this fact exists, the builder drops `warrantiesNextExpiry` (same warranty, said twice). |

### 3.3 Evergreen calendar facts

Also in `backend/src/ai/trivia/trivia-calendar-facts.ts`:

| Family / ids | Topic | Figures | Source and guards |
| --- | --- | --- | --- |
| `spendingYearAgoMonth`: same id | spending | `yearAgoMonth` month, `yearAgoSpent` money, `yearAgoTopCategoryName` text | `getSpendingByCategory(userId, first of (T's month - 12), its month end)`. Only when `totalSpending > 0`, `records.firstTransactionDate <=` that month's first day (a whole month of records), and the top row has `categoryId !== null`. |
| `netWorthYearAgo`: `netWorthYearAgoUp`, `netWorthYearAgoDown` | netWorth | `yearAgoNetWorthMonth` month, `yearAgoNetWorth` money, `yearAgoNetWorthChange` money (absolute) | The newest series row and the row exactly 12 months before it (`monthsBetween` in `backend/src/ai/trivia/trivia-facts.ts`), both `fxComplete !== false`, change not 0. |

### 3.4 Parametrised existing facts (evergreen)

Built by `buildRankedTriviaFacts(input: TriviaWindowedInput)` in `backend/src/ai/trivia/trivia-ranked-facts.ts`. The window and rank are chosen before any read:

- `pickWindow(userId, family, T)` = `TRIVIA_WINDOWS[seedHash(userId, family, "window", String(weekIndex(T))) % 5]`, replaced by `"m12"` when the pick is `"ytd"` and T is before January 8 (a year a week old says nothing). `weekIndex(T) = Math.floor(dayIndex(T) / 7)`. `dayIndex(T)` = whole days since 1970-01-01 of T as a calendar date (from `Date.UTC` of its parts). A family keeps its window for a week. It reappears roughly every eight days (section 5), so its next appearance usually has another window.
- `pickRank(userId, family, T)` = `2 + seedHash(userId, family, "rank", String(weekIndex(T))) % 2`.
- `windowRange(window, T)`: `d30` = `[asOf - 29, asOf]`, `d90` = `[asOf - 89, asOf]`, `ytd` = `[year(T)-01-01, asOf]`, `m12` = `triviaWindow(T)` (the existing twelve whole months, unchanged), `all` = `[undefined, asOf]` (the report methods take `startDate: string | undefined`).

All in the new `backend/src/ai/trivia/trivia-windows.ts`, together with `seedHash`, `dayIndex`, `weekIndex` and `asOfDay(T)`. `TriviaLedgerLoader` reads each distinct `(report, window)` the day's picks need exactly once, memoised in a `Map` keyed `report:window`. The `m12` reads it already makes are reused.

| Family | Ids | Figures | Rule |
| --- | --- | --- | --- |
| `spendingTopCategory` | `spendingTopCategory` (m12, legacy), `spendingTopCategoryWindow` (other windows, `params.window`) | the legacy names `topCategoryName`, `topCategoryAmount`, `topCategoryPercent` | as the legacy fact, over the window |
| `spendingTopPayee` | `spendingTopPayee`, `spendingTopPayeeWindow` | `topPayeeName`, `topPayeeAmount` | as legacy |
| `incomeTopSource` | `incomeTopSource`, `incomeTopSourceWindow` | `topSourceName`, `topSourcePercent` | as legacy |
| `spendingRankedCategory` | `spendingRankedCategory` (every window, `params.window` always set) | `rankedCategoryName` text, `rankedCategoryRank` count, `rankedCategoryAmount` money, `rankedCategoryPercent` percent | rows `categoryId !== null && total > 0` sorted by total desc; the `pickRank`-th exists; `totalSpending` non-null and above 0 |
| `spendingRankedPayee` | `spendingRankedPayee` | `rankedPayeeName`, `rankedPayeeRank`, `rankedPayeeAmount` | `payeeId !== null` (the report's "Unknown" bucket is not a payee: `.trail/learnings/2026-11-10-report-data-used-outside-the-report-ken.md`) |
| `incomeRankedSource` | `incomeRankedSource` | `rankedSourceName`, `rankedSourceRank`, `rankedSourcePercent` | `categoryId !== null && total > 0`; `totalIncome` non-null |

For the three legacy families, `spendingTopCategory` etc. leave `buildLedgerTriviaFacts`, whose `m12` output was exactly the legacy fact, and move to `buildRankedTriviaFacts`. That keeps the one-fact-per-family rule in one builder. The legacy builder keeps `spendingBiggestMonth`, the income flow facts, activity and warranties.

### 3.5 The purchase predicate is written once

Biggest purchase, last spend and last spend at a payee share the purchase predicate in `backend/src/built-in-reports/purchase-rows-sql.ts`. It selects a negative reportable amount, excluding transfers, VOID rows, child rows, investment machinery and asset-value bookings. Spending by Payee now sums signed components for a different question: the amount spent after refunds.

### 3.6 Equivalence facts (evergreen, server-computed)

The model may not write a digit, so a comparison it would like to make ("about two months of groceries") must reach it as a figure. Built by `buildEquivalenceTriviaFacts(input: { currency; ledger: TriviaLedgerInput; portfolio: PortfolioSummary | null })` in `backend/src/ai/trivia/trivia-equivalence-facts.ts`, all from the twelve-month data already read. `months = completeFlows(...)` (export it from `backend/src/ai/trivia/trivia-ledger-facts.ts`) `.data.length`, at least 3. `days = daysBetween(completeFlows.data[0].periodStart, triviaWindow(T).endDate) + 1`.

| Family / id | Topic | Figures | Rule |
| --- | --- | --- | --- |
| `spendingPayeeInCategoryMonths` | spending | `equivPayeeName` text, `equivPayeeAmount` money, `equivCategoryName` text, `equivCategoryMonths` multiple | top payee total ÷ (top category total ÷ months), `roundMoney(x, 2)`, only when 0.5 or more; both report totals non-null |
| `spendingDailyAverage` | spending | `dailyAverageSpent` money | `totals.expenses ÷ days`, only when above 0 |
| `incomeKeptCoversDays` | income | `keptCoversAmount` money, `keptCoversDays` days | `Math.floor(net ÷ (expenses ÷ days))`, only when net is above 0, expenses above 0 and the result is 1 or more |
| `investmentsGainInMonthsOfSpending` | investments | `gainCoversAmount` money, `gainCoversMonths` multiple | `portfolio.valuationComplete !== false`, `totalGainLoss > 0`, `gainCostBasis > 0`; gain ÷ (expenses ÷ months), only when 0.5 or more |

### 3.7 English sentences

`W` stands for this select. Write it out in full in every windowed sentence; no other text may sit inside a branch:
`{window, select, d30 {Over the last 30 days} d90 {Over the last 90 days} ytd {So far this year} m12 {Over the last twelve months} all {Since your records began} other {Over this period}}`

| Id | Sentence |
| --- | --- |
| `spendingTopCategoryWindow` | `W, {topCategoryName} took the most of your spending: {topCategoryAmount}, or {topCategoryPercent} of it.` |
| `spendingTopPayeeWindow` | `W, you spent the most with {topPayeeName}: {topPayeeAmount}.` |
| `incomeTopSourceWindow` | `W, {topSourceName} brought in {topSourcePercent} of your income.` |
| `spendingRankedCategory` | `W, {rankedCategoryName} was number {rankedCategoryRank} among your spending categories, at {rankedCategoryAmount} ({rankedCategoryPercent} of the total).` |
| `spendingRankedPayee` | `W, {rankedPayeeName} was number {rankedPayeeRank} among the payees you spent the most with, at {rankedPayeeAmount}.` |
| `incomeRankedSource` | `W, {rankedSourceName} was number {rankedSourceRank} among your sources of income, bringing in {rankedSourcePercent} of it.` |
| `spendingMonthToDateLess` | `Through {mtdThrough}, you have spent {mtdSpent} this month, {mtdDifference} less than by the same day last month ({mtdPreviousSpent}).` |
| `spendingMonthToDateMore` | `Through {mtdThrough}, you have spent {mtdSpent} this month, {mtdDifference} more than by the same day last month ({mtdPreviousSpent}).` |
| `spendingLastDay` | `On {lastDayDate}, you spent {lastDaySpent}.` |
| `spendingLastSevenDays` | `In the seven days from {weekFrom}, you spent {weekSpent}.` |
| `spendingBiggestRecentPurchase` | `Your biggest purchase of the last seven days was {recentPurchaseAmount} with {recentPurchasePayee} on {recentPurchaseDay}.` |
| `spendingNoSpendStreak` | `No spending recorded for {noSpendDays}, since {lastSpendDay}.` |
| `spendingDaysSincePayee` | `It has been {sincePayeeDays} since you last spent with {sincePayeeName}, on {sincePayeeDay}.` |
| `activityBillsDueThisWeek` | `Bills due in the next seven days: {billsDueCount}, coming to {billsDueTotal}.` |
| `activityNextBill` | `Your next bill is {nextBillName}, for {nextBillAmount}, due {nextBillDate}.` |
| `spendingBudgetPace` | `You have used {budgetUsedPercent} of your {budgetName} budget ({budgetSpent} of {budgetTotal}), with {budgetMonthPercent} of the month gone.` |
| `investmentsTopMoverUp` | `Your top mover on {moverSession} was {moverSymbol}, up {moverPercent}, which added {moverValueChange} to your position.` |
| `investmentsTopMoverDown` | `Your top mover on {moverSession} was {moverSymbol}, down {moverPercent}, which took {moverValueChange} off your position.` |
| `activityAnniversary` | `This week marks {anniversaryYears} since your first transaction in Monize, on {anniversaryFirstDate}.` |
| `activityAccountAnniversary` | `Your {anniversaryAccountName} account turns {anniversaryAccountYears} in Monize this week: its first transaction was on {anniversaryAccountSince}.` |
| `netWorthMilestone` | `In {milestoneMonth}, your net worth passed {milestoneAmount}.` |
| `activityTransactionMilestone` | `In the last 30 days you recorded transaction number {transactionMilestone}.` |
| `warrantiesExpiresSoon` | `Your {expiringWarrantyName} warranty runs out in {expiringWarrantyDays}, on {expiringWarrantyDate}.` |
| `spendingYearAgoMonth` | `A year ago, in {yearAgoMonth}, you spent {yearAgoSpent}, and {yearAgoTopCategoryName} took the most of it.` |
| `netWorthYearAgoUp` | `A year ago, in {yearAgoNetWorthMonth}, your net worth was {yearAgoNetWorth}. It is {yearAgoNetWorthChange} higher now.` |
| `netWorthYearAgoDown` | `A year ago, in {yearAgoNetWorthMonth}, your net worth was {yearAgoNetWorth}. It is {yearAgoNetWorthChange} lower now.` |
| `spendingPayeeInCategoryMonths` | `Over the last twelve months you spent {equivPayeeAmount} with {equivPayeeName}, about {equivCategoryMonths} months of your average spending on {equivCategoryName}.` |
| `spendingDailyAverage` | `Over the last twelve months your spending averaged about {dailyAverageSpent} a day.` |
| `incomeKeptCoversDays` | `The {keptCoversAmount} you kept over the last twelve months would cover about {keptCoversDays} of your spending.` |
| `investmentsGainInMonthsOfSpending` | `Your investments' {gainCoversAmount} gain is about {gainCoversMonths} months of your average spending.` |

Plus `trivia.units.days` and `trivia.units.years` (section 2). No sentence holds `--` (`frontend/src/i18n/messages.punctuation.test.ts`). `en-GB` overrides only a sentence whose spelling differs, as it does today for `investmentsCagr`.

## 4. Where the pool is assembled

`DashboardTriviaService` (`backend/src/ai/trivia/dashboard-trivia.service.ts`, 386 lines) cannot take this growth. The fact assembly moves to a new injectable, `TriviaPoolBuilder`, in `backend/src/ai/trivia/trivia-pool.builder.ts`. It takes over today's `loadFacts`, `loadPortfolio` and `otherAssets`:

```ts
export interface TriviaPoolOptions { today: string; mode: "cron" | "page" }
build(userId: string, preferences: UserPreference | null, options: TriviaPoolOptions): Promise<TriviaFact[]>
timezoneOf(userId: string): Promise<string | null>   // getEffectiveTimezoneOfUser in withScopedDb
```

It calls, in turn: `getMonthlyNetWorth` (unchanged), `loadPortfolio`, `accountsService.findAll`, `ledger.load(userId, currency, today, picks)`, `daily.load(userId, currency, today, { bills: mode === "cron" })` and `calendar.load(userId, today)`. Then it concatenates `buildTriviaFacts`, `buildLedgerTriviaFacts`, `buildRankedTriviaFacts`, `buildDailyTriviaFacts`, `buildCalendarTriviaFacts` and `buildEquivalenceTriviaFacts`. `TriviaLedgerLoader.load` gains the `today` parameter and stops resolving the timezone itself (its spec is updated). `picks` is `{ [family]: { window, rank } }` from `pickWindow` / `pickRank`, computed in the builder.

**Page mode skips the bills read.** `findOccurrences` runs the effective-amount resolver, which "can fetch from a provider and persist", and `getTrivia` must stay cheap. A page-load rebuild happens only for a reader the cron has not reached (a new reader, or one whose row is from an earlier local day), or after a language change. It therefore has no bill facts until the job has built that day's list. Every other source is a database read the dashboard widgets already make.

New providers go in `backend/src/ai/ai.module.ts`: `TriviaPoolBuilder`, `TriviaDailyLoader` and `TriviaCalendarLoader`. `ScheduledTransactionsModule`, `SecuritiesModule`, `CurrenciesModule` and `BuiltInReportsModule` are already imported. If `backend/src/module-graph.spec.ts` names a cycle edge, the constructor parameter takes `forwardRef(() => X)` as that spec says.

## 5. Daily selection (no migration)

`selectDailyTrivia(pool, yesterday, userId, today)` in the new `backend/src/ai/trivia/trivia-rotation.ts`, pure:

```ts
export const TRIVIA_DAILY_COUNT = 8;
export const EVENT_PICKS = 2;
export const DAILY_PICKS = 3;
export const EVERGREEN_PICKS = 4;   // the rotation's step; constant so the cycle is stable
export const TOPIC_CAP = 3;
export interface TriviaYesterday { families: Set<TriviaFamily>; figures: TriviaFigures }
export function yesterdayOf(row: DashboardTrivia | null): TriviaYesterday | null;
export function familyOrder(userId: string, families: { family: TriviaFamily; topic: TriviaTopic }[]): TriviaFamily[];
export function selectDailyTrivia(pool: TriviaFact[], yesterday: TriviaYesterday | null, userId: string, today: string): TriviaFact[];
export function orderForDisplay(facts: TriviaFact[], userId: string, today: string): TriviaFact[];
```

- **Yesterday** comes from the stored row. Its families are `familyOf(factId)` of each calculated item, plus `familyOf` of each id in an AI item's `factIds`. An AI item without `factIds` (a row from before this change) contributes nothing. Its figures are the row's `figures`. A row whose ids are no longer in `TRIVIA_FACT_IDS` is ignored id by id.
- **Event lane.** Eligible event facts that were not shown yesterday, by `seedHash(userId, D, family)` ascending, at most `EVENT_PICKS`. A week-long anniversary therefore shows on alternate days, never every day.
- **Daily lane.** Each eligible daily fact scores `(shown yesterday ? 0 : 2) + (changed ? 1 : 0)`. Changed means some figure differs from yesterday's figure of the same name (deep compare of `kind`, `value`, `currency`). A fact shown yesterday with no figure changed is not eligible. Take them by score descending, then `seedHash(userId, D, family)` ascending, at most 2 per topic, up to `DAILY_PICKS`.
- **Evergreen lane: the rotation.** `E = familyOrder(userId, eligible evergreen families)`. `start = (D * EVERGREEN_PICKS) % E.length`, with `D = dayIndex(today)`. Walk `E` cyclically from `start`, skip families shown yesterday, and take `EVERGREEN_PICKS`. While the eligible set is unchanged, consecutive starts advance by 4, so every family is covered once per pass. A family is shown at most once in any `floor(|E| / 4)` consecutive days (about 7 days for 30 eligible families), and never on two days running, whatever the set does. No history column is needed for either guarantee.
- **`familyOrder` spreads topics.** Within each topic, sort the families by `seedHash(userId, family)`. Give the i-th of n the key `(i + seedHash(userId, "topic", topic) / 2^32) / n`, then sort everything by key (ties by `seedHash`, then name). Each topic's families are spread evenly round the cycle, so any window of 4 is topic-balanced without skipping anything, and the per-family guarantee above holds.
- **Fill.** While fewer than `TRIVIA_DAILY_COUNT`, continue the evergreen walk, then the unused daily facts by score, then events shown yesterday. With fewer facts in the pool than that, everything is shown.
- **Topic cap.** If a topic holds more than `TOPIC_CAP`, drop its most recently added fill picks and continue the walk with other topics. Events are never dropped.
- **Display order.** `orderForDisplay` sorts by `seedHash(userId, D, id)`, then greedily takes the first remaining fact whose topic differs from the previous one. It replaces `shuffled` and its `randomInt`. The widget's start-at-the-minute index still varies where a reload joins the list.

**Service integration.**

- `generateForUser`: `pool = build(..., { today, mode: "cron" })`, `stored = findOne`, `selected = selectDailyTrivia(pool, yesterdayOf(stored), userId, today)`, then the model on `selected` only (section 6), `items = mergeTriviaItems(orderForDisplay(selected), aiItems)`, `figures = figuresOf(selected)`.
- `getTrivia` when there is no row: the same with `mode: "page"` and `yesterday = null`.
- `getTrivia` when a row needs rewording (a language change): keep today's choice. `kept` = the pool facts whose `(id, params)` match a stored calculated item, or whose id is in a stored AI item's `factIds`. Store `mergeTriviaItems(orderForDisplay(kept), [])`. If `kept` is empty (an old row), select with `yesterday = null`.

`mergeTriviaItems(facts, aiItems)` becomes per fact. A fact covered by an AI item's `factIds` is not repeated. Every other fact gets its calculated item, carrying `params`. An AI item without `factIds` keeps today's per-topic rule, so the function stays total for old input.

## 6. Giving the model more

The prompt builder moves to the new `backend/src/ai/trivia/trivia-prompt.ts`, as `buildTriviaPrompt(facts, { avoid: string[]; angle: TriviaAngle })`. `trivia-sentences.ts` keeps parse and merge.

- **Do not repeat.** `avoid` = the `text` of yesterday's stored AI items, at most 10. They passed the validator, so they hold no digit and no name. They go under `Sentences shown yesterday (do not reuse their wording; their placeholders belong to yesterday):`.
- **Angle of the day.** `TRIVIA_ANGLES` (English instructions, exported beside `TRIVIA_SYSTEM_PROMPT` in `backend/src/ai/context/prompt-templates.ts`): `contrast` "Where a fact has two figures, set them against each other.", `timeline` "Open with when the fact happened.", `scale` "Lead with the size of the main figure.", `brief` "Keep every sentence under ninety characters.", `curious` "Phrase each fact as a small discovery, without exaggerating.". Picked by `seedHash(userId, "angle", String(D)) % 5` and sent as `Angle for today: <text>`.
- **Windows** appear as a line under the fact: `  window: <words>`, where the words have no numerals: d30 "the past month", d90 "the past quarter", ytd "this year so far", m12 "the past year", all "all of their records".
- **New kinds** are described so the model never adds a unit: `date` "a date, 2026-11-18, shown as a full date"; `day` "a recent day, 2026-11-18, shown with its weekday"; `days` "a number of days, 3, shown with its unit, so do not write the word days after it"; `years` the same for years. `text` stays "a name, filled in later". Names never leave the server.
- **Combining two facts.** `TRIVIA_SYSTEM_PROMPT` rule 2 becomes "one sentence for each fact, or one sentence combining two facts of the same topic". Rule 5 becomes "Use only the figures of the fact or the two facts the sentence is about; both must have the sentence's topic." Add a rule: "Follow the angle for today. Do not reuse the wording of yesterday's sentences." Update the topics paragraph: spending now covers recent days, the month so far and the budget; activity covers upcoming bills, anniversaries and milestones; windows vary. Rules 1, 3, 4 and 6 stay word for word. Rule 6 (no advice, predictions or opinions) is what keeps a budget-pace sentence neutral.
- **Validator** (`parseTriviaSentences`): map each figure name to its fact. A sentence is kept only when it has at least one placeholder, every placeholder is known, every one belongs to a fact of the sentence's topic, and they belong to at most 2 distinct facts. The existing `OWN_FIGURE`, length and duplicate checks also apply. The item gets `factIds` (distinct, in first-quoted order). The cap stays `Math.min(MAX_AI_ITEMS, facts.length)`.
- **Equivalence figures** are facts (section 3.6), so the model and the catalog both have them.

Unchanged and still tested: `skipRelay: true` and the relay check, the language instruction, `responseFormat: "json"`, a failed call meaning the calculated sentences.

## 7. Catalog variants and the widget

- Variant keys sit beside the facts, not inside them, so `trivia.facts.<id>` stays a string. The backend spec reads it that way, and an older bundle keeps working. The keys are `trivia.variants.<id>.b` and `trivia.variants.<id>.c` for every id, 2 per id. A variant quotes exactly its fact's figure set. A windowed id's variant carries the same `{window, select, ...}` branches. Each is under 160 characters, has no `--` and no advice.
- The pick is in the browser, in the new `frontend/src/lib/trivia-variant.ts`: `pickTriviaVariant(keys: string[], factId: string, day: string): string`, FNV-1a 32-bit of `${factId}|${day}` modulo `keys.length`. `day` is `useFinancialToday()` (`frontend/src/hooks/useFinancialToday.ts`). `keys` = `['facts.<id>', 'variants.<id>.b', 'variants.<id>.c']` filtered by `t.has('trivia.' + key)`. A locale that lacks a variant simply has fewer to choose from.
- The widget, once phase A lands:
  - skips a calculated item whose `trivia.facts.<id>` is missing (`t.has`), so a newer server's id never renders a missing message;
  - passes `window: item.params?.window ?? 'other'` beside the figure placeholders;
  - formats through `useTriviaFigureFormat()`.

  The position counter and dots count the items it shows.

## 8. Cron timezone

`handleDailyGeneration` ticks hourly at :17. Inside one `withSystemContext` it calls `dueTriviaUsers` (`trivia-due-users.ts`), which groups users with `getUsersByEffectiveTimezone` (the helper `warranty-expiry-reminder.service.ts` and the other per-zone crons use), keeps the buckets whose local hour is under `TRIVIA_BUILD_HOURS` (4) and, only when some bucket qualifies, intersects them with the active users. Then, per user:

`await withUserContext(userId, () => this.generateForUser(userId, timezone), timezone)`

The zone comes from the bucket, so there is no second per-user timezone lookup. This makes `todayYMD()` inside `getTopMovers` and `findOccurrences` read the reader's day. `generateForUser` computes `today = todayInTimezoneOrUtc(timezone)` and takes the claim `daily:<today>` first of all (before the preferences read), so the later ticks of the same local day, and other replicas, stand down after one statement. Both calls stay in `backend/src/ai/trivia/dashboard-trivia.service.ts`, which is already in `WITH_CONTEXT_ALLOWLIST`; no new file imports `with-context`. The concurrency (5) and the delete-on-off rules are unchanged; a reader who has the widget off now takes the day's claim before their row is deleted.

**Which row counts as yesterday.** The stored row, while its `generatedAt` is on an earlier local day than the reader's today. Only the daily job replaces such a row. A page load that finds one (the job has not reached the reader, or missed) builds today's calculated list in page mode, selected as if the stored row were yesterday's, returns it and stores nothing; the job later in the day then still sees the stored row as yesterday for its rotation and its sentences to avoid. A page-load rebuild for a new reader (no row) or a rewording after a language change rewrites a row of today; a rewording keeps the row's `generatedAt` so the next day's job still recognises it as the earlier list, keeps at most `TRIVIA_DAILY_COUNT` of its facts and tops the list up through `selectDailyTrivia` when facts (bills, which page mode does not read) dropped out.

## 9. Old and new clients

| Server | Client | Result |
| --- | --- | --- |
| new | old bundle | Legacy ids render as before (same sentences, same names). New ids render a missing message, and new kinds render an empty chip, until the tab reloads. `params` and `factIds` are ignored. |
| old row | new server | The row is shown as stored. The next selection treats its families as yesterday's (calculated items only), so nothing breaks. |
| old server | new client | Every id is in the catalog. The `window` argument defaults to `other` and is unused by legacy sentences. |

## What to run

Each phase in the task list names its focused specs. The final gate (phase H):

- `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run i18n:check`.
- `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test -- src/i18n` (parity, punctuation, duplicate keys).
- Root: `node scripts/check-docs-manifests.mjs`. Stage new files (`git add -N`) first, then `npm run test:unit -- src/common/doc-paths.spec.ts src/common/source-comment-paths.spec.ts` in `backend/`.

## What should be observed

With the Trivia widget on and no AI provider, the list holds about eight facts. On consecutive mornings (cron or a fresh row) at most a few of them repeat, and those are daily facts with new figures. Evergreen facts come back after about a week. Sentences quote dated recent days ("Wednesday, November 18"), day counts with their unit ("3 days"), and windows ("Over the last 90 days"). The same fact's wording differs between days. With a provider, sentences may join two facts of one topic, never repeat yesterday's wording, and every figure is still a chip. Nothing in `dashboard_trivia` changes shape at the database level, and there is no migration.

## Open decisions (each resolved; the pick is what the tasks implement)

1. **Unique figure names: one fact per family per day, or per-item figure maps?** Per-item maps would let two instances of a family share a day, but they break every client already deployed. **Pick: one fact per family per day, and a figure name belongs to one family**, held by `backend/src/ai/trivia/trivia-families.spec.ts`.
2. **Repeat protection: history column or stateless rotation?** A column would remember more than a day, but it costs a migration, the `schema.sql` pair and the backup exclusion review. **Pick: no migration.** The day-index rotation over a per-user, topic-spread order gives "not within floor(|E|/4) days" while eligibility is stable. Yesterday's row gives "never two days running" always. The cost: when a fact becomes eligible or ineligible the phase shifts once, and that day can bring a family back early (never the day after).
3. **Parametrised identity: id per window, or id plus params?** **Pick: id plus `params.window`, with an ICU `select` in one sentence.** The legacy id is kept for the twelve-month window so old bundles stay right. Translators get one sentence with branches instead of five near-copies, and an unknown window falls to `other`.
4. **Rank wording.** **Pick: "number {rank}" with a `count` figure**, no ordinals, because ordinals and gender agreement do not translate mechanically.
5. **Biggest purchase across currencies.** Converting each row at its own date's rate is right but needs the reports' rate-basis machinery for one sentence. **Pick: a fact only when every candidate row is in the reporting currency.** A multi-currency week gives no fact, which is a missing sentence, never a wrong one. Converting is a later change in `TriviaDailyLoader` alone.
6. **Bills on a page-load rebuild.** **Pick: skipped (`mode: "page"`)**, because the occurrence resolver may fetch rates. The cost is no bill facts for a brand-new reader until the job reaches them, in the first hours of their next local day.
7. **"Yesterday" in sentences.** **Pick: dated `day` figures, with daily facts ending at `asOf`.** A row can outlive its day, and a dated sentence is still true.
8. **Who picks the variant.** **Pick: the browser.** The catalog owns how many variants a locale has, and the server would have to know that to pick. The reader's financial day keeps devices in step.
9. **Budget pace for an income-linked budget.** **Pick: no fact.** Its budgeted figure depends on income that may still be arriving, and the pace would move for a reason the sentence cannot state.
10. **Events on consecutive days.** **Pick: alternate days** (not shown yesterday), so a week-long anniversary or a countdown is not the first thing every single day.
11. **Between phases B and G the frontend `frontend/src/i18n/messages.parity.test.ts` fails**, because new `en` keys are untranslated until the final translation commits, as `AGENTS.md` prescribes. **Pick: accepted.** No phase lists it among its focused specs before G1, and G1/G2 must leave it green. The backend `backend/src/ai/trivia/trivia-catalog.spec.ts` (English only) stays green in every phase.
