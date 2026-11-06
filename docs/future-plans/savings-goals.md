# Savings goals

Design for savings goals: a named target amount, an optional target date, and
a funding source (an account, a tag, or a category) that the server reads to
say how much is funded, what is left, what a month must contribute to arrive
on time, and when the goal will be reached at the current pace. The task list
is [`savings-goals-tasks.md`](./savings-goals-tasks.md).

Status: **proposal**. It needs its own discussion with the `approved-to-build`
label before any task starts (`CONTRIBUTING.md`). It reports money and reads
a balance time series, so sections 4 to 8 are the specification
`docs/financial-calculation-contract.md` section 9 asks for.

## 1. Goal

- A **Goals** page (Tools menu) listing every goal with funded amount, target,
  percentage, remaining, required monthly contribution and projected date.
- A goal is funded by one of three sources, chosen when it is created:
  - **an account**: the goal is the account (a dedicated savings account, the
    common Microsoft Money case);
  - **a tag**: every ledger row carrying the tag counts, in either sign, so a
    withdrawal tagged the same way reduces the goal;
  - **a category**: every ledger row in the category counts, in either sign.
- A **dashboard widget** with a progress bar per goal.
- Two notifications: *reached* (once per goal) and *behind pace* (at most once
  per calendar month per goal), under a new `goals` notification category the
  notification-preferences spec already reserves.
- A read-only `list_savings_goals` tool on both AI surfaces (MCP and the
  in-app assistant), wired in one PR over one domain-service method.

A goal **never moves money**. It is a read model over rows that already exist.
Contributing to a goal is an ordinary transfer, tag or category edit made
through the surfaces that exist today.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| An account's balance and currency | `current_balance`, `currency_code`, `exclude_from_net_worth`, `is_closed` on `Account` (`backend/src/accounts/entities/account.entity.ts`) | INV-BALANCE-001: `current_balance` equals its ledger. |
| A balance on a past date | `AccountsService.getDailyBalances` (`backend/src/accounts/accounts.service.ts`) | Per account, in the account's currency. |
| Rows carrying a tag | `transaction_tags`, `transaction_split_tags` (`backend/src/tags/entities/`), `buildTagKeyFilterClause` (`backend/src/transactions/tag-key-filter.util.ts`) | Plain tags; the `KEY:VALUE` convention is not needed here. |
| Rows in a category, summed per currency | `TransactionAnalyticsService.getGroupedTotals` (`backend/src/transactions/transaction-analytics.service.ts`) | Rows are per currency; the goal converts with `FxAggregate`. |
| Investment exclusion | `investmentExclusionSql` (`backend/src/common/investment-filter.util.ts`) | INV-REPORT-001 applies to the tag and category sources. |
| Convert before summing | `FxAggregate` (`backend/src/common/fx-aggregate.ts`), `resolveFxRate` | `total` is `null` while a pair is missing. |
| The notification door | `NotificationDispatchService.notify` (`backend/src/notifications/notification-dispatch.service.ts`) over `NotificationService.create` | INV-NOTIFY-001, INV-DISPATCH-001..004. A row with no `budgetId` must pass a `dedupeKey`. |
| Per-category channel matrix | `NOTIFICATION_PREFERENCE_CATEGORIES`, `NOTIFICATION_CATEGORY_CHANNELS` (`backend/src/notification-center/notification-preference.service.ts`), mirrored in `frontend/src/lib/notification-preferences.ts` | `docs/specs/notification-preferences.md` section 3 reserves a `goals` group: in-app on, everything else off. |
| Dashboard widget registry | `DASHBOARD_WIDGETS` (`frontend/src/components/dashboard/widget-registry.tsx`), `WIDGET_ICONS` (`widget-meta.tsx`), `useWidgetConfig` | Template: `BudgetStatusWidget.tsx` (self-fetching). |
| A progress bar | `BudgetProgressBar` (`frontend/src/components/budgets/BudgetProgressBar.tsx`) | `role="progressbar"`; reused, not copied. |
| Tools menu | `TOOLS_LINKS`, `NAV_ICONS` (`frontend/src/lib/nav-links.ts`) | Delegates see only capability-mapped links; a goal is owner-only in v1. |
| Cron and claims | `JobClaimService.claimOnce` (`backend/src/common/jobs/job-claim.service.ts`), `withSystemContext` / `withUserContext` (`backend/src/common/db/with-context.ts`) | `docs/cron-jobs.md` needs a row; `WITH_CONTEXT_ALLOWLIST` needs the file. |
| Backup classification | `buildExportTableQueries` (`backend/src/backup/export-table-queries.ts`), `RESTORE_PLAN` (`backend/src/backup/restore-plan.ts`), `RULES` (`backend/src/backup/support-backup/support-backup-rules.ts`) | A new table is exported or excluded, never neither. |
| No goal concept today | `docs/specs/mny-import.md` ("savings goals (no Monize entity)") | Confirmed by grep: the only hits are a demo seed description and the loan "goal seek". |

