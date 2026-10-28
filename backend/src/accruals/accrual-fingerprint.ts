import { createHash } from "node:crypto";
import { AccrualPeriod, AccrualPlan } from "./accrual-allocation";
import { AccrualFamily } from "./accrual-balance";
import { formatAccrualMoney, parseAccrualMoney } from "./accrual-money";

/** Loaded under the source lock, never accepted as financial facts from a client. */
export interface AccrualSourceSnapshot {
  readonly userId: string;
  readonly transactionId: string;
  readonly splitId: string | null;
  readonly revision: string;
  readonly amount: string;
  readonly paymentDate: string;
  readonly accountId: string;
  readonly currencyCode: string;
  readonly currencyDecimals: number;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly payeeName: string | null;
  readonly description: string | null;
  readonly tagIds: readonly string[];
  readonly status: string;
  readonly originalAmount: string | null;
  readonly originalCurrencyCode: string | null;
  readonly exchangeRate: string | null;
}

/**
 * A versioned expectation token, not authorization. Commit still loads and locks
 * the owned source and regenerates the plan before comparing this value.
 */
export function accrualPreviewFingerprint(
  source: AccrualSourceSnapshot,
  family: AccrualFamily,
  period: AccrualPeriod,
  plan: AccrualPlan,
  scheduleRevision: number | null,
  scheduleId: string | null = null,
): string {
  const canonical = [
    "accrual-preview-v1",
    source.userId,
    source.transactionId,
    source.splitId,
    source.revision,
    formatAccrualMoney(parseAccrualMoney(source.amount)),
    source.paymentDate,
    source.accountId,
    source.currencyCode,
    source.currencyDecimals,
    source.categoryId,
    source.payeeId,
    source.payeeName,
    source.description,
    [...new Set(source.tagIds)].sort(),
    source.status,
    source.originalAmount === null
      ? null
      : formatAccrualMoney(parseAccrualMoney(source.originalAmount)),
    source.originalCurrencyCode,
    source.exchangeRate,
    family,
    period.preset,
    plan.startMonth,
    plan.monthCount,
    plan.amount,
    plan.allocations.map((row) => [
      row.periodIndex,
      row.recognitionDate,
      row.amount,
    ]),
    scheduleRevision,
    scheduleId,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Content identity excludes timestamp-only touches, unlike a command expectation. */
export function accrualContentFingerprint(
  source: AccrualSourceSnapshot,
  family: AccrualFamily,
  period: AccrualPeriod,
  plan: AccrualPlan,
): string {
  return accrualPreviewFingerprint(
    { ...source, revision: "content" },
    family,
    period,
    plan,
    null,
  );
}
