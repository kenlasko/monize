import { EntityManager } from "typeorm";
import { lockSharedGroup } from "./shared-db";
import { sharedError } from "./shared-errors";

/** Erasing one's ledger removes its bridge, while the collaborators' journal survives. */
export async function detachSharedLedgerForErasure(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  const groups: { group_id: string }[] = await manager.query(
    "SELECT group_id FROM shared_integrations WHERE user_id = $1 ORDER BY group_id",
    [userId],
  );
  for (const { group_id } of groups) await lockSharedGroup(manager, group_id);
  const postings: { id: string }[] = await manager.query(
    "SELECT id FROM shared_postings WHERE user_id = $1 ORDER BY id FOR UPDATE",
    [userId],
  );
  for (const { id } of postings) {
    await manager.query(
      "SELECT set_config('app.shared_posting_id', $1, true)",
      [id],
    );
    await manager.query(
      "DELETE FROM shared_ledger_links WHERE user_id = $1 AND posting_id = $2",
      [userId, id],
    );
    await manager.query(
      "UPDATE transactions SET shared_expense_posting_id = NULL WHERE user_id = $1 AND shared_expense_posting_id = $2",
      [userId, id],
    );
  }
  await manager.query("SELECT set_config('app.shared_posting_id', '', true)");
  await manager.query("DELETE FROM shared_postings WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM shared_integrations WHERE user_id = $1", [
    userId,
  ]);
  for (const { group_id } of groups) {
    await manager.query("SELECT set_config('app.shared_group_id', $1, true)", [
      group_id,
    ]);
    await manager.query(
      "UPDATE accounts SET managed_purpose = NULL, shared_expense_group_id = NULL WHERE user_id = $1 AND shared_expense_group_id = $2",
      [userId, group_id],
    );
  }
  await manager.query("SELECT set_config('app.shared_group_id', '', true)");
}

/** Admin erasure already has system identity; no new cross-user context is opened. */
export async function assertSharedOwnershipTransferred(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  const groups: { id: string }[] = await manager.query(
    "SELECT id FROM shared_groups WHERE owner_user_id = $1 ORDER BY id",
    [userId],
  );
  for (const { id } of groups) await lockSharedGroup(manager, id);
  const shared: { id: string }[] = await manager.query(
    `SELECT g.id FROM shared_groups g WHERE g.owner_user_id = $1
    AND (EXISTS (SELECT 1 FROM shared_memberships m WHERE m.group_id = g.id AND m.user_id <> $1 AND m.revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM shared_integrations i WHERE i.group_id = g.id AND i.user_id <> $1)) LIMIT 1`,
    [userId],
  );
  if (shared.length) sharedError("transferBeforeErasure");
}

export async function eraseSharedUser(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await assertSharedOwnershipTransferred(manager, userId);
  await detachSharedLedgerForErasure(manager, userId);
  // A published copy belongs to the group: preserve its bytes and metadata,
  // replacing the departing uploader with the group's remaining owner.
  await manager.query(
    `UPDATE transaction_attachments a SET user_id = g.owner_user_id,
    upload_request_id = NULL, upload_fingerprint = NULL
    FROM shared_groups g WHERE a.user_id = $1 AND g.owner_user_id <> $1
      AND g.id = shared_document_group(a.shared_group_id, a.shared_entry_id)`,
    [userId],
  );
  await manager.query(
    "DELETE FROM shared_invitations WHERE consumed_by_user_id = $1",
    [userId],
  );
  await manager.query("DELETE FROM shared_memberships WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM shared_groups WHERE owner_user_id = $1", [
    userId,
  ]);
}
