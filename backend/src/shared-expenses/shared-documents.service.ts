import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import {
  AttachmentsService,
  UploadedAttachmentFile,
  sanitizeFilename,
} from "../attachments/attachments.service";
import {
  AttachmentParent,
  DocumentKind,
} from "../attachments/attachment-parent";
import {
  authorizedAttachment,
  authorizeSharedAttachmentParent,
  recordSharedDocumentActivity,
} from "../attachments/shared-attachment-access";
import { requireRevision, requireSharedGroup } from "./shared-db";
import { sharedError } from "./shared-errors";
import {
  attachmentOriginalSql,
  isPrimaryAttachment,
  PRIMARY_ATTACHMENT_SQL,
  primaryAttachmentSql,
} from "../attachments/primary-attachment.util";
import {
  PublishSharedDocumentDto,
  SharedDocumentUploadDto,
  UpdateSharedDocumentDto,
} from "./dto/shared-document.dto";

export interface SharedDocument {
  uploaderName: string | null;
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  documentKind: DocumentKind;
  documentRevision: number;
  sharedGroupId: string | null;
  sharedEntryId: string | null;
  entryTitle: string | null;
  originalAttachmentId: string | null;
  createdAt: string;
  canEdit: boolean;
}

@Injectable()
export class SharedDocumentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly attachments: AttachmentsService,
  ) {}

  async list(
    userId: string,
    groupId: string,
    offset = 0,
    entryId?: string,
    directOnly = false,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      const group = await requireSharedGroup(manager, userId, groupId);
      const rows: (Omit<SharedDocument, "byteSize"> & { byteSize: string })[] =
        await manager.query(
          `SELECT a.id, a.filename, a.content_type AS "contentType", a.byte_size AS "byteSize", a.document_kind AS "documentKind", a.document_revision AS "documentRevision",
        a.shared_group_id AS "sharedGroupId", a.shared_entry_id AS "sharedEntryId", e.title AS "entryTitle", o.id AS "originalAttachmentId", a.created_at AS "createdAt",
        ($4::boolean AND (a.user_id = $2 OR $5::boolean)) AS "canEdit",
        (SELECT activity.actor_name FROM shared_activity activity
         WHERE activity.group_id = $1 AND activity.action = 'DOCUMENT_ADDED' AND activity.detail->>'documentId' = a.id::text
         ORDER BY activity.created_at, activity.id LIMIT 1) AS "uploaderName"
        FROM transaction_attachments a LEFT JOIN shared_entries e ON e.id = a.shared_entry_id
        LEFT JOIN transaction_attachments o ON ${attachmentOriginalSql("a.id", "o")}
        WHERE (a.shared_group_id = $1 OR e.group_id = $1) AND ${primaryAttachmentSql("a")}
          AND ($6::uuid IS NULL OR a.shared_entry_id = $6) AND (NOT $7::boolean OR a.shared_group_id = $1)
        ORDER BY a.created_at DESC, a.id DESC OFFSET $3 LIMIT 101`,
          [
            groupId,
            userId,
            offset,
            group.role !== "VIEWER" && !group.archivedAt,
            group.role === "OWNER",
            entryId ?? null,
            directOnly,
          ],
        );
      return {
        items: rows
          .slice(0, 100)
          .map((row) => ({ ...row, byteSize: Number(row.byteSize) })),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    });
  }

  async upload(
    userId: string,
    groupId: string,
    entryId: string | undefined,
    dto: SharedDocumentUploadDto,
    file?: UploadedAttachmentFile,
    original?: UploadedAttachmentFile,
  ) {
    const parent = await this.destination(userId, groupId, entryId);
    const saved = await this.attachments.create(
      userId,
      parent,
      file,
      original,
      dto.documentKind,
      dto.operationId,
    );
    const list = await this.list(userId, groupId, 0, entryId, !entryId);
    return list.items.find((row) => row.id === saved.id)!;
  }

  async publish(
    userId: string,
    groupId: string,
    dto: PublishSharedDocumentDto,
  ) {
    await this.destination(userId, groupId, dto.entryId);
    const source = await withScopedDb(this.dataSource, async (manager) => {
      const attachment = await authorizedAttachment(
        manager,
        userId,
        dto.sourceAttachmentId,
      );
      if (
        attachment.userId !== userId ||
        attachment.sharedGroupId ||
        attachment.sharedEntryId ||
        !isPrimaryAttachment(attachment)
      )
        sharedError("readOnly");
      const originals: { id: string }[] = dto.includeOriginal
        ? await manager.query(
            `SELECT id FROM transaction_attachments WHERE ${attachmentOriginalSql("$1")} AND user_id = $2`,
            [attachment.id, userId],
          )
        : [];
      return { kind: attachment.documentKind, originalId: originals[0]?.id };
    });
    const file = await this.attachments.getForDownload(
      userId,
      dto.sourceAttachmentId,
    );
    const original = source.originalId
      ? await this.attachments.getForDownload(userId, source.originalId)
      : null;
    // New IDs and storage keys, through the same intent/tombstone lifecycle.
    return this.upload(
      userId,
      groupId,
      dto.entryId,
      {
        operationId: dto.operationId,
        documentKind: dto.documentKind ?? source.kind,
      },
      { originalname: file.filename, buffer: file.data, size: file.byteSize },
      original
        ? {
            originalname: original.filename,
            buffer: original.data,
            size: original.byteSize,
          }
        : undefined,
    );
  }

  async update(
    userId: string,
    groupId: string,
    id: string,
    dto: UpdateSharedDocumentDto,
  ) {
    await withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId, "WRITE");
      const row = await authorizedAttachment(manager, userId, id, true);
      const entries: { group_id: string }[] = row.sharedEntryId
        ? await manager.query(
            "SELECT group_id FROM shared_entries WHERE id = $1",
            [row.sharedEntryId],
          )
        : [];
      if (
        (row.sharedGroupId ?? entries[0]?.group_id) !== groupId ||
        !isPrimaryAttachment(row)
      )
        sharedError("notFound");
      requireRevision(row.documentRevision, dto.expectedRevision);
      const entryId =
        dto.entryId === undefined ? row.sharedEntryId : dto.entryId;
      const parent: AttachmentParent = entryId
        ? { kind: "shared-entry", id: entryId }
        : { kind: "shared-group", id: groupId };
      if (dto.entryId !== undefined && dto.entryId !== row.sharedEntryId) {
        const destinationGroup = await authorizeSharedAttachmentParent(
          manager,
          userId,
          parent,
          true,
        );
        if (destinationGroup !== groupId) sharedError("notFound");
        const [{ count }]: { count: number }[] = await manager.query(
          `SELECT count(*)::int AS count FROM transaction_attachments WHERE ${PRIMARY_ATTACHMENT_SQL} AND id <> $1
           AND (($2::uuid IS NOT NULL AND shared_entry_id = $2) OR ($2::uuid IS NULL AND shared_group_id = $3))`,
          [id, entryId, groupId],
        );
        if (count >= (entryId ? 10 : 50)) sharedError("documentLimit");
      }
      const filename = sanitizeFilename(dto.filename);
      const changed = returnedRows<{ id: string }>(
        await manager.query(
          "UPDATE transaction_attachments SET filename = $3, document_kind = $4, shared_group_id = $5, shared_entry_id = $6, document_revision = document_revision + 1 WHERE id = $1 AND document_revision = $2 RETURNING id",
          [
            id,
            dto.expectedRevision,
            filename,
            dto.documentKind,
            entryId ? null : groupId,
            entryId,
          ],
        ),
      );
      if (!changed.length) sharedError("stale");
      await manager.query(
        `UPDATE transaction_attachments SET document_kind = $2, shared_group_id = $3, shared_entry_id = $4, document_revision = document_revision + 1 WHERE ${attachmentOriginalSql("$1")}`,
        [id, dto.documentKind, entryId ? null : groupId, entryId],
      );
      await recordSharedDocumentActivity(
        manager,
        userId,
        parent,
        "DOCUMENT_UPDATED",
        { id, filename },
      );
    });
    return { id, documentRevision: dto.expectedRevision + 1 };
  }

  private async destination(
    userId: string,
    groupId: string,
    entryId?: string,
  ): Promise<AttachmentParent> {
    return withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId, "WRITE");
      if (entryId) {
        const rows: { id: string }[] = await manager.query(
          "SELECT id FROM shared_entries WHERE id = $1 AND group_id = $2",
          [entryId, groupId],
        );
        if (!rows[0]) sharedError("notFound");
      }
      return entryId
        ? { kind: "shared-entry", id: entryId }
        : { kind: "shared-group", id: groupId };
    });
  }
}
