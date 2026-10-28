import { EntityManager } from "typeorm";
import { AccrualSchedule } from "./entities/accrual-schedule.entity";
import { accrualErrors } from "./accrual-errors";
import type { AccrualPlan, AccrualPeriod } from "./accrual-allocation";
import type { AccrualFamily } from "./accrual-balance";
import type { AccrualSourceSnapshot } from "./accrual-fingerprint";
import { AccrualAllocationEntity } from "./entities/accrual-allocation.entity";
import { parseAccrualMoney, formatAccrualMoney } from "./accrual-money";

export interface StoredAccrual {
  id: string;
  sourceTransactionId: string;
  sourceSplitId: string | null;
  family: AccrualFamily;
  currencyCode: string;
  preset: AccrualPeriod["preset"];
  recognitionDateRule: NonNullable<AccrualPeriod["dateRule"]>;
  startMonth: string;
  monthCount: number;
  revision: number;
  sourceFingerprint: string;
}

export async function findAccrual(
  m: EntityManager,
  userId: string,
  transactionId: string,
  splitId: string | null,
): Promise<StoredAccrual | null> {
  const rows = await m.query(
    `SELECT id, source_transaction_id AS "sourceTransactionId",
      source_split_id AS "sourceSplitId", family, currency_code AS "currencyCode", preset,
      recognition_date_rule AS "recognitionDateRule",
      TO_CHAR(start_month, 'YYYY-MM') AS "startMonth", month_count AS "monthCount", revision, source_fingerprint AS "sourceFingerprint"
     FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2
       AND source_split_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
    [userId, transactionId, splitId],
  );
  return rows[0] ?? null;
}

export async function storedAccrualPlan(
  m: EntityManager,
  userId: string,
  schedule: StoredAccrual,
): Promise<AccrualPlan> {
  const allocations = await m.query(
    `SELECT period_index AS "periodIndex", TO_CHAR(recognition_date,'YYYY-MM-DD') AS "recognitionDate",
      amount::text AS amount FROM accrual_allocations
     WHERE user_id=$1 AND schedule_id=$2 ORDER BY period_index`,
    [userId, schedule.id],
  );
  const total = allocations.reduce(
    (sum: bigint, row: { amount: string }) =>
      sum + parseAccrualMoney(row.amount),
    0n,
  );
  return {
    startMonth: schedule.startMonth,
    monthCount: schedule.monthCount,
    amount: formatAccrualMoney(total),
    allocations,
  };
}

export async function writeAccrual(
  m: EntityManager,
  userId: string,
  source: AccrualSourceSnapshot,
  family: AccrualFamily,
  period: AccrualPeriod,
  plan: AccrualPlan,
  fingerprint: string,
  existing: StoredAccrual | null,
): Promise<string> {
  await m.query(
    `INSERT INTO accrual_system_accounts(user_id,family,currency_code) VALUES ($1,$2,$3)
     ON CONFLICT (user_id,family,currency_code) DO NOTHING`,
    [userId, family, source.currencyCode],
  );
  let id: string;
  if (existing) {
    const result = await m
      .createQueryBuilder()
      .update(AccrualSchedule)
      .set({
        family,
        currencyCode: source.currencyCode,
        preset: period.preset,
        recognitionDateRule: period.dateRule ?? "MONTH_END",
        startMonth: plan.startMonth + "-01",
        monthCount: plan.monthCount,
        revision: existing.revision + 1,
        sourceFingerprint: fingerprint,
      })
      .where("id=:id AND user_id=:userId AND revision=:revision", {
        id: existing.id,
        userId,
        revision: existing.revision,
      })
      .execute();
    if (result.affected !== 1) throw accrualErrors.conflict();
    id = existing.id;
  } else {
    const rows = await m.query(
      `INSERT INTO accrual_schedules(user_id,source_transaction_id,source_split_id,family,
        currency_code,preset,recognition_date_rule,start_month,month_count,source_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        userId,
        source.transactionId,
        source.splitId,
        family,
        source.currencyCode,
        period.preset,
        period.dateRule ?? "MONTH_END",
        plan.startMonth + "-01",
        plan.monthCount,
        fingerprint,
      ],
    );
    id = rows[0].id;
  }
  await m.query(
    "DELETE FROM accrual_allocations WHERE schedule_id=$1 AND user_id=$2",
    [id, userId],
  );
  await m.getRepository(AccrualAllocationEntity).insert(
    plan.allocations.map((row) => ({
      userId,
      scheduleId: id,
      periodIndex: row.periodIndex,
      recognitionDate: row.recognitionDate,
      amount: row.amount,
    })),
  );
  return id;
}
