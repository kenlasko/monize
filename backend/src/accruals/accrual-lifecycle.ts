import type { EntityManager } from "typeorm";
import { lockTransactionRow } from "../common/db/locks";
import { buildAccrualPlan, type AccrualPeriod } from "./accrual-allocation";
import { accrualContentFingerprint } from "./accrual-fingerprint";
import { loadAccrualSource } from "./accrual-source";
import { findAccrual, writeAccrual } from "./accrual-store";
import { accrualErrors } from "./accrual-errors";

/**
 * A source writer calls this in its existing withScopedDb transaction, after
 * its established advisory/source lock protocol and all source/split changes.
 * Wired into reviewed transaction updates and full split replacement. Remaining
 * source writers must adopt the protocol before the accrual routes are registered.
 */
export async function refreshSourceAccruals(
  m: EntityManager,
  userId: string,
  transactionId: string,
): Promise<number> {
  const locked = await lockTransactionRow(m, transactionId, userId);
  if (!locked) return 0; // Source deletion already cascades its schedules.
  const rows: { sourceSplitId: string | null }[] = await m.query(
    `SELECT source_split_id AS "sourceSplitId" FROM accrual_schedules
     WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY id`,
    [userId, transactionId],
  );
  let refreshed = 0;
  for (const row of rows) {
    const source = await loadAccrualSource(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
      false,
      false,
    );
    if (!source.kindEligible) throw accrualErrors.ineligible();
    const existing = await findAccrual(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
    );
    if (!existing) throw accrualErrors.conflict();
    const family = source.family ?? existing.family;
    const period: AccrualPeriod =
      existing.preset === "CUSTOM"
        ? {
            preset: "CUSTOM",
            startMonth: existing.startMonth,
            monthCount: existing.monthCount,
            dateRule: existing.recognitionDateRule,
          }
        : { preset: existing.preset, dateRule: existing.recognitionDateRule };
    const plan = (() => {
      try {
        return buildAccrualPlan(
          source.snapshot.paymentDate,
          source.snapshot.amount,
          source.snapshot.currencyDecimals,
          period,
        );
      } catch {
        throw accrualErrors.period();
      }
    })();
    const fingerprint = accrualContentFingerprint(
      source.snapshot,
      family,
      period,
      plan,
    );
    if (fingerprint === existing.sourceFingerprint) continue;
    await writeAccrual(
      m,
      userId,
      source.snapshot,
      family,
      period,
      plan,
      fingerprint,
      existing,
    );
    refreshed++;
  }
  return refreshed;
}
