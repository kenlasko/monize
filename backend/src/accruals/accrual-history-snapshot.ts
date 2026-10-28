import { isUUID } from "class-validator";
import type { EntityManager } from "typeorm";
import { AccrualSchedule } from "./entities/accrual-schedule.entity";
import { findAccrual, writeAccrual, type StoredAccrual } from "./accrual-store";
import { loadAccrualSource, requireAccrualOwner } from "./accrual-source";
import { buildAccrualPlan, type AccrualPeriod } from "./accrual-allocation";
import { accrualContentFingerprint } from "./accrual-fingerprint";
import { canonical } from "./accrual-source-edit";
import { accrualErrors } from "./accrual-errors";

export interface AccrualHistoryState {
  version: 1;
  schedules: StoredAccrual[];
}
type Snapshot = Record<string, unknown>;

/** Caller holds the source row lock. Compact settings, never 600 allocation rows. */
export async function readAccrualHistoryState(
  m: EntityManager,
  userId: string,
  transactionId: string,
): Promise<AccrualHistoryState> {
  const schedules: StoredAccrual[] = await m.query(
    `SELECT id,source_transaction_id AS "sourceTransactionId",source_split_id AS "sourceSplitId",
      family,currency_code AS "currencyCode",preset,TO_CHAR(start_month,'YYYY-MM') AS "startMonth",
      month_count AS "monthCount",revision,source_fingerprint AS "sourceFingerprint"
     FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY id`,
    [userId, transactionId],
  );
  return { version: 1, schedules };
}

function stateFrom(value: unknown, transactionId: string): AccrualHistoryState {
  if (!value || typeof value !== "object") throw accrualErrors.conflict();
  const state = value as AccrualHistoryState;
  if (
    state.version !== 1 ||
    !Array.isArray(state.schedules) ||
    state.schedules.length > 100
  )
    throw accrualErrors.conflict();
  const components = new Set<string | null>();
  for (const row of state.schedules) {
    if (
      !row ||
      !isUUID(row.id) ||
      row.sourceTransactionId !== transactionId ||
      (row.sourceSplitId !== null && !isUUID(row.sourceSplitId)) ||
      !["income", "expense"].includes(row.family) ||
      !["LTM", "NTM", "CUSTOM"].includes(row.preset) ||
      !/^[0-9]{4}-[0-9]{2}$/.test(row.startMonth) ||
      !Number.isInteger(row.monthCount) ||
      row.monthCount < 1 ||
      row.monthCount > 600 ||
      !Number.isInteger(row.revision) ||
      row.revision < 1 ||
      !/^[A-Z]{3}$/.test(row.currencyCode) ||
      !/^[a-f0-9]{64}$/.test(row.sourceFingerprint) ||
      components.has(row.sourceSplitId)
    )
      throw accrualErrors.conflict();
    components.add(row.sourceSplitId);
  }
  return state;
}

function periodOf(row: StoredAccrual): AccrualPeriod {
  return row.preset === "CUSTOM"
    ? {
        preset: "CUSTOM",
        startMonth: row.startMonth,
        monthCount: row.monthCount,
        dateRule: row.recognitionDateRule,
      }
    : { preset: row.preset, dateRule: row.recognitionDateRule };
}

/** Refuse changed/recreated schedules and unmaintained source edits before writes. */
export async function assertAccrualHistoryState(
  m: EntityManager,
  userId: string,
  transactionId: string,
  expected: unknown,
): Promise<AccrualHistoryState> {
  const current = await readAccrualHistoryState(m, userId, transactionId);
  if (expected === undefined) {
    if (current.schedules.length) throw accrualErrors.conflict();
    return current; // Legacy cash-only history remains replayable.
  }
  const prior = stateFrom(expected, transactionId);
  if (JSON.stringify(canonical(prior)) !== JSON.stringify(canonical(current)))
    throw accrualErrors.conflict();
  if (current.schedules.length) requireAccrualOwner(userId);
  for (const row of current.schedules) {
    const source = await loadAccrualSource(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
      false,
      false,
    );
    const period = periodOf(row);
    const plan = buildAccrualPlan(
      source.snapshot.paymentDate,
      source.snapshot.amount,
      source.snapshot.currencyDecimals,
      period,
    );
    if (
      !source.kindEligible ||
      accrualContentFingerprint(
        source.snapshot,
        source.family ?? row.family,
        period,
        plan,
      ) !== row.sourceFingerprint
    )
      throw accrualErrors.conflict();
  }
  return current;
}