## 3. Product decisions

1. **One goal, one funding source.** A goal names exactly one of `account_id`,
   `tag_id`, `category_id` (a CHECK constraint). Mixing sources would need an
   arbitration rule for a row that matches two; none is honest.
2. **The goal's currency is derived, never requested.** An account-funded goal
   is in the account's currency. A tag- or category-funded goal is in the
   user's reporting currency (`resolveUserDefaultCurrency`), because its rows
   can be in several currencies and are converted. `target_amount` is in that
   currency; the form shows the derived code and does not let the user pick.
3. **An account-funded goal counts the whole account unless a start date is
   set.** With no `start_date`, funded is `current_balance`. With one, funded
   is the balance movement since the day before the start date:
   `balance(today) - balance(start_date - 1)`, both from `getDailyBalances`,
   so money already in the account is not counted. The same `start_date`
   bounds the tag and category sums.
4. **A withdrawal counts against the goal.** Tag and category sums are signed.
   An account-funded goal falls when the balance falls. Nothing clamps at
   zero; a negative funded amount is printed as negative, with the bar empty.
5. **"Reached" is derived, not stored.** `funded >= target_amount` on the read.
   What is stored is `reached_notified_at`, set by the cron's claim, so the
   notification fires once and a goal that dips below after reaching does not
   re-fire. An `archived_at` column hides a goal from the list and the widget
   without deleting its history.
6. **Required monthly contribution** is `remaining / monthsRemaining`, where
   `monthsRemaining` is the number of calendar months from the current month
   (exclusive) to the target month (inclusive), minimum 1. Null when there is
   no target date or the goal is reached.
7. **Projected date** comes from the pace of the last three full calendar
   months: `pace = (funded(today) - funded(first day of month-2)) / 3`.
   Projected date is the first month end at which `funded + k * pace >=
   target`. Null, with a reason, when the goal is younger than three full
   months, when the pace is zero or negative, or when any input is unknown.
   "On track" is `projectedDate <= targetDate`; "behind" is the opposite;
   neither is stated when either date is null.
8. **No delegate access in v1.** The controller carries no `@AllowDelegate()`.
   A delegate section for goals is a follow-up with its own task.
9. **The widget and the page read one endpoint.** `GET /savings-goals` returns
   every goal with its progress computed server-side. No component sums
   anything.
10. **The AI tools are read-only.** `list_savings_goals` on both surfaces,
    returning the same shape with `valuationComplete` carried into the LLM
    shape. No write tool: creating a goal is cheap in the UI and a write tool
    would need the MCP confirmation round (INV-MCP-003, 004) for no gain.

## 4. Definitions

- `today`: the server's `todayYMD()` under the request context; echoed in the
  response.
- `funded`: section 3, decision 3 and 4, per source. A money amount in the
  goal's currency, or `null`.
- `remaining`: `max(target_amount - funded, 0)`; `null` when `funded` is.
- `percent`: `funded / target_amount * 100`, not clamped above 100, `null`
  when `funded` is.
- `monthsRemaining`, `requiredMonthly`, `pace`, `projectedDate`, `onTrack`:
  decisions 6 and 7.
