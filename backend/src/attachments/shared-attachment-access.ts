import { NotFoundException } from "@nestjs/common";
import { EntityManager, IsNull, Not } from "typeorm";
import { tr } from "../i18n/translate";
import {
  lockSharedGroup,
  requireSharedGroup,
  sharedActivity,
} from "../shared-expenses/shared-db";
import { sharedError } from "../shared-expenses/shared-errors";
import { AttachmentParent } from "./attachment-parent";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";

export function isSharedAttachmentParent(parent: AttachmentParent): boolean {
  return parent.kind === "shared-group" || parent.kind === "shared-entry";
}

export async function authorizeSharedAttachmentParent(
  manager: EntityManager,
  userId: string,
  parent: AttachmentParent,
  write: boolean,
): Promise<string> {
  let groupId = parent.id;
  let authorId: string | null = null;
  if (parent.kind === "shared-entry") {
    const entries: { group_id: string; created_by_user_id: string | null }[] =
      await manager.query(
        "SELECT group_id, created_by_user_id FROM shared_entries WHERE id = $1",
        [parent.id],
      );
    if (!entries[0]) sharedError("notFound");
    groupId = entries[0].group_id;
    authorId = entries[0].created_by_user_id;
  }
  if (write) await lockSharedGroup(manager, groupId);
  const group = await requireSharedGroup(
    manager,
    userId,
    groupId,
    write ? "WRITE" : "READ",
  );
  if (
    write &&
    parent.kind === "shared-entry" &&
    group.role !== "OWNER" &&
    authorId !== userId
  )
    sharedError("readOnly");
  return groupId;
}

/** Shared bytes require current membership even if the reader originally uploaded them. */
export async function authorizedAttachment(
  manager: EntityManager,
  userId: string,
  id: string,
  write = false,
): Promise<TransactionAttachment> {
  const row = await manager.getRepository(TransactionAttachment).findOne({
    where: [
      { id, userId },
      { id, sharedGroupId: Not(IsNull()) },
      { id, sharedEntryId: Not(IsNull()) },
    ],
  });
  if (!row)
    throw new NotFoundException(
      tr("errors.attachments.notFound", "Attachment not found"),
    );
  if (row.sharedGroupId || row.sharedEntryId) {
    const parent: AttachmentParent = row.sharedGroupId
      ? { kind: "shared-group", id: row.sharedGroupId }
      : { kind: "shared-entry", id: row.sharedEntryId! };
    const groupId = await authorizeSharedAttachmentParent(
      manager,
      userId,
      parent,
      false,
    );
    if (write) {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      if (row.userId !== userId && group.role !== "OWNER")
        sharedError("readOnly");
    }
  }
  return row;
}

export async function recordSharedDocumentActivity(
  manager: EntityManager,
  userId: string,
  parent: AttachmentParent,
  action: string,
  document: { id: string; filename: string },
): Promise<void> {
  if (!isSharedAttachmentParent(parent)) return;
  const groupId = await authorizeSharedAttachmentParent(
    manager,
    userId,
    parent,
    false,
  );
  await sharedActivity(
    manager,
    userId,
    groupId,
    action,
    { documentId: document.id, filename: document.filename },
    parent.kind === "shared-entry" ? parent.id : undefined,
  );
}
