import { type EntityManager } from "typeorm";
import { ActionHistory } from "../action-history/entities/action-history.entity";
import { MAX_JSONB_SIZE_BYTES } from "../action-history/history-limits";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { lockTransactionRows } from "../common/db/locks";
import { prepareCategoryMutation } from "../categories/category-mutation";
import { lockPayeeCategoryBatch } from "../payees/payee-category-batch";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import {
  captureAccrualHistorySnapshot,
  assertAccrualHistoryState,
  restoreAccrualHistoryState,
} from "./accrual-history-snapshot";
import { equalAccrualSnapshots as same } from "./accrual-source-edit";
import { accrualErrors } from "./accrual-errors";

type Snapshot = Record<string, any>;
export interface RelationshipState {
  version: 1;
  kind: "category" | "payee";
  id: string;
  sourceIds: string[];
  categoryIds: string[];
  entity: Snapshot;
  categories: Snapshot[];
  sources: Snapshot[];
  scheduled: Snapshot[];
}
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
function bounded(v: unknown) {
  if (size(v) > MAX_JSONB_SIZE_BYTES) throw accrualErrors.historyUnsupported();
}

/** Caller freezes all source/relationship rows first. Raw numeric text stays exact. */
export async function captureRelationshipState(
  m: EntityManager,
  userId: string,
  kind: "category" | "payee",
  id: string,
  sourceIds: readonly string[],
  categoryIds: readonly string[],
): Promise<RelationshipState> {
  const entityRows: { entity: Snapshot }[] =
    kind === "category"
      ? await m.query(
          "SELECT to_jsonb(c)-'updated_at' AS entity FROM categories c WHERE user_id=$1 AND id=$2",
          [userId, id],
        )
      : await m.query(
          "SELECT to_jsonb(p)-'updated_at' AS entity FROM payees p WHERE user_id=$1 AND id=$2",
          [userId, id],
        );
  if (!entityRows[0]) throw accrualErrors.conflict();
  const categories: Snapshot[] = categoryIds.length
    ? await m.query(
        "SELECT id,parent_id,is_income FROM categories WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
        [userId, [...categoryIds].sort()],
      )
    : [];
  const scheduled: Snapshot[] =
    kind === "payee"
      ? await m.query(
          'SELECT id,payee_id AS "payeeId",payee_name AS "payeeName" FROM scheduled_transactions WHERE user_id=$1 AND payee_id=$2 ORDER BY id FOR UPDATE',
          [userId, id],
        )
      : [];
  const sources: Snapshot[] = [];
  for (const sourceId of [...sourceIds].sort()) {
    const snapshot: Snapshot = {};
    await captureAccrualHistorySnapshot(m, userId, sourceId, snapshot, true);
    sources.push(snapshot);
  }
  const state: RelationshipState = {
    version: 1,
    kind,
    id,
    sourceIds: [...sourceIds].sort(),
    categoryIds: [...categoryIds].sort(),
    entity: entityRows[0].entity,
    categories,
    sources,
    scheduled,
  };
  const normalized = JSON.parse(JSON.stringify(state)) as RelationshipState;
  bounded(normalized);
  return normalized;
}

export async function beginRelationshipHistory(
  m: EntityManager,
  userId: string,
  kind: "category" | "payee",
  id: string,
  sourceIds: readonly string[],
  categoryIds: readonly string[] = [],
): Promise<RelationshipState | undefined> {
  if (!sourceIds.length) return undefined;
  const accrued = await m.query(
    "SELECT id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=ANY($2::uuid[]) LIMIT 1",
    [userId, sourceIds],
  );
  if (!accrued.length) return undefined;
  const state = await captureRelationshipState(
    m,
    userId,
    kind,
    id,
    sourceIds,
    categoryIds,
  );
  bounded([state, state]);
  return state;
}

/** Payee updates need a closed source set even when only the name is edited. */
export async function beginPayeeRelationshipHistory(
  m: EntityManager,
  userId: string,
  id: string,
): Promise<RelationshipState | undefined> {
  const locked = await lockPayeeCategoryBatch(m, userId, [id], []);
  return beginRelationshipHistory(
    m,
    userId,
    "payee",
    id,
    locked.sources.map((row) => row.id),
  );
}

/** Required save is last and non-swallowing; the old best-effort entry is skipped. */
export async function recordRelationshipHistory(
  m: EntityManager,
  userId: string,
  before: RelationshipState,
): Promise<void> {
  const after = await captureRelationshipState(
    m,
    userId,
    before.kind,
    before.id,
    before.sourceIds,
    before.categoryIds,
  );
  bounded([before, after]);
  const repo = m.getRepository(ActionHistory);
  await repo.delete({ userId, isUndone: true });
  const name = String(after.entity.name ?? "");
  await repo.save(
    repo.create({
      userId,
      entityType: before.kind,
      entityId: before.id,
      action: "update",
      beforeData: { accrualRelationships: before },
      afterData: { accrualRelationships: after },
      description: `Updated ${before.kind} "${name}"`,
      descriptionKey:
        before.kind === "category" ? "updatedCategory" : "updatedPayee",
      descriptionParams: { name },
    }),
  );
}

