import { BadRequestException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { AttachmentsService } from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { authorizedAttachment } from "./shared-attachment-access";
import {
  attachmentOriginalSql,
  isPrimaryAttachment,
} from "./primary-attachment.util";
import type { CopyAttachmentToWarrantyDto } from "./dto/copy-attachment-to-warranty.dto";
import type { UploadedAttachmentFile } from "./attachment-upload";

/**
 * Puts a file the reader already uploaded on a warranty as well.
 *
 * An attachment has exactly one parent (WTY-003, `chk_attachment_one_parent`),
 * so "associating" an existing file is a copy: new ids and storage keys,
 * written through `AttachmentsService.create`, and so through its upload
 * intent, its parent lock and its per-warranty cap. The source is left where
 * it was. A scan pair travels as a pair, so the copy keeps its original.
 *
 * The source must be one of the reader's own private documents. A shared
 * group's file belongs to the group, and copying it out is the group's own
 * export, not this.
 */
@Injectable()
export class WarrantyAttachmentCopyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly attachments: AttachmentsService,
  ) {}

  async copyToWarranty(
    userId: string,
    warrantyId: string,
    dto: CopyAttachmentToWarrantyDto,
  ): Promise<TransactionAttachment> {
    const source = await withScopedDb(this.dataSource, async (manager) => {
      // Not found for anything that is not the reader's: an id from another
      // user reads as absent, never as forbidden.
      const row = await authorizedAttachment(
        manager,
        userId,
        dto.sourceAttachmentId,
      );
      if (
        row.userId !== userId ||
        row.sharedGroupId ||
        row.sharedEntryId ||
        !isPrimaryAttachment(row)
      ) {
        throw new BadRequestException(
          tr(
            "errors.attachments.copyNotOwnDocument",
            "Only one of your own documents can be added to a warranty",
          ),
        );
      }
      if (row.warrantyId === warrantyId) {
        throw new BadRequestException(
          tr(
            "errors.attachments.copyAlreadyOnWarranty",
            "This document is already on this warranty",
          ),
        );
      }
      const originals: { id: string }[] = await manager.query(
        `SELECT id FROM transaction_attachments WHERE ${attachmentOriginalSql("$1")} AND user_id = $2`,
        [row.id, userId],
      );
      return { kind: row.documentKind, originalId: originals[0]?.id };
    });

    const file = await this.attachments.getForDownload(
      userId,
      dto.sourceAttachmentId,
    );
    const original = source.originalId
      ? await this.attachments.getForDownload(userId, source.originalId)
      : null;
    const asUpload = (download: {
      filename: string;
      data: Buffer;
      byteSize: number;
    }): UploadedAttachmentFile => ({
      originalname: download.filename,
      buffer: download.data,
      size: download.byteSize,
    });

    return this.attachments.create(
      userId,
      { kind: "warranty", id: warrantyId },
      asUpload(file),
      original ? asUpload(original) : undefined,
      dto.documentKind ?? source.kind,
      dto.operationId,
    );
  }
}