- `valuationComplete`: `fxComplete` for a tag or category goal (an account
  goal needs no conversion and is always complete).

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| GOAL-001 | A goal never writes a ledger row, a balance or a holding | The module has no dependency on `TransactionsService` or `AccountsService` writers; a source-scanning guard (`savings-goals.guard.spec.ts`) fails an import of a write service into `backend/src/savings-goals/`. |
| GOAL-002 | Every figure a goal surface prints is the server's | The response carries `funded`, `remaining`, `requiredMonthly`, `projectedDate`; the components format and do not compute. Guarded by the `ui-conventions.test.ts` pattern for widgets ("a dashboard widget's breakdown is the report's own endpoint"). |
| GOAL-003 | The goal's currency is derived from its source | `currency_code` is written by the service from the account or the user default, never from the DTO; the DTO has no currency field (`forbidNonWhitelisted`). |
| GOAL-004 | A subtotal is not a total | `funded` is `null` while a rate is missing; `knownFunded` carries what converted; `missingRatePairs` names the pairs. Nothing defaults to 0 or 1. |
| GOAL-005 | A notification fires once per goal (reached) and once per goal per month (behind) | `claimOnce(JobClaimType.SavingsGoal, userId, "<goalId>:reached")` and `"<goalId>:behind:<YYYY-MM>"` before `notify`; the `dedupeKey` on the notification row repeats the same key so a replica that lost the claim writes nothing (INV-NOTIFY-001). |
| GOAL-006 | A refusal happens before the write | Ownership of the account, tag or category is checked inside the `withScopedDb` transaction that inserts the goal; a foreign id is a 404 and nothing is written. |

## 6. Data contracts (new)

### 6.1 Table `savings_goals`

```sql
CREATE TABLE IF NOT EXISTS savings_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  target_amount NUMERIC(24,8) NOT NULL CHECK (target_amount > 0),
  currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
  target_date DATE,
  start_date DATE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
  notes VARCHAR(500),
  sort_order INTEGER NOT NULL DEFAULT 0,
  reached_notified_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_savings_goal_one_source CHECK (
    (account_id IS NOT NULL)::int + (tag_id IS NOT NULL)::int + (category_id IS NOT NULL)::int = 1
  )
);
```

Direct RLS bucket (`user_id`): the uniform policy plus `ENABLE ROW LEVEL
SECURITY` in the same migration, the `20260928193705_add_transaction_rules.sql`
boilerplate. `ON DELETE CASCADE` on the source: a goal whose source is gone
has no meaning; the delete confirmation for an account, tag or category names
the goals it will remove (a count in the existing dialogs, task F5).

Backup: exported (`savings_goals` entry in `buildExportTableQueries`, a
`RESTORE_PLAN` row after `tags` and `categories`, a `BackupData` field, the
per-user `DELETE` in the restore, a `RESTORE_LABELS` entry). Support backup:
`name` and `notes` masked, the rest kept. `UsersService.runOwnedDataDeletes`
deletes it.

### 6.2 `GET /savings-goals` (and `GET /savings-goals/:id`)

```ts
interface SavingsGoalProgress {
  id: string; name: string; notes: string | null;
  source: { kind: 'account' | 'tag' | 'category'; id: string; name: string };
  currencyCode: string;              // derived (decision 2)
  targetAmount: number; targetDate: string | null; startDate: string | null;
  today: string;
  funded: number | null; knownFunded: number;
  remaining: number | null; percent: number | null;
  monthsRemaining: number | null; requiredMonthly: number | null;
  pace: number | null; projectedDate: string | null;
  onTrack: boolean | null;
  reached: boolean | null;           // null when funded is
  valuationComplete: boolean; missingRatePairs: string[];
  unknownReason: 'missing_rate' | 'too_young' | 'no_pace' | null;
  archivedAt: string | null; reachedNotifiedAt: string | null;
}
```

`POST /savings-goals`, `PATCH /savings-goals/:id`, `DELETE /savings-goals/:id`,
`POST /savings-goals/:id/archive` and `/unarchive`. The create and update DTOs
carry `name`, `targetAmount`, `targetDate?`, `startDate?`, `notes?`,
`sortOrder?` and exactly one of `accountId` / `tagId` / `categoryId`
(`@ValidateIf` on each, a class-level validator for "exactly one"). Changing
the source after creation is allowed and recomputes the derived currency.

