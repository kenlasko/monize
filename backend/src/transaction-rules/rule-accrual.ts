import { lockTransactionRows } from "../common/db/locks";
import { createHash } from "node:crypto";
import { tokenHashesEqual } from "../auth/crypto.util";
import type { EntityManager } from "typeorm";
import {
  resolveSourceAccrualEdit,
  canonical,
} from "../accruals/accrual-source-edit";
import type { AccrualEditResolution } from "../accruals/accrual-source-edit";
import { accrualErrors } from "../accruals/accrual-errors";
import { requireAccrualOwner } from "../accruals/accrual-source";
import type { PlannedUnit, RowSnapshot } from "./rule-run-snapshot";
import type { RuleEffects } from "./rule-effects";
import {
  readAccrualHistoryState,
  assertAccrualHistoryState,
  restoreAccrualHistoryState,
} from "../accruals/accrual-history-snapshot";

export interface RuleAccrualImpact {
  transactionId: string;
  fingerprint: string | null;
  schedules: AccrualEditResolution["impacts"];
  references: { payees: string[]; categories: string[] };
}

/** Caller already freezes source parents before discovering configurations. */
export async function accruedRuleSources(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows: { id: string }[] = await m.query(
    "SELECT DISTINCT source_transaction_id AS id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=ANY($2) ORDER BY id",
    [userId, [...new Set(ids)].sort()],
  );
  return new Set(rows.map((row) => row.id));
}

function assertSupported(effects: RuleEffects): void {
  // Structural conversion and creating reference data need a separate reviewed contract.
  if (
    effects.changes.structure !== undefined ||
    effects.changes.createPayee !== undefined
  )
    throw accrualErrors.ruleUnsupported();
}

/** Pure financial preview: exact stored amount/split IDs stay inside the shared resolver. */
export async function planRuleAccruals(
  m: EntityManager,
  userId: string,
  units: readonly PlannedUnit[],
  tags: ReadonlyMap<string, readonly string[]>,
): Promise<RuleAccrualImpact[]> {
  const ids = units.flatMap(({ unit }) => unit.legs.map((row) => row.id));
  const accrued = await accruedRuleSources(m, userId, ids);
  if (accrued.size) requireAccrualOwner(userId);
  if (
    accrued.size &&
    units.some(({ effects }) => effects.changes.structure !== undefined)
  )
    throw accrualErrors.ruleUnsupported();
  const active = units.filter(({ unit }) =>
    unit.legs.some((row) => accrued.has(row.id)),
  );
  const payeeIds = [
    ...new Set(
      active.flatMap(({ effects }) =>
        effects.changes.payeeId ? [effects.changes.payeeId] : [],
      ),
    ),
  ].sort();
  const categoryIds = [
    ...new Set(
      active.flatMap(({ effects }) =>
        effects.changes.categoryId ? [effects.changes.categoryId] : [],
      ),
    ),
  ].sort();
  const payees: { id: string; name: string; snapshot: string }[] =
    payeeIds.length
      ? await m.query(
          "SELECT id,name,to_jsonb(p)::text AS snapshot FROM payees p WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE",
          [userId, payeeIds],
        )
      : [];
  const categories: { id: string; snapshot: string }[] = categoryIds.length
    ? await m.query(
        "SELECT id,to_jsonb(c)::text AS snapshot FROM categories c WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE",
        [userId, categoryIds],
      )
    : [];
  if (
    payees.length !== payeeIds.length ||
    categories.length !== categoryIds.length
  )
    throw accrualErrors.conflict();
  const references = {
    payees: payees.map((row) => row.snapshot),
    categories: categories.map((row) => row.snapshot),
  };
  const impacts: RuleAccrualImpact[] = [];
  for (const { unit, effects } of units) {
    for (const row of unit.legs) {
      if (!accrued.has(row.id)) continue;
      assertSupported(effects);
      const c = effects.changes;
      const patch: Parameters<typeof resolveSourceAccrualEdit>[3] = {};
      if (c.categoryId !== undefined) patch.categoryId = c.categoryId;
      if (c.payeeId !== undefined) {
        patch.payeeId = c.payeeId;
        if (c.payeeId)
          patch.payeeName = payees.find(
            (value) => value.id === c.payeeId,
          )!.name;
      }
      if (c.payeeName !== undefined) patch.payeeName = c.payeeName;
      if (c.description !== undefined) patch.description = c.description;
      if (c.addTagIds.length || c.removeTagIds.length) {
        patch.tagIds = [
          ...new Set([
            ...(tags.get(row.id) ?? []).filter(
              (id) => !c.removeTagIds.includes(id),
            ),
            ...c.addTagIds,
          ]),
        ].sort();
      }
      const result = await resolveSourceAccrualEdit(m, userId, row.id, patch);
      impacts.push({
        transactionId: row.id,
        fingerprint: result.fingerprint,
        schedules: result.impacts,
        references,
      });
    }
  }
  return impacts.sort((a, b) => a.transactionId.localeCompare(b.transactionId));
}

