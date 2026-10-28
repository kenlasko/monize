import { accrualBalancesAt, type AccrualFamily } from "./accrual-balance";
import { createHash } from "node:crypto";
import { EntityManager, In, Not } from "typeorm";
import type { UpdateTransactionDto } from "../transactions/dto/update-transaction.dto";
import type { CreateTransactionSplitDto } from "../transactions/dto/create-transaction-split.dto";
import { inferSplitKind } from "../transactions/split-kind.util";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { AccrualSchedule } from "./entities/accrual-schedule.entity";
import { lockTransactionRow } from "../common/db/locks";
import { buildAccrualPlan } from "./accrual-allocation";
import { accrualPreviewFingerprint } from "./accrual-fingerprint";
import { loadAccrualSource } from "./accrual-source";
import { findAccrual, storedAccrualPlan } from "./accrual-store";
import { accrualErrors } from "./accrual-errors";

/** Stable key order; arrays retain their explicit order. No financial coercion. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  }
  return value;
}
type EditPatch = Omit<
  Partial<UpdateTransactionDto>,
  "categoryId" | "payeeId" | "description"
> & {
  categoryId?: string | null;
  payeeId?: string | null;
  description?: string | null;
};
export interface AccrualEditResolution {
  fingerprint: string | null;
  impacts: {
    scheduleId: string;
    sourceSplitId: string | null;
    removed: boolean;
    before: Awaited<ReturnType<typeof storedAccrualPlan>>;
    after: ReturnType<typeof buildAccrualPlan> | null;
    familyBefore: string;
    familyAfter: string | null;
    currencyBefore: string;
    currencyAfter: string;
    paymentDateBefore: string;
    paymentDateAfter: string;
    timingBalances: { asOf: string; before: string; after: string }[];
  }[];
  retainedCategoryIds: ReadonlyMap<number, string>;
  removedScheduleIds: readonly string[];
}

async function retainedSplits(
  m: EntityManager,
  userId: string,
  transactionId: string,
  splits: readonly CreateTransactionSplitDto[] | undefined,
): Promise<ReadonlyMap<number, string>> {
  const ids = new Map<number, string>();
  if (!splits?.some((split) => "id" in split && !!split.id)) return ids;
  const original: { id: string; kind: string }[] = await m.query(
    `SELECT s.id,s.kind FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
     WHERE t.id=$1 AND t.user_id=$2`,
    [transactionId, userId],
  );
  const seen = new Set<string>();
  for (const [index, split] of splits.entries()) {
    const id = "id" in split ? split.id : undefined;
    if (!id) continue;
    if (typeof id !== "string" || seen.has(id)) throw accrualErrors.conflict();
    seen.add(id);
    const old = original.find((row) => row.id === id);
    if (!old) throw accrualErrors.missing();
    if (
      old.kind === SplitKind.CATEGORY &&
      inferSplitKind(split) === SplitKind.CATEGORY
    )
      ids.set(index, id);
  }
  return ids;
}

/** Caller holds the source lock. No mutation occurs while resolving impact. */
export async function resolveSourceAccrualEdit(
  m: EntityManager,
  userId: string,
  transactionId: string,
  patch: EditPatch,
  splitCategories: ReadonlyMap<string, string | null> = new Map(),
  removedComponents: ReadonlySet<string | null> = new Set(),
  categoryFamilies: ReadonlyMap<string, AccrualFamily> = new Map(),
): Promise<AccrualEditResolution> {
  const retainedCategoryIds = await retainedSplits(
    m,
    userId,
    transactionId,
    patch.splits,
  );
  const rows: { sourceSplitId: string | null }[] = await m.query(
    `SELECT source_split_id AS "sourceSplitId" FROM accrual_schedules
     WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY id`,
    [userId, transactionId],
  );
  const impacts: AccrualEditResolution["impacts"] = [];
  const signatures: string[] = [];
  for (const row of rows) {
    const source = await loadAccrualSource(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
      false,
      false,
    );
    const schedule = await findAccrual(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
    );
    if (!schedule) throw accrualErrors.conflict();
    const before = await storedAccrualPlan(m, userId, schedule);
    const period =
      schedule.preset === "CUSTOM"
        ? {
            preset: "CUSTOM" as const,
            startMonth: schedule.startMonth,
            monthCount: schedule.monthCount,
            dateRule: schedule.recognitionDateRule,
          }
        : { preset: schedule.preset, dateRule: schedule.recognitionDateRule };
    signatures.push(
      accrualPreviewFingerprint(
        source.snapshot,
        schedule.family,
        period,
        before,
        schedule.revision,
        schedule.id,
      ),
    );
    const line = patch.splits?.find(
      (_, index) => retainedCategoryIds.get(index) === row.sourceSplitId,
    );
    const removed =
      removedComponents.has(row.sourceSplitId) ||
      (patch.splits !== undefined &&
        (row.sourceSplitId ? !line : patch.splits.length > 0));
    const paymentDateAfter =
      patch.transactionDate?.slice(0, 10) ?? source.snapshot.paymentDate;
    let currencyAfter = source.snapshot.currencyCode;
    let decimals = source.snapshot.currencyDecimals;
    if (patch.accountId && patch.accountId !== source.snapshot.accountId) {
      const accounts = await m.query(
        `SELECT a.currency_code AS code,c.decimal_places AS decimals FROM accounts a
         JOIN currencies c ON c.code=a.currency_code WHERE a.id=$1 AND a.user_id=$2`,
        [patch.accountId, userId],
      );
      if (!accounts[0]) throw accrualErrors.missing();
      currencyAfter = accounts[0].code;
      decimals = Number(accounts[0].decimals);
    }
    const categoryId =
      row.sourceSplitId && splitCategories.has(row.sourceSplitId)
        ? splitCategories.get(row.sourceSplitId)!
        : row.sourceSplitId
          ? line
            ? (line.categoryId ?? null)
            : source.snapshot.categoryId
          : "categoryId" in patch
            ? (patch.categoryId ?? null)
            : source.snapshot.categoryId;
    let family = schedule.family;
    if (categoryId) {
      const categories = await m.query(
        "SELECT is_income FROM categories WHERE id=$1 AND user_id=$2",
        [categoryId, userId],
      );
      if (!categories[0]) throw accrualErrors.missing();
      family =
        categoryFamilies.get(categoryId) ??
        (categories[0].is_income ? "income" : "expense");
    }
    let after: ReturnType<typeof buildAccrualPlan> | null = null;
    if (!removed) {
      const amount = row.sourceSplitId
        ? line
          ? String(line.amount)
          : source.snapshot.amount
        : patch.amount !== undefined
          ? String(patch.amount)
          : source.snapshot.amount;
      try {
        after = buildAccrualPlan(paymentDateAfter, amount, decimals, period);
      } catch {
        throw accrualErrors.period();
      }
    }
    const afterStatus =
      "status" in patch
        ? (patch.status ?? "UNRECONCILED")
        : source.snapshot.status;
    const dates = [
      ...new Set([
        source.snapshot.paymentDate,
        paymentDateAfter,
        ...before.allocations.map((row) => row.recognitionDate),
        ...(after?.allocations.map((row) => row.recognitionDate) ?? []),
      ]),
    ].sort();
    const beforeBalances =
      source.snapshot.status === "VOID"
        ? dates.map(() => "0.0000")
        : accrualBalancesAt(
            schedule.family,
            source.snapshot.paymentDate,
            before,
            dates,
          );
    const afterBalances =
      !after || afterStatus === "VOID"
        ? dates.map(() => "0.0000")
        : accrualBalancesAt(family, paymentDateAfter, after, dates);
    const timingBalances = dates.map((asOf, index) => ({
      asOf,
      before: beforeBalances[index],
      after: afterBalances[index],
    }));
    impacts.push({
      scheduleId: schedule.id,
      sourceSplitId: row.sourceSplitId,
      removed,
      before,
      after,
      familyBefore: schedule.family,
      familyAfter: removed ? null : family,
      currencyBefore: schedule.currencyCode,
      currencyAfter,
      paymentDateBefore: source.snapshot.paymentDate,
      paymentDateAfter,
      timingBalances,
    });
  }
  const { accrualImpactFingerprint: _ignored, ...input } = patch;
  const fingerprint = impacts.length
    ? createHash("sha256")
        .update(
          JSON.stringify(
            canonical({
              version: "accrual-source-edit-v1",
              userId,
              transactionId,
              input,
              signatures,
              impacts,
            }),
          ),
        )
        .digest("hex")
    : null;
  return {
    fingerprint,
    impacts,
    retainedCategoryIds,
    removedScheduleIds: impacts
      .filter((row) => row.removed)
      .map((row) => row.scheduleId),
  };
}

