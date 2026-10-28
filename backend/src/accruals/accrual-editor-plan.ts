import type { AccrualSourceSnapshot } from "./accrual-fingerprint";
import type { AccrualPlan } from "./accrual-allocation";
import { createHash } from "node:crypto";
import { EntityManager } from "typeorm";
import { canonical, previewSourceAccrualEdit } from "./accrual-source-edit";
import { loadAccrualSource, requireAccrualOwner } from "./accrual-source";
import { findAccrual, storedAccrualPlan } from "./accrual-store";
import { buildAccrualPlan, type AccrualPeriod } from "./accrual-allocation";
import { accrualBalancesAt, type AccrualFamily } from "./accrual-balance";
import { accrualErrors } from "./accrual-errors";
import type { AccrualEditorPreviewDto } from "./dto/accrual-editor.dto";

/** Preview is read-only. Commit regenerates this under the source writer's lock. */
export async function previewAccrualEditor(
  m: EntityManager,
  userId: string,
  id: string,
  dto: AccrualEditorPreviewDto,
) {
  requireAccrualOwner(userId);
  const base = await loadAccrualSource(m, userId, id, null, true, false);
  const revisions = await m.query(
    "SELECT id,source_split_id,revision FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY id",
    [userId, id],
  );
  const seen = new Set<string>();
  const previews: {
    source: AccrualSourceSnapshot;
    plan: AccrualPlan | null;
    before: AccrualPlan | null;
    sourceSplitId: string | null;
    remove?: boolean;
    family?: AccrualFamily;
    expectedScheduleId?: string | null;
    expectedRevision?: number | null;
    timingBalances?: { asOf: string; amount: string }[];
  }[] = [];
  for (const setting of dto.settings) {
    if (
      setting.preset !== "CUSTOM" &&
      (setting.startMonth !== undefined || setting.monthCount !== undefined)
    )
      throw accrualErrors.period();
    const splitId = setting.sourceSplitId ?? null;
    const key = splitId ?? "whole";
    if (setting.sourceTransactionId !== id || seen.has(key))
      throw accrualErrors.ineligible();
    seen.add(key);
    const loaded = splitId
      ? await loadAccrualSource(m, userId, id, splitId, true, false)
      : base;
    const existing = await findAccrual(m, userId, id, splitId);
    const before = existing
      ? await storedAccrualPlan(m, userId, existing)
      : null;
    if (setting.remove) {
      if (!existing) throw accrualErrors.conflict();
      previews.push({
        source: loaded.snapshot,
        remove: true,
        plan: null,
        before,
        sourceSplitId: splitId,
      });
      continue;
    }
    const patch = dto.patch;
    const line = patch.splits?.find((value) => value.id === splitId);
    const isSplit =
      patch.splits !== undefined ? patch.splits.length > 0 : !base.kindEligible;
    if (
      (splitId && (!isSplit || (patch.splits !== undefined && !line))) ||
      (!splitId && isSplit) ||
      (line && line.transferAccountId) ||
      (patch.status ?? base.snapshot.status) === "VOID"
    )
      throw accrualErrors.ineligible();
    if (!loaded.kindEligible && !(splitId && line))
      throw accrualErrors.ineligible();
    let currencyCode = loaded.snapshot.currencyCode;
    let currencyDecimals = loaded.snapshot.currencyDecimals;
    if (patch.accountId && patch.accountId !== base.snapshot.accountId) {
      const accounts = await m.query(
        "SELECT a.currency_code,c.decimal_places FROM accounts a JOIN currencies c ON c.code=a.currency_code WHERE a.user_id=$1 AND a.id=$2",
        [userId, patch.accountId],
      );
      if (!accounts[0]) throw accrualErrors.missing();
      currencyCode = accounts[0].currency_code;
      currencyDecimals = Number(accounts[0].decimal_places);
    }
    const categoryId = splitId
      ? line
        ? (line.categoryId ?? null)
        : loaded.snapshot.categoryId
      : "categoryId" in patch
        ? (patch.categoryId ?? null)
        : loaded.snapshot.categoryId;
    let family: AccrualFamily | undefined =
      setting.family ?? loaded.family ?? undefined;
    if (categoryId) {
      const categories = await m.query(
        "SELECT is_income FROM categories WHERE id=$1 AND user_id=$2",
        [categoryId, userId],
      );
      if (!categories[0]) throw accrualErrors.missing();
      family = categories[0].is_income ? "income" : "expense";
    }
    if (!family) throw accrualErrors.family();
    const source = {
      ...loaded.snapshot,
      categoryId,
      currencyCode,
      currencyDecimals,
      accountId: patch.accountId ?? loaded.snapshot.accountId,
      amount: line
        ? String(line.amount)
        : splitId
          ? loaded.snapshot.amount
          : patch.amount !== undefined
            ? String(patch.amount)
            : loaded.snapshot.amount,
      paymentDate:
        patch.transactionDate?.slice(0, 10) ?? loaded.snapshot.paymentDate,
    };
    const period: AccrualPeriod =
      setting.preset === "CUSTOM"
        ? {
            preset: "CUSTOM",
            startMonth: setting.startMonth!,
            monthCount: setting.monthCount!,
            dateRule: setting.dateRule,
          }
        : { preset: setting.preset, dateRule: setting.dateRule };
    let plan;
    try {
      plan = buildAccrualPlan(
        source.paymentDate,
        source.amount,
        currencyDecimals,
        period,
      );
    } catch {
      throw accrualErrors.period();
    }
    const dates = [
      ...new Set([
        source.paymentDate,
        ...plan.allocations.map((row) => row.recognitionDate),
      ]),
    ].sort();
    const balances = accrualBalancesAt(family, source.paymentDate, plan, dates);
    previews.push({
      source,
      family,
      plan,
      before,
      expectedScheduleId: existing?.id ?? null,
      expectedRevision: existing?.revision ?? null,
      sourceSplitId: splitId,
      timingBalances: dates.map((asOf, index) => ({
        asOf,
        amount: balances[index],
      })),
    });
  }
  const impact = await previewSourceAccrualEdit(m, userId, id, dto.patch);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          version: 1,
          source: base.snapshot,
          revisions,
          patch: dto.patch,
          settings: dto.settings,
          previews,
        }),
      ),
    )
    .digest("hex");
  return { fingerprint, previews, impactFingerprint: impact.fingerprint };
}
