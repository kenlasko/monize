import {
  beginTaxonomyOperation,
  recordTaxonomyOperation,
} from "../accruals/accrual-taxonomy-operation";
import { createHash } from "node:crypto";
import { In, type EntityManager } from "typeorm";
import { Payee } from "./entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { lockPayeeCategoryBatch } from "./payee-category-batch";
import {
  resolveBulkAccrualEdit,
  verifyBulkAccrualEdit,
} from "../accruals/accrual-bulk-edit";
import { canonical } from "../accruals/accrual-source-edit";
import { requireAccrualOwner } from "../accruals/accrual-source";
import { accrualErrors } from "../accruals/accrual-errors";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";

export async function preparePayeeRemoval(
  m: EntityManager,
  userId: string,
  id: string,
) {
  const locked = await lockPayeeCategoryBatch(m, userId, [id], []);
  if (locked.payees.length !== 1) throw accrualErrors.missing();
  const payee = await m.getRepository(Payee).findOne({ where: { id, userId } });
  if (!payee) throw accrualErrors.missing();
  const ids = locked.sources.map((row) => row.id);
  const rows: { id: string; isSplit: boolean; status: string }[] = ids.length
    ? await m.query(
        'SELECT id,is_split AS "isSplit",status FROM transactions WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [userId, ids],
      )
    : [];
  await assertReconciledRowsMutable(m, userId, rows);
  // The locked payee blocks new referencing inserts; freeze existing scheduled references as well.
  const scheduled: { id: string; snapshot: string }[] = await m.query(
    "SELECT id,to_jsonb(st)::text AS snapshot FROM scheduled_transactions st WHERE user_id=$1 AND payee_id=$2 ORDER BY id FOR UPDATE",
    [userId, id],
  );
  const preview = await resolveBulkAccrualEdit(
    m,
    userId,
    ids,
    new Set(rows.filter((row) => row.isSplit).map((row) => row.id)),
    { mode: "ids", transactionIds: ids, payeeId: null },
    undefined,
  );
  if (preview.impacts.length) requireAccrualOwner(userId);
  if (preview.fingerprint)
    preview.fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            version: "payee-removal-v1",
            userId,
            id,
            payees: locked.payees,
            sources: locked.snapshots,
            scheduled,
            accrual: preview.fingerprint,
          }),
        ),
      )
      .digest("hex");
  return { payee, ids, scheduled, preview };
}

export async function removePayeeWithAccruals(
  m: EntityManager,
  userId: string,
  id: string,
  expected?: string,
) {
  const history = await beginTaxonomyOperation(m, userId, "payee", [id]);
  const edit = await preparePayeeRemoval(m, userId, id);
  verifyBulkAccrualEdit(edit.preview, expected);
  if (edit.ids.length)
    await m.update(
      Transaction,
      { userId, payeeId: id, id: In(edit.ids) },
      { payeeId: null },
    );
  if (edit.scheduled.length)
    await m.update(
      ScheduledTransaction,
      { userId, payeeId: id, id: In(edit.scheduled.map((row) => row.id)) },
      { payeeId: null },
    );
  // TypeORM remove clears the entity's primary key; keep the locked history snapshot.
  const before = { ...edit.payee };
  await m.getRepository(Payee).remove(edit.payee);
  for (const impact of edit.preview.impacts)
    await refreshSourceAccruals(m, userId, impact.transactionId);
  await recordTaxonomyOperation(m, userId, history);
  return { ...before, relationshipRecorded: !!history };
}
