import { requireAccrualOwner } from "./accrual-source";
import { type EntityManager } from "typeorm";
import { ActionHistory } from "../action-history/entities/action-history.entity";
import { MAX_JSONB_SIZE_BYTES } from "../action-history/history-limits";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeeAlias } from "../payees/entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { lockTransactionRows } from "../common/db/locks";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import {
  captureAccrualHistorySnapshot,
  assertAccrualHistoryState,
  restoreAccrualHistoryState,
} from "./accrual-history-snapshot";
import { equalAccrualSnapshots as same } from "./accrual-source-edit";
import { accrualErrors } from "./accrual-errors";

type Row = Record<string, any>;
interface Scope {
  kind: "category" | "payee";
  ids: string[];
  sourceIds: string[];
  payeeIds: string[];
  scheduledIds: string[];
}
export interface TaxonomyOperation {
  version: 2;
  scope: Scope;
  categories: Row[];
  payees: Row[];
  aliases: Row[];
  sources: Row[];
  scheduled: Row[];
  scheduledSplits: Row[];
}
function bounded(v: unknown) {
  if (Buffer.byteLength(JSON.stringify(v), "utf8") > MAX_JSONB_SIZE_BYTES)
    throw accrualErrors.historyUnsupported();
}

/** Freeze parents before legs and taxonomy before inspecting FK membership. Rare destructive operations deliberately use a closed owner set. */
async function freeze(m: EntityManager, userId: string) {
  const rows: { id: string }[] = await m.query(
    "SELECT id FROM transactions WHERE user_id=$1 AND parent_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=transactions.id) ORDER BY id FOR UPDATE",
    [userId],
  );
  await m.query(
    "SELECT id FROM transactions WHERE user_id=$1 AND (parent_transaction_id IS NOT NULL OR EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=transactions.id)) ORDER BY id FOR UPDATE",
    [userId],
  );
  await m.query(
    "SELECT id FROM payees WHERE user_id=$1 ORDER BY id FOR UPDATE",
    [userId],
  );
  await m.query(
    "SELECT id FROM categories WHERE user_id=$1 ORDER BY id FOR UPDATE",
    [userId],
  );
  await m.query(
    "SELECT id FROM scheduled_transactions WHERE user_id=$1 ORDER BY id FOR UPDATE",
    [userId],
  );
  await m.query(
    "SELECT s.id FROM scheduled_transaction_splits s JOIN scheduled_transactions t ON t.id=s.scheduled_transaction_id WHERE t.user_id=$1 ORDER BY s.id FOR UPDATE OF s",
    [userId],
  );
  await m.query(
    "SELECT id FROM payee_aliases WHERE user_id=$1 ORDER BY id FOR UPDATE",
    [userId],
  );
  const fresh = await m.query(
    "SELECT id FROM transactions WHERE user_id=$1 AND parent_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=transactions.id) ORDER BY id",
    [userId],
  );
  if (!same(rows, fresh)) throw accrualErrors.conflict();
}
async function discover(
  m: EntityManager,
  userId: string,
  kind: Scope["kind"],
  ids: string[],
) {
  const sources: { id: string }[] = await m.query(
    kind === "payee"
      ? "SELECT id FROM transactions WHERE user_id=$1 AND payee_id=ANY($2::uuid[]) ORDER BY id"
      : "SELECT t.id FROM transactions t WHERE t.user_id=$1 AND (t.category_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id AND s.category_id=ANY($2::uuid[]))) ORDER BY t.id",
    [userId, ids],
  );
  const scheduled: { id: string }[] = await m.query(
    kind === "payee"
      ? "SELECT id FROM scheduled_transactions WHERE user_id=$1 AND payee_id=ANY($2::uuid[]) ORDER BY id"
      : "SELECT t.id FROM scheduled_transactions t WHERE t.user_id=$1 AND (t.category_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM scheduled_transaction_splits s WHERE s.scheduled_transaction_id=t.id AND s.category_id=ANY($2::uuid[]))) ORDER BY t.id",
    [userId, ids],
  );
  const payees: { id: string }[] =
    kind === "payee"
      ? ids.map((id) => ({ id }))
      : await m.query(
          "SELECT id FROM payees WHERE user_id=$1 AND default_category_id=ANY($2::uuid[]) ORDER BY id",
          [userId, ids],
        );
  return {
    sourceIds: sources.map((r) => r.id),
    scheduledIds: scheduled.map((r) => r.id),
    payeeIds: payees.map((r) => r.id).sort(),
  };
}
async function capture(
  m: EntityManager,
  userId: string,
  scope: Scope,
): Promise<TaxonomyOperation> {
  const raw = async (table: string, ids: string[]) =>
    (
      await m.query(
        `SELECT to_jsonb(r)-'updated_at' AS row FROM ${table} r WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
        [userId, ids],
      )
    ).map((r: { row: Row }) => r.row);
  const categories =
    scope.kind === "category" ? await raw("categories", scope.ids) : [];
  const payees = await raw("payees", scope.payeeIds);
  const aliases = (
    await m.query(
      "SELECT to_jsonb(a) AS row FROM payee_aliases a WHERE user_id=$1 AND payee_id=ANY($2::uuid[]) ORDER BY id",
      [userId, scope.payeeIds],
    )
  ).map((r: { row: Row }) => r.row);
  const scheduled = await raw("scheduled_transactions", scope.scheduledIds);
  const scheduledSplits = (
    await m.query(
      "SELECT to_jsonb(s) AS row FROM scheduled_transaction_splits s JOIN scheduled_transactions t ON t.id=s.scheduled_transaction_id WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY s.id",
      [userId, scope.scheduledIds],
    )
  ).map((r: { row: Row }) => r.row);
  const sources: Row[] = [];
  for (const id of scope.sourceIds) {
    const row: Row = {};
    await captureAccrualHistorySnapshot(m, userId, id, row, true);
    sources.push(row);
  }
  const state = JSON.parse(
    JSON.stringify({
      version: 2,
      scope,
      categories,
      payees,
      aliases,
      sources,
      scheduled,
      scheduledSplits,
    }),
  ) as TaxonomyOperation;
  bounded(state);
  return state;
}
export async function beginTaxonomyOperation(
  m: EntityManager,
  userId: string,
  kind: Scope["kind"],
  selected: string[],
): Promise<TaxonomyOperation | undefined> {
  // Cash-only installations retain their existing mutation/history contract.
  const accrued = await m.query(
    "SELECT id FROM accrual_schedules WHERE user_id=$1 LIMIT 1",
    [userId],
  );
  if (!accrued.length) return undefined;
  requireAccrualOwner(userId);
  await freeze(m, userId);
  const ids = [...new Set(selected)].sort();
  const scope = { kind, ids, ...(await discover(m, userId, kind, ids)) };
  const state = await capture(m, userId, scope);
  bounded([state, state]);
  return state;
}
export async function recordTaxonomyOperation(
  m: EntityManager,
  userId: string,
  before: TaxonomyOperation | undefined,
): Promise<void> {
  if (!before) return;
  const after = await capture(m, userId, before.scope);
  bounded([before, after]);
  const repo = m.getRepository(ActionHistory);
  await repo.delete({ userId, isUndone: true });
  await repo.save(
    repo.create({
      userId,
      entityType: "accrual_relationship_operation",
      entityId: before.scope.ids[0],
      action: "update",
      beforeData: { taxonomyOperation: before },
      afterData: { taxonomyOperation: after },
      description: `Updated ${before.scope.kind} relationships`,
      descriptionKey:
        before.scope.kind === "payee" ? "updatedPayee" : "updatedCategory",
      descriptionParams: {
        name: String(
          before.payees[0]?.name ?? before.categories[0]?.name ?? "",
        ),
      },
    }),
  );
}
function parse(value: unknown, action: ActionHistory): TaxonomyOperation {
  const s = value as TaxonomyOperation;
  if (
    !s ||
    s.version !== 2 ||
    !s.scope ||
    !["category", "payee"].includes(s.scope.kind)
  )
    throw accrualErrors.conflict();
  for (const key of ["ids", "sourceIds", "payeeIds", "scheduledIds"] as const) {
    const ids = s.scope[key];
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === "string") ||
      !same(ids, [...new Set(ids)].sort())
    )
      throw accrualErrors.conflict();
  }
  for (const key of [
    "categories",
    "payees",
    "aliases",
    "sources",
    "scheduled",
    "scheduledSplits",
  ] as const)
    if (!Array.isArray(s[key])) throw accrualErrors.conflict();
  for (const row of [
    ...s.categories,
    ...s.payees,
    ...s.aliases,
    ...s.scheduled,
  ])
    if (row.user_id !== action.userId) throw accrualErrors.conflict();
  if (
    !same(
      s.sources.map((r) => r.id),
      s.scope.sourceIds,
    )
  )
    throw accrualErrors.conflict();
  bounded(s);
  return s;
}
function fields(m: EntityManager, entity: any, row: Row): Row {
  const result: Row = {};
  for (const col of m.getRepository(entity).metadata.columns)
    if (col.databaseName in row)
      result[col.propertyName] = row[col.databaseName];
  return result;
}
/** PostgreSQL parses its own timestamp text without JavaScript millisecond truncation. */
async function insertExact(
  m: EntityManager,
  table: "categories" | "payees" | "payee_aliases",
  row: Row,
): Promise<void> {
  await m.query(
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
    [JSON.stringify(row)],
  );
}

/** Restore only relationships and settings. Financial source fields are comparison witnesses, never replayed. */
export async function replayTaxonomyOperation(
  m: EntityManager,
  action: ActionHistory,
): Promise<void> {
  const target = parse(action.beforeData?.taxonomyOperation, action),
    expected = parse(action.afterData?.taxonomyOperation, action);
  if (!same(target.scope, expected.scope)) throw accrualErrors.conflict();
  await freeze(m, action.userId);
  const scope = target.scope,
    refs = await discover(m, action.userId, scope.kind, scope.ids);
  for (const key of ["sourceIds", "scheduledIds", "payeeIds"] as const)
    if (refs[key].some((id) => !scope[key].includes(id)))
      throw accrualErrors.conflict();
  if (!same(await capture(m, action.userId, scope), expected))
    throw accrualErrors.conflict();
  const locked = await lockTransactionRows(m, scope.sourceIds, action.userId);
  if (locked.size !== scope.sourceIds.length) throw accrualErrors.conflict();
  await assertReconciledRowsMutable(m, action.userId, [...locked.values()]);
  for (const row of expected.sources)
    await assertAccrualHistoryState(m, action.userId, row.id, row.accrualState);
  // Validate all external references before writes; recreated roots are the only permitted missing targets.
  const categoryIds = new Set<string>(),
    payeeIds = new Set<string>();
  for (const row of target.categories)
    if (row.parent_id) categoryIds.add(row.parent_id);
  for (const row of target.payees)
    if (row.default_category_id) categoryIds.add(row.default_category_id);
  for (const row of target.sources) {
    if (row.categoryId) categoryIds.add(row.categoryId);
    if (row.payeeId) payeeIds.add(row.payeeId);
    for (const line of row.splits ?? [])
      if (line.categoryId) categoryIds.add(line.categoryId);
  }
  for (const row of target.scheduled) {
    if (row.category_id) categoryIds.add(row.category_id);
    if (row.payee_id) payeeIds.add(row.payee_id);
  }
  for (const row of target.scheduledSplits)
    if (row.category_id) categoryIds.add(row.category_id);
  const cats: Row[] = await m.query(
    "SELECT id,is_income,parent_id FROM categories WHERE user_id=$1 ORDER BY id",
    [action.userId],
  );
  const projected = new Map(
    cats
      .filter((r) => !scope.ids.includes(r.id) || scope.kind !== "category")
      .map((r) => [r.id, r]),
  );
  for (const row of target.categories) projected.set(row.id, row);
  const existingPayees: Row[] = await m.query(
    "SELECT id FROM payees WHERE user_id=$1",
    [action.userId],
  );
  const projectedPayees = new Set(
    existingPayees
      .filter((r) => !scope.payeeIds.includes(r.id))
      .map((r) => r.id),
  );
  for (const row of target.payees) projectedPayees.add(row.id);
  if (
    [...categoryIds].some((id) => !projected.has(id)) ||
    [...payeeIds].some((id) => !projectedPayees.has(id))
  )
    throw accrualErrors.conflict();
  for (const row of projected.values()) {
    const seen = new Set<string>();
    let current: Row | undefined = row;
    while (current?.parent_id) {
      if (seen.has(current.id) || !projected.has(current.parent_id))
        throw accrualErrors.conflict();
      seen.add(current.id);
      current = projected.get(current.parent_id);
    }
  }
  for (const source of target.sources)
    for (const schedule of source.accrualState?.schedules ?? []) {
      const categoryId = schedule.sourceSplitId
        ? source.splits?.find((r: Row) => r.id === schedule.sourceSplitId)
            ?.categoryId
        : source.categoryId;
      if (
        categoryId &&
        (projected.get(categoryId)?.is_income ? "income" : "expense") !==
          schedule.family
      )
        throw accrualErrors.conflict();
    }
  const saveRoots = async (entity: any, rows: Row[], existing: Row[]) => {
    const pending = [...rows];
    while (pending.length) {
      const i = pending.findIndex(
        (row) => !row.parent_id || !pending.some((p) => p.id === row.parent_id),
      );
      if (i < 0) throw accrualErrors.conflict();
      const row = pending.splice(i, 1)[0],
        data = fields(m, entity, row);
      if (existing.some((r) => r.id === row.id)) {
        delete data.id;
        delete data.userId;
        delete data.createdAt;
        await m.update(entity, { id: row.id, userId: action.userId }, data);
      } else
        await insertExact(
          m,
          entity === Category ? "categories" : "payees",
          row,
        );
    }
  };
  await saveRoots(Category, target.categories, expected.categories);
  await saveRoots(Payee, target.payees, expected.payees);
  for (const row of target.sources) {
    await m.update(
      Transaction,
      { id: row.id, userId: action.userId },
      {
        categoryId: row.categoryId,
        payeeId: row.payeeId,
        payeeName: row.payeeName,
      },
    );
    for (const line of row.splits ?? [])
      await m.update(
        TransactionSplit,
        { id: line.id, transactionId: row.id },
        { categoryId: line.categoryId },
      );
    await restoreAccrualHistoryState(
      m,
      action.userId,
      row.id,
      row.accrualState,
    );
  }
  for (const row of target.scheduled)
    await m.update(
      ScheduledTransaction,
      { id: row.id, userId: action.userId },
      {
        categoryId: row.category_id,
        payeeId: row.payee_id,
        payeeName: row.payee_name,
      },
    );
  for (const row of target.scheduledSplits)
    await m.update(
      ScheduledTransactionSplit,
      { id: row.id, scheduledTransactionId: row.scheduled_transaction_id },
      { categoryId: row.category_id },
    );
  for (const row of expected.aliases)
    await m.delete(PayeeAlias, { id: row.id, userId: action.userId });
  for (const row of target.aliases) await insertExact(m, "payee_aliases", row);
  for (const row of expected.payees)
    if (!target.payees.some((r) => r.id === row.id))
      await m.delete(Payee, { id: row.id, userId: action.userId });
  for (const row of expected.categories)
    if (!target.categories.some((r) => r.id === row.id))
      await m.delete(Category, { id: row.id, userId: action.userId });
  const actual = await capture(m, action.userId, scope);
  bounded([actual, expected]);
  const side = action.isUndone ? "afterData" : "beforeData";
  const result = await m
    .createQueryBuilder()
    .update(ActionHistory)
    .set({ [side]: { taxonomyOperation: actual } })
    .where("id=:id AND user_id=:userId AND is_undone=:isUndone", {
      id: action.id,
      userId: action.userId,
      isUndone: action.isUndone ?? false,
    })
    .execute();
  if (result.affected !== 1) throw accrualErrors.conflict();
}
