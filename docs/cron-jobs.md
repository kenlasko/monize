# Cron Jobs

Cron jobs use the `@Cron()` decorator from `@nestjs/schedule`. They run in the API process (`ScheduleModule.forRoot()` in `backend/src/app.module.ts`); there is no separate scheduler process, and on k8s with more than one backend replica **every replica fires every cron**.

That last clause is the reason this table has a coordination column. A schedule alone does not describe a job; the question a reader needs answered is:

> What prevents two healthy replicas from producing the same effect twice?

The acceptable answers are a conditional claim, a unique constraint, an advisory lock, or a proof that the operation is idempotent by construction. "The window is small" is not one, and neither is a `Set` in process memory -- that coordinates one replica with itself. `docs/concurrency-and-idempotency.md` section 7 states the rule; `docs/system-invariants.md` INV-CRON-001 tracks it.

**Idempotent by construction** is a real answer, and several jobs legitimately rely on it, but it has to be argued. `DELETE ... WHERE expired` qualifies, because the predicate is "already expired" and a second sweep matches nothing new. An absolute recomputation qualifies against another copy of itself, and **not** against a concurrent delta -- which is why the balance job below is listed as a gap despite being correctly documented in its own source as idempotent on re-run.

## Inventory

Every `@Cron()` in `backend/src`, checked against the source. Times are UTC unless a `timeZone` is given.

| Service | Method | Schedule | Purpose | Coordination across replicas |
|---|---|---|---|---|
| `demo-reset.service` | `resetDemoData` | `0 4 * * *` | Demo database reset | **None.** Two runs can interleave one's delete with the other's insert |
| `demo-reset.service` | `generateIntradayTransactions` | `0 */3 * * *` | Demo intraday activity | **None** |
| `ai-usage.service` | `purgeOldUsageLogs` | `0 4 * * *` | AI usage cleanup | Idempotent: `DELETE WHERE createdAt < cutoff` |
| `ai-insights.service` | `handleDailyInsightGeneration` | Daily 6 AM | Generate AI insights | **Process-local `Set` plus a cooldown read.** Coordinates one replica with itself only; duplicate insight rows are reachable |
| `token.service` | `purgeExpiredRefreshTokens` | Daily 3 AM | Expired token cleanup | Idempotent: delete by expiry / revoked predicate |
| `scheduled-transactions.service` | `processAutoPostTransactions` | `5 * * * *` | Post due recurring transactions | **None.** No lock, no CAS on `next_due_date`, no unique key on `(scheduled_transaction_id, transaction_date)`. See INV-OCCURRENCE-001 |
| `scheduled-transactions.service` | `refreshForeignCurrencyEstimates` | `25 17 * * 1-5` ET | Re-derive account-currency estimates from the 5:05 PM rates | Idempotent: a pure function of stored rates |
| `exchange-rate.service` | `scheduledRateRefresh` | `5 17 * * 1-5` ET | Fetch exchange rates (staggered before the 5:25 PM re-derive) | `ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE` |
| `security-price.service` | `scheduledPriceRefresh` | `0 17 * * 1-5` ET | Fetch security prices | `ON CONFLICT (security_id, price_date) DO UPDATE` |
| `holdings.service` | `applyMaturedInvestmentHoldings` | `30 * * * *` | Apply matured investment holdings | Relies on `UNIQUE(account_id, security_id)` plus a read-modify-write; no lock. See INV-HOLDING-001 |
| `accounts.service` | `applyDueTransactionBalances` | `0 * * * *` | Apply balances for transactions that have come due | Absolute recompute, idempotent against itself and **not** against a concurrent delta. See INV-BALANCE-001 |
| `action-history.service` | `cleanupExpiredHistory` | `0 3 * * *` | Purge expired undo history | Idempotent: expiry predicate, and `ON CONFLICT DO NOTHING` on reinserts |
| `updates.service` | `scheduledRefresh` | Every 12 hours | Check for application updates | Read-only against an external source |
| `mortgage-reminder.service` | `checkMortgageRenewals` | Daily 8 AM | Mortgage payment reminders | **None.** No per-due-date sent marker; duplicate email reachable |
| `bill-reminder.service` | `sendBillReminders` | Daily 8 AM | Bill payment reminders | **None.** Recomputes the window daily by design, but nothing dedups a re-run or a second replica |
| `budget-period-cron.service` | `closeExpiredPeriods` | `0 0 1 * *` | Close periods and create the next | **Constraint only.** `UNIQUE(budget_id, period_start)` backstops it; the loser's violation is swallowed by a per-budget `try/catch` that increments an error count rather than converging |
| `budget-alert.service` | `checkBudgetAlerts` | `0 7 * * *` | Budget threshold alerts | Partial: dedups on `(budgetId, alertType, budgetCategoryId, periodStart)`, but the check and the insert are not atomic and no unique constraint backs them |
| `budget-alert.service` | `sendWeeklyDigest` | `0 7 * * 1` | Weekly budget digest | Partial, as above |
| `budget-alert.service` | `purgeOldAlerts` | `0 3 * * *` | Purge old alert rows | Idempotent: age predicate |
| `emergency-access-monitor.service` | `runDailyCheck` | Daily 9 AM | Inactivity reminders and access grants | Partial: the grant commits `grantedAt` only after at least one email delivered (deliberate, and the best pattern in the codebase); the reminder writes `lastReminderSentAt` *after* the send, which is also its gate |
| `mny-staging.service` | `sweepExpiredFiles` | Hourly | Delete expired staged import files (24 h TTL) | Idempotent by construction: the predicate is "already expired" |
| `mny-import-job.service` | `reapStaleJobs` | Every 5 min | Fail import jobs whose worker stopped heartbeating | **Conditional CAS:** `UPDATE ... WHERE status IN (...) AND heartbeat/created_at < cutoff RETURNING id` |
| `auto-backup.service` | `handleAutoBackupCron` | `0 * * * *` | Enrol non-admin users on the default policy, then run due backups | Enrolment reconciles rather than seeds, so it is idempotent; the backup write itself is not crash-atomic (INV-BACKUP-001) |

## Notes

`mny-import-job.service` is the only job with a real two-instance test (`backend/test/integration/mny-import-job.integration.spec.ts`). It is also the only one with a complete protocol -- unique index, conditional claim, heartbeat, reaper. Those two facts are related, and the pattern is worth copying rather than re-inventing.

When adding a cron, fill in every column. A blank coordination cell is not a formatting omission; it is an unanswered question about whether the job is safe to deploy on more than one replica.