export function ruleAccrualFingerprint(
  base: string,
  impacts: readonly RuleAccrualImpact[],
): string {
  return impacts.length
    ? createHash("sha256")
        .update(JSON.stringify(canonical({ version: 1, base, impacts })))
        .digest("hex")
    : base;
}

/** Before payee creation or any mutation. Automatic paths have no confirmation. */
export async function assertRuleAccrualWrite(
  m: EntityManager,
  userId: string,
  id: string,
  effects: RuleEffects,
  source: string,
): Promise<boolean> {
  const accrued = (await accruedRuleSources(m, userId, [id])).has(id);
  if (!accrued) return false;
  requireAccrualOwner(userId);
  if (source !== "manual") throw accrualErrors.conflict();
  assertSupported(effects);
  return true;
}

async function sourceHash(
  m: EntityManager,
  userId: string,
  id: string,
): Promise<string> {
  const rows: { snapshot: string }[] = await m.query(
    `SELECT jsonb_build_object('source',to_jsonb(t)-'updated_at','splits',
       COALESCE((SELECT jsonb_agg(to_jsonb(s)-'updated_at' ORDER BY s.id) FROM transaction_splits s WHERE s.transaction_id=t.id),'[]'::jsonb),
       'tags',ARRAY(SELECT tt.tag_id FROM transaction_tags tt WHERE tt.transaction_id=t.id ORDER BY tt.tag_id))::text AS snapshot
     FROM transactions t WHERE t.id=$1 AND t.user_id=$2`,
    [id, userId],
  );
  if (!rows[0]) throw accrualErrors.conflict();
  return createHash("sha256").update(rows[0].snapshot).digest("hex");
}

/** Compact exact configuration plus full raw source digest for stale/ABA-safe replay. */
export async function captureRuleAccrualHistory(
  m: EntityManager,
  userId: string,
  rows: readonly RowSnapshot[],
): Promise<void> {
  const accrued = await accruedRuleSources(
    m,
    userId,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if (!accrued.has(row.id)) continue;
    requireAccrualOwner(userId);
    row.ruleAccrual = {
      state: await readAccrualHistoryState(m, userId, row.id),
      sourceHash: await sourceHash(m, userId, row.id),
    };
  }
}

export async function assertRuleAccrualHistory(
  m: EntityManager,
  userId: string,
  targets: readonly RowSnapshot[],
  expected: readonly RowSnapshot[],
): Promise<string[]> {
  const accrued = await accruedRuleSources(
    m,
    userId,
    targets.map((row) => row.id),
  );
  const relevant = targets.filter(
    (row) => accrued.has(row.id) || row.ruleAccrual !== undefined,
  );
  const payeeIds = [
    ...new Set(
      relevant.flatMap((row) =>
        typeof row.payeeId === "string" ? [row.payeeId] : [],
      ),
    ),
  ].sort();
  const categoryIds = [
    ...new Set(
      relevant.flatMap((row) =>
        typeof row.categoryId === "string" ? [row.categoryId] : [],
      ),
    ),
  ].sort();
  const payees: { id: string }[] = payeeIds.length
    ? await m.query(
        "SELECT id FROM payees WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE",
        [userId, payeeIds],
      )
    : [];
  const categories: { id: string }[] = categoryIds.length
    ? await m.query(
        "SELECT id FROM categories WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE",
        [userId, categoryIds],
      )
    : [];
  if (
    payees.length !== payeeIds.length ||
    categories.length !== categoryIds.length
  )
    throw accrualErrors.conflict();
  const refresh: string[] = [];
  for (const target of targets) {
    const prior = expected.find((row) => row.id === target.id);
    const value = prior?.ruleAccrual as
      { state?: unknown; sourceHash?: string } | undefined;
    if (
      !accrued.has(target.id) &&
      value === undefined &&
      target.ruleAccrual === undefined
    )
      continue;
    if (target.structure || !value || !target.ruleAccrual)
      throw accrualErrors.conflict();
    await assertAccrualHistoryState(m, userId, target.id, value.state);
    if (
      !tokenHashesEqual(
        await sourceHash(m, userId, target.id),
        value.sourceHash ?? null,
      )
    )
      throw accrualErrors.conflict();
    refresh.push(target.id);
  }
  return refresh;
}

export async function refreshRuleAccrualHistory(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
  targets: readonly RowSnapshot[],
): Promise<void> {
  for (const id of ids) {
    const target = targets.find((row) => row.id === id);
    const value = target?.ruleAccrual as { state?: unknown } | undefined;
    if (!value) throw accrualErrors.conflict();
    // An uncategorized source inherits its explicit historical family, not the
    // category family the rule just removed during undo.
    await restoreAccrualHistoryState(m, userId, id, value.state);
  }
  await captureRuleAccrualHistory(
    m,
    userId,
    targets.filter((row) => ids.includes(row.id)),
  );
}

/** Existing sources passed to a new-row API cannot bypass reviewed edits. */
export async function assertAutomaticRuleSources(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  await lockTransactionRows(m, ids, userId);
  const accrued = await accruedRuleSources(m, userId, ids);
  if (accrued.size) throw accrualErrors.conflict();
}
