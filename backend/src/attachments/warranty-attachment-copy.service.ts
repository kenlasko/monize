import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { AttachmentsService } from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { authorizedAttachment } from "./shared-attachment-access";
import {
  attachmentOriginalSql,
  isPrimaryAttachment,
  PRIMARY_ATTACHMENT_SQL,
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
    // Checked first so a refused copy reads no bytes, then again inside the
    // write's transaction under the warranty's lock, which is the check that
    // decides: the source can change while its bytes are read.
    const source = await withScopedDb(this.dataSource, (manager) =>
      this.checkSource(manager, userId, warrantyId, dto.sourceAttachmentId),
    );

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
      async (manager) => {
        const current = await this.checkSource(
          manager,
          userId,
          warrantyId,
          dto.sourceAttachmentId,
        );
        if (current.sha256 !== source.sha256) {
          throw new ConflictException(
            tr(
              "errors.attachments.copySourceChanged",
              "The document changed while it was being added. Please try again.",
            ),
          );
        }
      },
    );
  }

  /**
   * Refuses anything but one of the reader's own private documents, and one
   * this warranty already holds: by its own row, or by the same file already
   * copied here (a copy is a new row, so only the content says it is the same).
   */
  private async checkSource(
    manager: EntityManager,
    userId: string,
    warrantyId: string,
    sourceAttachmentId: string,
  ): Promise<{
    kind: TransactionAttachment["documentKind"];
    sha256: string;
    originalId: string | undefined;
  }> {
    // Not found for anything that is not the reader's: an id from another
    // user reads as absent, never as forbidden.
    const row = await authorizedAttachment(manager, userId, sourceAttachmentId);
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
    const sameFile: { id: string }[] = await manager.query(
      `SELECT id FROM transaction_attachments
        WHERE warranty_id = $1 AND user_id = $2 AND sha256 = $3
          AND ${PRIMARY_ATTACHMENT_SQL}
        LIMIT 1`,
      [warrantyId, userId, row.sha256],
    );
    if (row.warrantyId === warrantyId || sameFile.length > 0) {
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
    return {
      kind: row.documentKind,
      sha256: row.sha256,
      originalId: originals[0]?.id,
    };
  }
}