function parse(value: unknown, action: ActionHistory): RelationshipState {
  const state = value as RelationshipState | undefined;
  if (
    !state ||
    state.version !== 1 ||
    state.kind !== action.entityType ||
    state.id !== action.entityId ||
    !Array.isArray(state.sourceIds) ||
    !Array.isArray(state.categoryIds) ||
    !Array.isArray(state.sources) ||
    !Array.isArray(state.categories) ||
    !Array.isArray(state.scheduled) ||
    !state.entity ||
    state.entity.id !== state.id ||
    state.entity.user_id !== action.userId ||
    new Set(state.sourceIds).size !== state.sourceIds.length ||
    state.sources.length !== state.sourceIds.length ||
    !same(state.sourceIds, [...state.sourceIds].sort()) ||
    !same(
      state.sources.map((row) => row.id),
      state.sourceIds,
    )
  )
    throw accrualErrors.conflict();
  const normalized = JSON.parse(JSON.stringify(state)) as RelationshipState;
  bounded(normalized);
  return normalized;
}

/** Retained source/split identities only; no bank or financial source values are restored. */
export async function replayRelationshipHistory(
  m: EntityManager,
  action: ActionHistory,
): Promise<boolean> {
  if (
    !action.beforeData?.accrualRelationships &&
    !action.afterData?.accrualRelationships
  )
    return false;
  const target = parse(action.beforeData?.accrualRelationships, action),
    expected = parse(action.afterData?.accrualRelationships, action);
  if (
    !same(target.sourceIds, expected.sourceIds) ||
    !same(target.categoryIds, expected.categoryIds)
  )
    throw accrualErrors.conflict();
  if (target.kind === "category") {
    const edit = await prepareCategoryMutation(m, action.userId, target.id, {
      operation: "update",
      dto: {
        parentId: target.entity.parent_id,
        isIncome: target.entity.is_income,
      },
    });
    if (
      !same(edit.affected, target.categoryIds) ||
      !same(
        edit.sources.map((row) => row.id),
        target.sourceIds,
      ) ||
      edit.newIncome !== target.entity.is_income
    )
      throw accrualErrors.conflict();
  } else {
    const locked = await lockPayeeCategoryBatch(
      m,
      action.userId,
      [target.id],
      [],
    );
    if (
      !same(
        locked.sources.map((row) => row.id),
        target.sourceIds,
      )
    )
      throw accrualErrors.conflict();
  }
  const locked = await lockTransactionRows(m, target.sourceIds, action.userId);
  if (locked.size !== target.sourceIds.length) throw accrualErrors.conflict();
  await assertReconciledRowsMutable(m, action.userId, [...locked.values()]);
  for (const row of expected.sources)
    await assertAccrualHistoryState(m, action.userId, row.id, row.accrualState);
  const current = await captureRelationshipState(
    m,
    action.userId,
    target.kind,
    target.id,
    target.sourceIds,
    target.categoryIds,
  );
  if (!same(current, expected)) throw accrualErrors.conflict();
  const categoryIds = new Set<string>(),
    payeeIds = new Set<string>();
  if (target.entity.default_category_id)
    categoryIds.add(target.entity.default_category_id);
  for (const row of target.sources) {
    if (row.categoryId) categoryIds.add(row.categoryId);
    if (row.payeeId) payeeIds.add(row.payeeId);
    for (const line of row.splits ?? [])
      if (line.categoryId) categoryIds.add(line.categoryId);
  }
  if (target.kind === "payee" && [...payeeIds].some((id) => id !== target.id))
    throw accrualErrors.conflict();
  const payees: { id: string }[] = payeeIds.size
    ? await m.query(
        "SELECT id FROM payees WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
        [action.userId, [...payeeIds].sort()],
      )
    : [];
  const categories: { id: string; is_income: boolean }[] = categoryIds.size
    ? await m.query(
        "SELECT id,is_income FROM categories WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
        [action.userId, [...categoryIds].sort()],
      )
    : [];
  if (payees.length !== payeeIds.size || categories.length !== categoryIds.size)
    throw accrualErrors.conflict();
  for (const source of target.sources) {
    for (const schedule of source.accrualState?.schedules ?? []) {
      const categoryId = schedule.sourceSplitId
        ? source.splits?.find(
            (line: Snapshot) => line.id === schedule.sourceSplitId,
          )?.categoryId
        : source.categoryId;
      if (!categoryId) continue;
      const projection =
        target.categories.find((row) => row.id === categoryId) ??
        categories.find((row) => row.id === categoryId);
      if (
        !projection ||
        (projection.is_income ? "income" : "expense") !== schedule.family
      )
        throw accrualErrors.conflict();
    }
  }
  const entityClass = target.kind === "category" ? Category : Payee;
  const fields: Snapshot = {};
  for (const col of m.getRepository(entityClass).metadata.columns) {
    if (["id", "userId", "createdAt", "updatedAt"].includes(col.propertyName))
      continue;
    if (col.databaseName in target.entity)
      fields[col.propertyName] = target.entity[col.databaseName];
  }
  await m.update(entityClass, { id: target.id, userId: action.userId }, fields);
  for (const category of target.categories)
    if (category.id !== target.id)
      await m.update(
        Category,
        { id: category.id, userId: action.userId },
        { isIncome: category.is_income, parentId: category.parent_id },
      );
  for (const row of target.sources) {
    if (target.kind === "payee") {
      await m.update(
        Transaction,
        { id: row.id, userId: action.userId },
        { categoryId: row.categoryId, payeeName: row.payeeName },
      );
      for (const line of row.splits ?? [])
        await m.update(
          TransactionSplit,
          { id: line.id, transactionId: row.id },
          { categoryId: line.categoryId },
        );
    }
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
      { payeeName: row.payeeName },
    );
  const actual = await captureRelationshipState(
    m,
    action.userId,
    target.kind,
    target.id,
    target.sourceIds,
    target.categoryIds,
  );
  bounded([actual, expected]);
  const side = action.isUndone ? "afterData" : "beforeData";
  const result = await m
    .createQueryBuilder()
    .update(ActionHistory)
    .set({ [side]: { accrualRelationships: actual } })
    .where("id=:id AND user_id=:userId AND is_undone=:isUndone", {
      id: action.id,
      userId: action.userId,
      isUndone: action.isUndone ?? false,
    })
    .execute();
  if (result.affected !== 1) throw accrualErrors.conflict();
  return true;
}

