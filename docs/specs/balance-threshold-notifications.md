# Spec: balance-threshold notifications

Status: **proposed, awaiting maintainer approval.** The trigger model (event-driven,
Section 6) and the product decisions were confirmed with the feature's requester
(the branch author); the maintainer signs off before this ships to `main`. Scope
from discussion #1291 (the `balances` group) and the maintainer's answer
"user-configurable balance thresholds: yes" (kenlasko/monize#1291, 2026-09-01;
recorded in `notification-preferences.md` Section 16.1).

Owner: notification-center. Related: #1291, `notification-preferences.md`
(the delivery/matrix layer this producer plugs into), INV-NOTIFY-001 (the write
door), `docs/concurrency-and-idempotency.md` (the CAS this producer uses),
INV-CACHE-001 (the post-commit invalidation seam it triggers from).

---

## 1. What this adds, and the one rule it must obey

A user sets, per account, an optional **low** and/or **high** balance threshold.
When the account's balance **crosses** a threshold, the Notification Center raises
one notification, delivered per the existing matrix (`balances` category).

The rule, from #1291 and confirmed by the maintainer: a producer fires on a
threshold **crossing**, never on mere observation of the current state. A balance
that sits at 40 while the low threshold is 50 produces **one** notification when it
first drops below 50, not one on every subsequent debit while it stays below, and a
fresh one only after it has recovered to at least 50 and crossed down again. This is
the balance analogue of the budget producer's `79% -> 81%` fires, `81% -> 82% -> 83%`
does not.

Thresholds are compared in the **account's own currency** (`current_balance` and
the threshold are both `NUMERIC(24,8)` in that currency), so this producer needs
**no FX and has no missing-rate case** -- unlike portfolio movement, which does.
That is why the two are separate specs.

---

## 2. When it evaluates (the requester's decision)

Evaluation is **event-driven**, not a daily cron: the balance-threshold check runs
whenever a function that changes an account's balance has run. In the requester's
words -- "the balance can be checked when a function that affects a balance change
runs on the monize instance."