export async function verifySourceAccrualEdit(
  m: EntityManager,
  userId: string,
  transactionId: string,
  patch: EditPatch,
  expected: string | undefined,
): Promise<AccrualEditResolution> {
  const result = await resolveSourceAccrualEdit(
    m,
    userId,
    transactionId,
    patch,
  );
  if (
    result.fingerprint
      ? result.fingerprint !== expected
      : expected !== undefined
  )
    throw accrualErrors.conflict();
  return result;
}
export async function removeReviewedAccruals(
  m: EntityManager,
  userId: string,
  result: AccrualEditResolution,
): Promise<void> {
  if (result.removedScheduleIds.length)
    await m.delete(AccrualSchedule, {
      userId,
      id: In([...result.removedScheduleIds]),
    });
}

/** Retain only explicitly identified category rows; other rows follow existing rebuild semantics. */
export async function deleteReplacedSplits(
  m: EntityManager,
  transactionId: string,
  retained: ReadonlyMap<number, string>,
): Promise<void> {
  const ids = [...retained.values()];
  if (!ids.length) {
    await m.delete(TransactionSplit, { transactionId });
    return;
  }
  await m.query(
    "DELETE FROM transaction_split_tags WHERE transaction_split_id=ANY($1::uuid[])",
    [ids],
  );
  await m.delete(TransactionSplit, { transactionId, id: Not(In(ids)) });
}

export async function previewSourceAccrualEdit(
  m: EntityManager,
  userId: string,
  transactionId: string,
  patch: EditPatch,
) {
  if (!(await lockTransactionRow(m, transactionId, userId)))
    throw accrualErrors.missing();
  const result = await resolveSourceAccrualEdit(
    m,
    userId,
    transactionId,
    patch,
  );
  return {
    fingerprint: result.fingerprint,
    impacts: result.impacts,
    retainedSplitIds: [...result.retainedCategoryIds.values()],
  };
}

/** Equality of canonical, source-linked history snapshots. */
export function equalAccrualSnapshots(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