### 6.3 Notification types

`goal_reached` and `goal_behind` added to `NotificationType`, a
`GOAL_NOTIFICATION_TYPES` list and a `GOALS` branch in
`notificationCategoryOf` (unmapped types fall through to BUDGETS today, so the
list is not optional). `NotificationCategory.GOALS` with channels in-app and
email (report mode) and push off, per the reserved row in the
notification-preferences spec; the frontend mirror and
`notification-preferences.contract.test.ts` updated in the same PR. `target`
is `/goals/<id>`, which `notification-target.contract.test.ts` requires to be
a real route.

### 6.4 Cron

`SavingsGoalAlertService.checkGoals` at `0 7 * * *` (server time, after the
budget alert at the same minute is acceptable; a distinct minute, `10 7 * * *`,
avoids contending for the same connections). `withSystemContext` lists users
with an unarchived goal; per user, `withUserContext` reads `GET
/savings-goals`'s service method once and, per goal:

- reached and `reached_notified_at IS NULL`: `claimOnce(...":reached")`, then
  `UPDATE savings_goals SET reached_notified_at = NOW() WHERE id = $1 AND
  reached_notified_at IS NULL RETURNING id`; only the row that returned
  notifies.
- `onTrack === false` and `targetDate` within the next 12 months:
  `claimOnce(...":behind:<YYYY-MM>")`, then notify.

A goal whose `funded` is null is skipped silently this tick (missing-data
policy); it is not "behind".

## 7. Truth tables

### A. Funded, by source

| Source | `start_date` | funded |
|---|---|---|
| account | null | `current_balance` |
| account | set | `balance(today) - balance(start_date - 1)` via `getDailyBalances` |
| tag | null or set | signed sum of rows carrying the tag (parent rows and split lines, each once), dated `>= start_date` when set, through `investmentExclusionSql` and the VOID exclusion, converted per currency with `FxAggregate` |
| category | null or set | as tag, by `category_id` on the parent row or the split line |

### B. Status

| funded | targetDate | projectedDate | reached | onTrack | unknownReason |
|---|---|---|---|---|---|
| null | any | null | null | null | `missing_rate` |
| >= target | any | n/a | true | null | null |
| < target | null | any | false | null | null |
| < target | set | null (young) | false | null | `too_young` |
| < target | set | null (pace <= 0) | false | false | `no_pace` |
| < target | set | <= targetDate | false | true | null |
| < target | set | > targetDate | false | false | null |

## 8. Numerical examples

1. Account goal, no start date. Target 10,000.00 CAD, target date 2027-06-30,
   today 2026-09-30, `current_balance` 6,400.00. `remaining` 3,600.00,
   `percent` 64, `monthsRemaining` 9 (Oct 2026 .. Jun 2027), `requiredMonthly`
   400.00. Balances on 2026-06-30 and 2026-07-01: 4,900.00; pace
   `(6400 - 4900) / 3 = 500.00`; `6400 + 7 * 500 = 9900 < 10000`,
   `6400 + 8 * 500 = 10400`: projected 2027-05-31, on track.
2. Same goal with `start_date` 2026-01-01 and balance on 2025-12-31 of
   2,000.00: funded 4,400.00, percent 44, remaining 5,600.00, requiredMonthly
   622.22 (`5600 / 9 = 622.222..`, `roundMoney`).
3. Tag goal "Vacation 2027", reporting currency CAD, rows: +1,000 CAD,
   +500 CAD, -200 CAD, +300 USD. Rate USD->CAD 1.35 on the row's date: funded
   `1000 + 500 - 200 + 405 = 1,705.00`. With no USD->CAD rate within
   `FX_MAX_RATE_AGE_DAYS`: `funded` null, `knownFunded` 1,300.00,
   `missingRatePairs: ["USD->CAD"]`, `unknownReason: 'missing_rate'`.

## 9. Missing-data policy

- A missing rate nulls `funded` and everything derived from it; the card says
  "1,300.00 CAD counted, 300.00 USD could not be converted (no USD->CAD rate)"
  and links to Currencies. Never 0, never the unconverted amount.