Concretely, evaluation is triggered from the **same post-commit seam that
invalidates derived state after a money-moving write** (INV-CACHE-001, "a balance
change is not finished until its derived state is invalidated"). The triggering
write commits first; then, after the commit -- never inside the transaction, so a
rollback never leaves an evaluation queued for state that was never written -- the
set of accounts whose balance moved is handed to `BalanceThresholdAlertService`,
which evaluates each. This is the same discipline the net-worth recompute already
follows, and it is dispatched from the same place, with the moved-account set the
balance helpers already return.

Because every balance-moving path must reach this seam, and the codebase repeatedly
warns that balance paths are easy to wire on one route and miss on another (VOID,
future-dated, split parents, bulk, transfer legs, recalc), the evaluation has a
**built-in backstop**: the latch is durable, so a crossing missed because one path
did not trigger is caught by the **next** balance change on that account (evaluated
slightly late, never lost), and a trigger lost with its process (the seam's debounce
timer is memory) is re-run within about 30 minutes by `NetWorthService.sweepStaleSnapshots`,
which evaluates every account whose row is newer than its snapshots. A guard test scans the balance-update call sites for the
trigger, the same shape `deletion-balance.guard.spec.ts` uses.

---

## 3. Invariants

- **INV-BALANCE-001 (crossing, not level).** A notification is raised only on a
  transition across the threshold, expressed as a per-account, per-kind **armed
  latch** (Section 4): fire only when the balance is on the alerting side *and* the
  latch is un-armed; clear the latch only when the balance returns to the
  non-alerting side. Re-evaluating the same below-threshold balance raises nothing.
- **INV-BALANCE-002 (the latch transition is a compare-and-set, and that is what
  serialises).** The fire decision and the latch write are **one conditional
  `UPDATE`** (`docs/concurrency-and-idempotency.md`, atomic CAS): the row is armed
  only by the statement that also finds it un-armed and below the threshold, and
  that statement returns the row it armed. A plain `SELECT` then `UPDATE` would
  **not** serialise under READ COMMITTED (two runs both read `armed=false`, both
  fire); the CAS does, because only one `UPDATE` flips `false -> true`. The
  notification is written only by the run whose CAS returned a row, so a crossing
  fires **exactly once** even under concurrent evaluation and at-least-once
  triggering.
- **INV-BALANCE-003 (account currency, no FX).** The comparison is
  `current_balance` against the stored threshold, both in the account's currency.
  No conversion, no rate consulted, so there is no withheld/`null` case.
- **INV-BALANCE-004 (one writer).** The notification is written through
  `NotificationDispatchService.notify` -> `NotificationService.create`
  (INV-NOTIFY-001). No new INSERT path, no new truncation helper;
  `notification-write-door.spec.ts` still finds one writer.
- **INV-BALANCE-005 (a closed/absent account is a known state).** An account with no
  balance row reads as `0`, a known value, not `null`. A closed account
  (`is_closed = true`) is excluded from evaluation. Neither is an "unknown" that
  withholds -- nothing here spans currencies.
- **INV-BALANCE-006 (evaluation is post-commit and never blocks the write).** The
  check runs after the triggering transaction commits, in its own short
  transaction under `withUserContext`. A balance write is never made slower or made
  to depend on a notification, and a rolled-back write triggers no evaluation.

---

## 4. State, the latch, and why no dedupe key is needed

### 4.1 New columns on `accounts`

```
low_balance_threshold   NUMERIC(24,8)  NULL   -- notify when balance drops below
high_balance_threshold  NUMERIC(24,8)  NULL   -- notify when balance rises above
low_alert_armed         BOOLEAN NOT NULL DEFAULT false
high_alert_armed        BOOLEAN NOT NULL DEFAULT false
```

`NULL` threshold = that kind is off (default; a new account raises nothing until the
user opts in). The `*_armed` columns are the durable latch that makes
INV-BALANCE-001 hold across evaluations and replicas -- the producer's only state.

`accounts` is a user-owned table already under RLS; the four columns ship in the
same migration and need no new policy (the table's policy scopes them).
`database/schema.sql` is updated in the same migration. **Backup:** the four columns
must be classified in `support-backup-rules.ts`'s `accounts` `RULES` entry
(`low_balance_threshold`/`high_balance_threshold` `keep`; the two `*_armed` latches
`keep` -- they are the user's crossing state) or the support-backup coverage guard
fails; the portable backup already exports `accounts` with `SELECT *`, so no column
list goes stale.

Threshold columns are **derived from the account, never accepted on a transaction
request** -- edited only through the account settings DTO (new fields,
`@IsNumber`/`@Min` bounds, nullable), the same door `credit_limit` uses. Setting or
clearing a threshold resets its latch to `false` in the same update, so a newly set
threshold arms cleanly on the next crossing.

### 4.2 No dedupe key, because the latch is the idempotency mechanism

A balance row carries `budget_id = NULL`. Both unique indexes on `notifications`
leave it unconstrained: `idx_notifications_fingerprint` includes `budget_id`, and
under the default NULLS-DISTINCT semantics two rows with `budget_id = NULL` never
collide; `idx_notifications_dedupe` is partial `WHERE dedupe_key IS NOT NULL`. So a
balance notification is written with **no `dedupeKey`**, and each CAS-won crossing
is a fresh row unconditionally -- there is nothing to collapse and nothing to
dismiss first. This is the fix for the earlier draft's "dismiss the prior row"
option, which could not work: the dedupe index is not filtered on `dismissed_at`, so
a dismissed prior would still hold the key and swallow the next crossing's insert.
The latch, not a dedupe key, guarantees one row per crossing (INV-BALANCE-002).

### 4.3 New notification types and category

- `NotificationType`: `BALANCE_BELOW_THRESHOLD`, `BALANCE_ABOVE_THRESHOLD` (<= 30
  chars for `alert_type VARCHAR(30)`).
- `NotificationCategory`: `BALANCES = "BALANCES"`.
- `notificationCategoryOf` maps both to `BALANCES`; `typesForCategory` derives the
  inverse.
- `NOTIFICATION_CATEGORY_CHANNELS` gains `BALANCES`
  (`{ email: true, emailNotification: true, push: true, unifiedpush: true }`);
  `NOTIFICATION_PREFERENCE_CATEGORIES` gains it (user-configurable, not admin-only);
  `PUSH_CATEGORY_COPY` gains `BALANCES` generic copy + `push.notification.balances`
  (English-first, pseudo regenerated).
- Frontend mirrors (`types/notification.ts`, `notification-preferences.ts`) held
  equal by `notification.contract.test.ts` and
  `notification-preferences.contract.test.ts`; client copy composition and a
  `target` entry checked by `notification-target.contract.test.ts`.

---

## 5. The producer

`BalanceThresholdAlertService.evaluateAccounts(userId, accountIds)`, called from the
post-commit seam (Section 2). For each account under `withUserContext(userId)` +
`withScopedDb`, it runs the two CAS statements and fires on a returned row.

Low fire (arm-and-claim):

```sql
UPDATE accounts
   SET low_alert_armed = true
 WHERE id = $1
   AND low_alert_armed = false
   AND low_balance_threshold IS NOT NULL
   AND current_balance < low_balance_threshold
   AND is_closed = false
 RETURNING current_balance, low_balance_threshold, currency_code, name;
```

If it returns a row, fire once:

```
await this.dispatch.notify(userId, {
  type: BALANCE_BELOW_THRESHOLD,
  severity: NotificationSeverity.WARNING,            // low; high is INFO (D4)
  title, message,                                     // English fallback; client localizes
  data: { accountId, accountName, balance, threshold, currencyCode, kind: "low" },
  target: `/accounts/${accountId}`,                   // route asserted by the contract test
  // no dedupeKey -- the latch is the idempotency mechanism (Section 4.2)
});
```

Low re-arm (no notification):

```sql
UPDATE accounts
   SET low_alert_armed = false
 WHERE id = $1
   AND low_alert_armed = true
   AND (low_balance_threshold IS NULL OR current_balance >= low_balance_threshold);
```

High is the mirror (`current_balance > high_balance_threshold` to fire,
`<= high_balance_threshold` to re-arm). Each kind's CAS is independent, so a low
crossing never touches `high_alert_armed`. The dispatch seam owns delivery, throttle
and fan-out; this producer never touches a transport.

`data` carries **facts, not a figure that goes stale**: the balance and currency are
the crossing's point-in-time snapshot, which is what the alert is about -- distinct
from a scheduled amount, which describes a *future* occurrence and must be
re-resolved. This is a historical event.

---

## 6. State-transition truth table and worked example

Let `B` = `current_balance`, `T_low`/`T_high` the thresholds, `armed_low`/`armed_high`
the latches.

### Low threshold (`T_low` set)

| Condition this evaluation | armed_low before | Action | armed_low after |
|---|---|---|---|
| `B < T_low` | false | **FIRE** `BALANCE_BELOW_THRESHOLD` (CAS returns the row) | true |
| `B < T_low` | true | silent (still below; CAS matches nothing) | true |
| `B >= T_low` | true | no alert; **RE-ARM** | false |
| `B >= T_low` | false | silent | false |

### High threshold (`T_high` set) -- mirror

| Condition this evaluation | armed_high before | Action | armed_high after |
|---|---|---|---|
| `B > T_high` | false | **FIRE** `BALANCE_ABOVE_THRESHOLD` | true |
| `B > T_high` | true | silent | true |
| `B <= T_high` | true | no alert; **RE-ARM** | false |
| `B <= T_high` | false | silent | false |

Boundary: "below" is strict `<`, re-arm is `>=` (a balance exactly on `T_low` is not
below it and re-arms); symmetric for high.

### Worked example (low threshold 50.0000, account in CAD)

```
event 1: B = 120.0000  armed=false  -> silent,       armed=false
event 2: B =  40.0000  armed=false  -> FIRE (below),  armed=true
event 3: B =  30.0000  armed=true   -> silent,        armed=true   (81->82->83 case)
event 4: B =  55.0000  armed=true   -> re-arm,        armed=false
event 5: B =  45.0000  armed=false  -> FIRE (below),  armed=true   (a genuine new crossing)
```

Events 2 and 5 write two separate rows (no dedupe key; the latch permits the second
only after the re-arm at event 4). The CAS makes each fire exactly once even if the
triggering write dispatched the evaluation twice.

---

## 7. Missing-data policy

No cross-currency total, so the only input that can be unknown is the balance, and it
never is (INV-BALANCE-005): an absent balance is `0`, a closed account is excluded.
There is **no** withheld/`null` alert and no `*Complete` flag -- there is no total to
be incomplete. That state belongs to portfolio movement, whose value spans currencies.

---

## 8. Deliberate trades

- **Event-driven with a durable-latch backstop, not a daily cron** (requester's
  decision, Section 2). Firing at the crossing gives the right latency; the latch
  makes a missed trigger a late alert on the next balance change, not a lost one.
  The evaluation is dispatched post-commit (INV-BALANCE-006), so it never slows or
  couples the balance write itself.
- **A CAS, not a lock on a plain read-modify-write** (INV-BALANCE-002). The
  conditional `UPDATE` is both the decision and the latch write, so concurrency is a
  correctness property of the statement, not an argument about lock timing.
- **A latch column, not a stored "previous balance".** A balance has no natural
  period to anchor dedupe on (unlike the budget producer), so the latch is the
  minimal durable state expressing "already alerted, waiting for recovery" -- two
  booleans per account, not a history table.
- **`data.balance` is a snapshot on purpose** (Section 5): a crossing is a historical
  event, so its figure is a fact about that moment.

---

## 9. Decisions (confirmed with the requester; maintainer signs off)

- **D1. Thresholds default off (`NULL`).**
- **D2. One low + one high per account**, the two-column model (N thresholds would be
  a child table).
- **D3. Trigger = event-driven** from the post-commit balance-invalidation seam, with
  the durable-latch backstop (Section 2). This replaces the earlier draft's daily
  cron.
- **D4. Severity: low = `WARNING`, high = `INFO`.** A low balance is actionable; a
  high balance is informational.
- **D5. No dedupe key; the latch CAS is the idempotency mechanism** (Section 4.2).
  This replaces the earlier "dismiss-prior vs crossing-ordinal" question, which was
  moot -- a `budget_id = NULL` row is unconstrained by both unique indexes.
- **D6. Eligible accounts:** all non-closed accounts with a threshold set. The
  `INVESTMENT_BROKERAGE` securities sleeve holds securities, not cash, so eligibility
  keys on the sub-type via `investment-filter.util.ts`, never a hand-written
  account-type predicate.
- **D7. Credit accounts (open product decision).** For a `CREDIT_CARD` /
  `LINE_OF_CREDIT`, "low" may mean approaching the credit limit, not zero. The
  default is the raw `current_balance` comparison and the copy says so; comparing to
  `credit_limit - current_balance` for those types is a follow-up the maintainer
  confirms.

---

## 10. Test matrix (offline-runnable except where noted)

Adversarial inputs drawn from `docs/testing-contract.md`.

1. **Crossing once, not per-evaluation** (INV-BALANCE-001): events 2-3 raise one
   row; event 5 raises a second after the re-arm at event 4.
2. **Boundary equality**: `B == T_low` re-arms and does not fire; one minor unit
   below fires. Strict `<` low, strict `>` high.
3. **Both thresholds set, independent latches**: a low crossing does not touch
   `armed_high`, and vice versa.
4. **Closed account excluded**; absent balance treated as `0` (INV-BALANCE-005).
5. **CAS idempotency / exactly-once** (INV-BALANCE-002): two evaluations of the same
   below-threshold crossing (simulating at-least-once triggering) fire exactly one
   row; the second CAS returns no row. (Integration for true concurrency.)
6. **Post-commit, never in the write** (INV-BALANCE-006): a rolled-back balance write
   triggers no evaluation; the evaluation opens its own transaction.
7. **Write door** (INV-BALANCE-004): the producer's INSERT is the door's; the
   write-door scan still finds one writer.
8. **No FX** (INV-BALANCE-003): assert no currency resolver is called in the producer.
9. **Trigger coverage**: a source scan asserts every balance-update call site reaches
   the evaluation seam (the `deletion-balance.guard.spec.ts` shape).
10. **Category wiring + delivery matrix**: the two new types are `<= 30` chars and map
    to `BALANCES`; the channel/preference/push-copy `Record`s are exhaustive; the two
    frontend contract tests pass; a `balances` push-off/email-on user gets the email
    and no push.

Integration (CI-owned): the CAS under `withScopedDb` with two concurrent evaluators
(exactly-once), the new columns' backup round-trip, the RLS policy, and
schema-vs-migrations drift.