/** Legacy records cannot reconstruct relationships they never captured. */
export async function guardLegacyRelationshipHistory(
  m: EntityManager,
  action: ActionHistory,
): Promise<void> {
  if (!action.entityId || !["category", "payee"].includes(action.entityType))
    return;
  // A deleted legacy entity has already lost nullable FK relationships. Labels
  // can be null, so there is no sound affected-source inference from its name.
  if (action.action === "delete") {
    const anyAccrued = await m.query(
      "SELECT id FROM accrual_schedules WHERE user_id=$1 LIMIT 1",
      [action.userId],
    );
    if (anyAccrued.length) throw accrualErrors.historyUnsupported();
  }
  if (action.entityType === "category") {
    const present = await m.query(
      "SELECT id FROM categories WHERE user_id=$1 AND id=$2",
      [action.userId, action.entityId],
    );
    if (present.length)
      await prepareCategoryMutation(m, action.userId, action.entityId, {
        operation: "update",
        dto: {},
      });
    const rows = await m.query(
      `WITH RECURSIVE family AS (SELECT id FROM categories WHERE user_id=$1 AND id=$2
       UNION SELECT c.id FROM categories c JOIN family f ON c.parent_id=f.id WHERE c.user_id=$1)
       SELECT a.id FROM accrual_schedules a JOIN transactions t ON t.id=a.source_transaction_id
       WHERE a.user_id=$1 AND (t.category_id IN(SELECT id FROM family) OR EXISTS(
       SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id AND s.category_id IN(SELECT id FROM family))) LIMIT 1`,
      [action.userId, action.entityId],
    );
    if (rows.length) throw accrualErrors.historyUnsupported();
  } else {
    await m.query(
      "SELECT id FROM transactions WHERE user_id=$1 AND (payee_id=$2 OR (payee_id IS NULL AND payee_name=ANY($3::text[]))) ORDER BY id FOR UPDATE",
      [
        action.userId,
        action.entityId,
        [action.beforeData?.name, action.afterData?.name].filter(
          (name): name is string => typeof name === "string",
        ),
      ],
    );
    await lockPayeeCategoryBatch(m, action.userId, [action.entityId], []);
    const rows = await m.query(
      `SELECT a.id FROM accrual_schedules a JOIN transactions t ON t.id=a.source_transaction_id
       WHERE a.user_id=$1 AND (t.payee_id=$2 OR (t.payee_id IS NULL AND t.payee_name=ANY($3::text[]))) LIMIT 1`,
      [
        action.userId,
        action.entityId,
        [action.beforeData?.name, action.afterData?.name].filter(
          (name): name is string => typeof name === "string",
        ),
      ],
    );
    if (rows.length) throw accrualErrors.historyUnsupported();
  }
}