/** Capture exact money and split tags under the same source lock as the mutation. */
export async function captureAccrualHistorySnapshot(
  m: EntityManager,
  userId: string,
  transactionId: string,
  snapshot: Snapshot,
  force = false,
): Promise<void> {
  const state = await readAccrualHistoryState(m, userId, transactionId);
  snapshot.accrualState = state;
  if (!force && !state.schedules.length) return;
  requireAccrualOwner(userId);
  const rows: Snapshot[] = await m.query(
    `SELECT t.id,t.account_id AS "accountId",TO_CHAR(t.transaction_date,'YYYY-MM-DD') AS "transactionDate",
      t.amount::text AS amount,t.currency_code AS "currencyCode",t.exchange_rate::text AS "exchangeRate",
      t.original_amount::text AS "originalAmount",t.original_currency_code AS "originalCurrencyCode",
      t.payee_id AS "payeeId",t.payee_name AS "payeeName",t.category_id AS "categoryId",
      t.description,t.reference_number AS "referenceNumber",t.status,t.is_split AS "isSplit",
      t.is_transfer AS "isTransfer",t.linked_transaction_id AS "linkedTransactionId",
      t.parent_transaction_id AS "parentTransactionId",t.reconciled_date AS "reconciledDate",
      t.created_at AS "createdAt",ARRAY(SELECT tt.tag_id FROM transaction_tags tt WHERE tt.transaction_id=t.id ORDER BY tt.tag_id) AS "tagIds"
     FROM transactions t WHERE t.id=$1 AND t.user_id=$2`,
    [transactionId, userId],
  );
  if (!rows[0]) throw accrualErrors.conflict();
  const splits = await m.query(
    `SELECT s.id,s.kind,s.category_id AS "categoryId",s.transfer_account_id AS "transferAccountId",
      s.linked_transaction_id AS "linkedTransactionId",s.amount::text AS amount,s.memo,
      ARRAY(SELECT st.tag_id FROM transaction_split_tags st WHERE st.transaction_split_id=s.id ORDER BY st.tag_id) AS "tagIds"
     FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
     WHERE t.id=$1 AND t.user_id=$2 ORDER BY s.id`,
    [transactionId, userId],
  );
  Object.assign(snapshot, rows[0], { splits, accrualExact: true });
}

/** Existing transfer/investment history lacks a full structural restore contract. */
export function assertAccrualStructureRestorable(snapshot: Snapshot): void {
  const state =
    snapshot.accrualState === undefined
      ? undefined
      : stateFrom(snapshot.accrualState, String(snapshot.id));
  if (
    (snapshot.accrualExact || state?.schedules.length) &&
    Array.isArray(snapshot.splits) &&
    snapshot.splits.some(
      (line: Snapshot) =>
        (line.kind !== undefined && line.kind !== "category") ||
        line.linkedTransactionId,
    )
  )
    throw accrualErrors.conflict();
}

export async function restoreAccrualHistoryState(
  m: EntityManager,
  userId: string,
  transactionId: string,
  value: unknown,
): Promise<void> {
  if (value === undefined) return;
  const target = stateFrom(value, transactionId);
  const current = await readAccrualHistoryState(m, userId, transactionId);
  if (target.schedules.length || current.schedules.length)
    requireAccrualOwner(userId);
  const wanted = new Set(target.schedules.map((row) => row.sourceSplitId));
  for (const row of current.schedules) {
    if (!wanted.has(row.sourceSplitId))
      await m.delete(AccrualSchedule, { id: row.id, userId });
  }
  for (const row of target.schedules) {
    const source = await loadAccrualSource(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
      false,
      false,
    );
    if (!source.kindEligible) throw accrualErrors.ineligible();
    if (source.snapshot.currencyCode !== row.currencyCode)
      throw accrualErrors.conflict();
    const family = source.family ?? row.family;
    const period = periodOf(row);
    const plan = buildAccrualPlan(
      source.snapshot.paymentDate,
      source.snapshot.amount,
      source.snapshot.currencyDecimals,
      period,
    );
    const fingerprint = accrualContentFingerprint(
      source.snapshot,
      family,
      period,
      plan,
    );
    const existing = await findAccrual(
      m,
      userId,
      transactionId,
      row.sourceSplitId,
    );
    if (
      existing?.sourceFingerprint === fingerprint &&
      existing.preset === row.preset &&
      existing.startMonth === plan.startMonth &&
      existing.monthCount === plan.monthCount
    )
      continue;
    // Recreated schedules receive fresh IDs: an old preview cannot become valid again.
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
  }
}

export async function restoreAccrualSplitTags(
  m: EntityManager,
  userId: string,
  transactionId: string,
  snapshot: Snapshot,
  requireAccrualSnapshot = true,
): Promise<void> {
  if (
    (requireAccrualSnapshot && !snapshot.accrualState) ||
    !Array.isArray(snapshot.splits)
  )
    return;
  for (const line of snapshot.splits as Snapshot[]) {
    if (!Array.isArray(line.tagIds) || !line.tagIds.length) continue;
    if (
      typeof line.id !== "string" ||
      !isUUID(line.id) ||
      line.tagIds.some((id) => typeof id !== "string" || !isUUID(id))
    )
      throw accrualErrors.conflict();
    const ids = [...new Set(line.tagIds)] as string[];
    const owned: { id: string }[] = await m.query(
      "SELECT id FROM tags WHERE user_id=$1 AND id=ANY($2)",
      [userId, ids],
    );
    if (owned.length !== ids.length) throw accrualErrors.conflict();
    await m.query(
      `INSERT INTO transaction_split_tags(transaction_split_id,tag_id)
       SELECT s.id,tag.id FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
       CROSS JOIN tags tag WHERE t.id=$1 AND t.user_id=$2 AND s.id=$3 AND tag.user_id=$2 AND tag.id=ANY($4)
       ON CONFLICT DO NOTHING`,
      [transactionId, userId, line.id, ids],
    );
  }
}