- A goal younger than three full months has no pace and no projected date;
  the card says "Projection available from <first day of the month after three
  full months>".
- A zero or negative pace: "Not funding at the current pace"; `onTrack` false.
- A closed account: the goal still reads (the balance is a fact); the card
  shows the account's closed badge. An account marked `exclude_from_net_worth`
  is still a valid source: the flag is about net worth, not about the goal.
- The daily balance series lacking the day before `start_date` (the account
  opened later): `balance(start_date - 1)` is the opening balance, 0 for an
  account that did not exist; the series helper already answers this.

## 10. Frontend structure

- the Goals page (new, route /goals): list with cards (name, source pill,
  `BudgetProgressBar`, funded / target, remaining, required monthly, projected
  date with on-track badge), an Add button opening `SavingsGoalForm` (a
  `Modal`, `DateInput`, `CurrencyInput`, the existing account / tag / category
  pickers), archive and delete actions, an "Archived" toggle.
- the goal detail page (new, route /goals/<id>): the detail: the same card plus a
  balance-over-time line for an account goal (`getDailyBalances`) or the
  tagged / categorized rows via a link to Transactions with the right filter.
- `frontend/src/components/dashboard/SavingsGoalsWidget.tsx`: top N
  unarchived goals by `sort_order`, each a one-line bar; `titleHref="/goals"`.
- `frontend/src/lib/savings-goals.ts`: `savingsGoalsApi` over `apiClient` with
  `invalidateCache` on writes; `frontend/src/types/savings-goal.ts`.
- `goals` namespace in `frontend/src/i18n/messages.ts`; `/goals` in
  `TOOLS_LINKS` with an icon; the Tools tour anchor is optional.
- `useNotificationCopy` entries for the two types; `notifications.json` keys.

## 11. Test matrix

| Area | Cases |
|---|---|
| Entity and DTO | exactly-one-source validator (0, 2 and 3 ids refused); currency absent from the DTO; `targetAmount <= 0` refused; `targetDate < startDate` refused |
| Ownership (GOAL-006) | foreign account / tag / category id is 404 inside the transaction; integration test asserts no row written |
| Funded, account | no start date equals `current_balance`; with start date equals the daily-balance difference; account opened after start date |
| Funded, tag | parent row and split line each once; signed sum; VOID excluded; investment-linked cash row excluded (INV-REPORT-001); multi-currency with and without a rate (GOAL-004) |
| Funded, category | as tag, including a category used on a split line of a parent in another category |
| Derived figures | `monthsRemaining` at month boundaries (today 2026-09-30, target 2026-10-01 is 1); `requiredMonthly` rounding; pace with exactly three full months, with two; projected date search termination (pace positive but tiny: cap at 120 months, then `no_pace`) |
| Truth table B | one test per row |
| Notifications (GOAL-005) | reached fires once across two ticks and two replicas (the two-connection test `docs/verification-contract.md` asks for); behind fires once per month; a null-funded goal is skipped; category GOALS resolves in-app on and email per preference |
| RLS | the table lands in the direct bucket (`rls-enforcement.integration.spec.ts`) |
| Backup | export and restore round-trip includes goals; support backup golden test |
| Frontend | page loading / empty / list; form validation; widget renders the server's figures and never sums; `notification-target` and `notification-preferences` contract tests |
| E2E | create an account goal, see progress, archive it, delete it |

## 12. Explicit v1 scope cuts

- No contribution schedule inside the goal: a user who wants automatic
  contributions creates a scheduled transfer on Bills & Deposits.
- No delegate visibility (decision 8).
- No write tool on the AI surfaces (decision 10).
- No goal on a joint account's counterpart balance; an account goal reads the
  account the owner holds.
- No "goal reached" email with an image; the standard immediate template.

## 13. Open questions

- **G1.** Should a credit-card or loan account be allowed as a source (a
  "pay down to zero" goal)? This plan says no in v1: a liability goal is the
  Debt Payoff Timeline's job and its arithmetic differs (interest).
- **G2.** Should the widget show archived-but-reached goals for a week as a
  celebration? This plan says no; the notification is the celebration.

## 14. Companion task list

[`savings-goals-tasks.md`](./savings-goals-tasks.md).
