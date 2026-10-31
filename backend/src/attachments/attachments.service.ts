import { tokenHashesEqual } from "../auth/crypto.util";
import {
  validateAttachmentUpload,
  UploadedAttachmentFile,
  ValidatedUpload,
} from "./attachment-upload";
export {
  MAX_ATTACHMENT_BYTES,
  sanitizeFilename,
  UploadedAttachmentFile,
} from "./attachment-upload";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { getRequestContext } from "../common/request-context";
import { lockTransactionRow, lockWarrantyRow } from "../common/db/locks";
import { returnedRows } from "../common/db/query-result";
import { AttachmentOrphanSweeper } from "./attachment-orphan-sweeper.service";
import { tr } from "../i18n/translate";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { AttachmentStorageProvider } from "./storage/attachment-storage.interface";
import { AttachmentStorageRegistry } from "./storage/attachment-storage.registry";
import {
  clearObjectIntent,
  dropCommittedObjectIntent,
  recordObjectIntent,
} from "./storage/object-intent";
import {
  primaryAttachmentSql,
  primaryAttachmentWhere,
} from "./primary-attachment.util";
import {
  AttachmentParent,
  attachmentParentColumns,
  attachmentParentWhere,
  DEFAULT_DOCUMENT_KIND,
  DocumentKind,
  parentColumn,
  reachedTransactionIdSql,
  reachingWarrantyJoinSql,
} from "./attachment-parent";
import { Warranty } from "../warranties/entities/warranty.entity";
import { AttachmentListItemDto } from "./dto/attachment-list-item.dto";
import {
  authorizedAttachment,
  authorizeSharedAttachmentParent,
  isSharedAttachmentParent,
  recordSharedDocumentActivity,
} from "./shared-attachment-access";

/**
 * Maximum visible attachments per parent. Named for the transaction it was
 * written for; a warranty takes the same cap under the same lock doctrine.
 */
export const MAX_ATTACHMENTS_PER_TRANSACTION = 10;
export const MAX_SHARED_GROUP_ATTACHMENTS = 50;

/**
 * Who is downloading, beyond the user id. `isDelegate` is the request's
 * `isActing`: the global guard has already admitted the delegate to the route
 * through the `warranties` section, and the service adds the one fact the
 * guard cannot see, which parent the row hangs off.
 */
export interface AttachmentReader {
  isDelegate?: boolean;
}

export interface AttachmentDownload {
  data: Buffer;
  contentType: string;
  filename: string;
  byteSize: number;
}

/**
 * A listed attachment: the visible row, plus the id of the original photo it
 * was scanned from when there is one (`null` means there is no original --
 * an ordinary upload, or a scan whose original the user chose not to keep)
 * and the name of the warranty a document hangs off (`null` on a
 * transaction's own rows). The Swagger class is the one definition.
 */
export type AttachmentListItem = AttachmentListItemDto;

/** The raw columns the list read selects beside each entity row. */
interface ListRawRow {
  orig_id: string | null;
  warranty_name: string | null;
}

/**
 * What one user's attachments occupy: how many files, and their combined size.
 *
 * Both figures are complete by construction -- they are a `COUNT` and a `SUM`
 * over metadata rows the same transaction read, not a partial enumeration of an
 * object store -- so neither is nullable and an account with no attachments is
 * a truthful `{ files: 0, bytes: 0 }`.
 */
export interface AttachmentStorageUsage {
  readonly files: number;
  readonly bytes: number;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: AttachmentStorageRegistry,
    private readonly orphanSweeper: AttachmentOrphanSweeper,
  ) {}

  /**
   * Where bytes this request writes go: the backend `ATTACHMENT_STORAGE_PROVIDER`
   * selected. Read from the registry rather than injected beside it so there is
   * one answer to "which provider is active" in this class -- and so the reads
   * below, which resolve a provider per row instead, are visibly the other case.
   */
  private get storage(): AttachmentStorageProvider {
    return this.registry.active;
  }

  /**
   * Store an uploaded file against its parent, a transaction or a warranty
   * (`AttachmentParent`, WTY-003). Validates size, sniffs the real MIME type
   * (never trusting the client), enforces the per-parent cap, and writes
   * metadata + bytes together. `documentKind` is what a warranty's document
   * is; a transaction's attachments take the default.
   *
   * "Together" means different things per provider, and the difference matters:
   * the database provider's blob write joins this transaction and genuinely
   * commits or rolls back with the metadata row, while a local filesystem write
   * or an S3 put cannot. For those, a commit failure after the object is written
   * leaves bytes nothing references.
   *
   * The catch below deletes them, but a catch is not a guarantee: it runs only if
   * this process is still alive. Killed between the put and the commit, the bytes
   * survived with no metadata row -- and therefore no tombstone, so the orphan
   * sweep could not find them either. Undiscoverable is the part that matters:
   * unreferenced bytes nobody can enumerate accumulate forever and no operator
   * can tell they are there (audit FV4-003).
   *
   * So an **upload intent** is committed before a single byte is written: a
   * tombstone for the key this upload is about to use, in its own transaction, so
   * it is durable independently of what happens next. Success deletes it *inside*
   * the metadata transaction, which is what makes the pair atomic -- a commit
   * drops the intent with the row that now owns the bytes, and a rollback keeps
   * it, so the sweeper finds the object whether this process survives or not.
   *
   * That delete is also a **fence**. The intent and the deletion record are the
   * same row shape, and the sweeper cannot tell them apart by age -- nothing bounds
   * an upload to any window, so a stalled put or commit outlives one and the sweep
   * deletes bytes this transaction is about to reference. So the sweeper claims the
   * row before deleting the object, and the clear requires the claim to be absent:
   * one of the two loses, and it is never the case that metadata commits pointing
   * at bytes that are gone (audit RV4-002).
   *
   * The fence settles what *metadata* may commit. It cannot settle what bytes
   * exist, because a put that stalled past its lease can land *after* the sweep
   * deleted the key -- and if this process is then killed before the `catch` below,
   * those bytes are unreferenced with no row left to enumerate them. That is why the
   * sweeper keeps a claimed upload intent for `LATE_WRITE_QUARANTINE_MS` instead of
   * dropping the row with the object: the record outlives the writer, so the next
   * pass deletes the late object and only then retires the row (audit RRV4-002).
   */
  async create(
    userId: string,
    parent: AttachmentParent,
    file: UploadedAttachmentFile | undefined,
    original?: UploadedAttachmentFile | undefined,
    documentKind: DocumentKind = DEFAULT_DOCUMENT_KIND,
    operationId?: string,
  ): Promise<TransactionAttachment> {
    // A kind names a warranty's document; a transaction's attachment has none
    // to name, so anything but the default is a malformed request.
    if (
      parent.kind === "transaction" &&
      documentKind !== DEFAULT_DOCUMENT_KIND
    ) {
      throw new BadRequestException(
        tr(
          "errors.attachments.documentKindNotForTransaction",
          "A document kind applies only to a warranty's documents",
        ),
      );
    }
    const primary = validateAttachmentUpload(file);

    // A scan pair: the enhanced image the user sees, plus the photo it came
    // from. Both halves are images by construction, so an `original` beside a
    // PDF is a malformed request rather than a shape to store.
    const originalUpload = original ? validateAttachmentUpload(original) : null;
    const uploadFingerprint = operationId
      ? createHash("sha256")
          .update(
            JSON.stringify({
              primary: primary.sha256,
              filename: primary.filename,
              original: originalUpload?.sha256 ?? null,
              originalFilename: originalUpload?.filename ?? null,
              documentKind,
              parent,
            }),
          )
          .digest("hex")
      : null;
    if (
      originalUpload &&
      (!primary.contentType.startsWith("image/") ||
        !originalUpload.contentType.startsWith("image/"))
    ) {
      throw new UnsupportedMediaTypeException(
        tr(
          "errors.attachments.pairRequiresImages",
          "A scanned document and its original must both be images",
        ),
      );
    }

    const id = randomUUID();
    const originalId = originalUpload ? randomUUID() : null;

    // Committed before the put, on its own connection: an intent that shares the
    // metadata transaction would roll back with it and record nothing, which is
    // the whole failure being fixed here. One per object -- the pair writes two,
    // so a rollback between them still leaves the sweeper both keys.
    await this.recordUploadIntent(userId, id);
    if (originalId) await this.recordUploadIntent(userId, originalId);

    // Which keys hold bytes an external provider will not roll back. A set
    // rather than a boolean: the pair can fail with one object written and the
    // other not, and the compensation has to know which.
    const objectsWritten = new Set<string>();
    try {
      return await withScopedDb(this.dataSource, async (m) => {
        // Lock the parent row before counting. The cap is a refusal, and a
        // count taken without the lock is a check-then-act: at 9 attachments
        // two uploads both counted 9, both passed `< 10`, and the transaction
        // ended with 11 (audit P4-017). Every uploader now queues behind the
        // same row, so the count each one sees includes its predecessor. Both
        // locks are owner-scoped, so a parent that is not the caller's reads
        // as absent whatever the RLS mode.
        await this.lockParent(m, parent, userId);

        if (operationId) {
          const prior = await m
            .getRepository(TransactionAttachment)
            .findOne({ where: { userId, uploadRequestId: operationId } });
          if (prior) {
            if (!tokenHashesEqual(prior.uploadFingerprint, uploadFingerprint))
              throw new ConflictException(
                tr(
                  "errors.attachments.uploadRequestChanged",
                  "This upload request was already used for another file. Start a new upload.",
                ),
              );
            await this.clearUploadIntent(m, id);
            if (originalId) await this.clearUploadIntent(m, originalId);
            return prior;
          }
        }

        // Primaries only: a scan pair is one attachment as far as the cap is
        // concerned, so its hidden original must not consume a slot the user
        // cannot see or free.
        const existing = await m.getRepository(TransactionAttachment).count({
          where: {
            ...attachmentParentWhere(parent),
            ...(isSharedAttachmentParent(parent) ? {} : { userId }),
            ...primaryAttachmentWhere,
          },
        });
        if (
          existing >=
          (parent.kind === "shared-group"
            ? MAX_SHARED_GROUP_ATTACHMENTS
            : MAX_ATTACHMENTS_PER_TRANSACTION)
        ) {
          throw new BadRequestException(this.tooManyMessage(parent));
        }

        const repo = m.getRepository(TransactionAttachment);
        const saveOne = async (
          rowId: string,
          upload: ValidatedUpload,
          originalOfAttachmentId: string | null,
        ): Promise<TransactionAttachment> => {
          // Both halves of a scan pair carry the same parent and the same
          // document kind: the pair is one attachment.
          const row = repo.create({
            id: rowId,
            userId,
            ...attachmentParentColumns(parent),
            documentKind,
            filename: upload.filename,
            contentType: upload.contentType,
            byteSize: upload.buffer.length,
            sha256: upload.sha256,
            storageProvider: this.storage.name,
            storageKey: rowId,
            originalOfAttachmentId,
            ...(operationId && originalOfAttachmentId === null
              ? { uploadRequestId: operationId, uploadFingerprint }
              : {}),
          });
          const saved = await repo.save(row);

          // The database provider's nested withScopedDb joins this transaction,
          // so its blob commits with the metadata row. An external provider does
          // not, which is what `objectsWritten` records.
          await this.storage.save(rowId, upload.buffer);
          if (this.storage.name !== "database") objectsWritten.add(rowId);

          // Clearing the intent joins this transaction on purpose: it commits
          // with the metadata row that now owns the bytes, and a rollback after
          // this point keeps the intent, so the sweeper still finds the object.
          await this.clearUploadIntent(m, rowId);
          return saved;
        };

        // The visible row first: the original references it, and the foreign key
        // is immediate.
        const saved = await saveOne(id, primary, null);
        if (originalId && originalUpload) {
          await saveOne(originalId, originalUpload, id);
        }
        await recordSharedDocumentActivity(
          m,
          userId,
          parent,
          "DOCUMENT_ADDED",
          saved,
        );
        return saved;
      });
    } catch (error) {
      // Every key this upload minted, whether or not it got as far as bytes.
      for (const key of originalId ? [id, originalId] : [id]) {
        if (objectsWritten.has(key)) {
          // The transaction rolled back after the object was written, so nothing
          // references those bytes. Remove them now for promptness; the intent
          // committed above is what makes this optional rather than the only
          // chance, so a failure here is a warning and not a leak.
          await this.storage
            .delete(key)
            .then(() => this.clearCommittedUploadIntent(key))
            .catch((cleanupError: unknown) =>
              this.logger.warn(
                `Attachment ${key} rolled back but its stored object could not be ` +
                  `removed; left to the orphan sweep: ` +
                  `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              ),
            );
        } else {
          // Refused before anything was written -- the cap, a missing parent.
          // There are no bytes at this key, so drop the intent rather than
          // leaving the sweeper a no-op delete to discover.
          await this.clearCommittedUploadIntent(key);
        }
      }
      throw error;
    }
  }

  /**
   * Row-lock the parent, or refuse with a not-found that names its kind.
   *
   * The two helpers share one doctrine (`common/db/locks.ts`): an owner-scoped
   * `FOR UPDATE` that returns null for a row that is gone or somebody else's.
   * Choosing between them is the only place the parent's kind is branched on
   * for the write; every other site derives its column from the kind.
   */
  private async lockParent(
    m: EntityManager,
    parent: AttachmentParent,
    userId: string,
  ): Promise<void> {
    if (isSharedAttachmentParent(parent)) {
      await authorizeSharedAttachmentParent(m, userId, parent, true);
      return;
    }
    if (parent.kind === "transaction") {
      const locked = await lockTransactionRow(m, parent.id, userId);
      if (locked) return;
      throw new NotFoundException(
        tr("errors.attachments.transactionNotFound", "Transaction not found"),
      );
    }
    const locked = await lockWarrantyRow(m, parent.id, userId);
    if (locked) return;
    throw new NotFoundException(
      tr("errors.attachments.warrantyNotFound", "Warranty not found"),
    );
  }

  /** The cap refusal, worded for the parent it is about. */
  private tooManyMessage(parent: AttachmentParent): string {
    if (isSharedAttachmentParent(parent)) {
      const max =
        parent.kind === "shared-group"
          ? MAX_SHARED_GROUP_ATTACHMENTS
          : MAX_ATTACHMENTS_PER_TRANSACTION;
      return tr(
        "errors.attachments.tooManyShared",
        "This shared item already has the maximum of {max} documents",
        { max },
      );
    }
    const max = MAX_ATTACHMENTS_PER_TRANSACTION;
    return parent.kind === "transaction"
      ? tr(
          "errors.attachments.tooMany",
          `This transaction already has the maximum of ${max} attachments`,
          { max },
        )
      : tr(
          "errors.attachments.tooManyForWarranty",
          `This warranty already has the maximum of ${max} attachments`,
          { max },
        );
  }

  /**
   * Record that bytes are about to be written at `storageKey`, and commit it.
   *
   * The protocol, its two fences and the reasoning behind them are
   * `storage/object-intent.ts`, shared with the relocation pass that writes the
   * same kind of not-yet-referenced object when a deployment switches providers.
   * These three wrappers exist so this class's narrative keeps naming the step,
   * and to bind each one to the active provider.
   */
  private recordUploadIntent(
    userId: string,
    storageKey: string,
  ): Promise<void> {
    return recordObjectIntent(
      this.dataSource,
      this.storage.name,
      storageKey,
      userId,
    );
  }

  /** Drop the intent inside the caller's transaction, fenced on `swept_at`. */
  private clearUploadIntent(
    m: EntityManager,
    storageKey: string,
  ): Promise<void> {
    return clearObjectIntent(m, this.storage.name, storageKey);
  }

  /** Drop an intent with no work to bind it to; best effort by design. */
  private clearCommittedUploadIntent(storageKey: string): Promise<void> {
    return dropCommittedObjectIntent(
      this.dataSource,
      this.storage.name,
      storageKey,
      (message) =>
        this.logger.warn(
          `Could not clear the upload intent for ${storageKey}; the orphan sweep ` +
            `will retry a no-op delete: ${message}`,
        ),
    );
  }

  /**
   * List attachment metadata under one of the user's parents, a transaction or
   * a warranty (no bytes).
   *
   * A transaction's list is its own attachments followed by the documents of
   * every warranty linked to it, archived or not (the maintainer's ruling,
   * `attachment-parent.ts`); each row names its warranty. A warranty's list is
   * its own documents alone.
   *
   * Primaries only: a scan pair is one attachment, and its original is reached
   * through `originalAttachmentId` rather than listed beside the row it belongs
   * to. The id and the warranty's name come from two LEFT JOINs, not a query
   * per row.
   */
  async findAllFor(
    userId: string,
    parent: AttachmentParent,
  ): Promise<AttachmentListItem[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const shared = isSharedAttachmentParent(parent);
      if (shared)
        await authorizeSharedAttachmentParent(m, userId, parent, false);
      const rows = await this.listQuery(m)
        .where(
          parent.kind === "transaction"
            ? `${reachedTransactionIdSql("ta", "w")} = :parentId`
            : `ta.${parentColumn(parent)} = :parentId`,
          { parentId: parent.id },
        )
        .andWhere(shared ? "TRUE" : "ta.user_id = :userId", { userId })
        .andWhere(primaryAttachmentSql("ta"))
        // Own rows first (their warranty_id is NULL, and FALSE sorts before
        // TRUE), then the warranties' documents; upload order within each.
        .orderBy("ta.warranty_id IS NOT NULL", "ASC")
        .addOrderBy("ta.created_at", "ASC")
        .getRawAndEntities();

      return rows.entities.map((entity, index) =>
        // Raw and entity rows are the same query in the same order, so the
        // index pairs them; `getRawAndEntities` guarantees that alignment.
        toListItem(entity, rows.raw[index] as ListRawRow | undefined),
      );
    });
  }

  /**
   * The list read's shape, shared with the kind update's response: each
   * attachment row beside the id of its scan original and the name of the
   * warranty it hangs off. The caller adds the restriction.
   */
  private listQuery(m: EntityManager) {
    return m
      .getRepository(TransactionAttachment)
      .createQueryBuilder("ta")
      .leftJoin(
        TransactionAttachment,
        "orig",
        "orig.original_of_attachment_id = ta.id",
      )
      .addSelect("orig.id", "orig_id")
      .leftJoin(Warranty, "w", reachingWarrantyJoinSql("ta", "w"))
      .addSelect("w.name", "warranty_name");
  }

  /**
   * Change what a warranty's document is, after upload.
   *
   * A transaction's attachment has no kind to change (W4), so the refusal is
   * the same 400 `create` gives a kind on a transaction parent. A scan pair is
   * one document, so the hidden original takes the kind in the same statement
   * as its visible row; a pair that disagreed would be two documents to the
   * next read. The load, the refusal and the write share one transaction, so a
   * refused request has written nothing.
   */
  async updateDocumentKind(
    userId: string,
    id: string,
    documentKind: DocumentKind,
  ): Promise<AttachmentListItem> {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(TransactionAttachment);
      const row = await repo.findOne({ where: { id, userId } });
      if (!row) {
        throw new NotFoundException(
          tr("errors.attachments.notFound", "Attachment not found"),
        );
      }
      if (row.warrantyId === null) {
        throw new BadRequestException(
          tr(
            "errors.attachments.documentKindNotForTransaction",
            "A document kind applies only to a warranty's documents",
          ),
        );
      }
      await m.query(
        `UPDATE transaction_attachments SET document_kind = $1
          WHERE (id = $2 OR original_of_attachment_id = $2) AND user_id = $3`,
        [documentKind, id, userId],
      );
      const updated = await this.listQuery(m)
        .where("ta.id = :id", { id })
        .andWhere("ta.user_id = :userId", { userId })
        .getRawAndEntities();
      const entity = updated.entities[0];
      if (!entity) {
        // Deleted between the lock-free load and the read-back: the row the
        // caller named is gone, which is the not-found above, not a success.
        throw new NotFoundException(
          tr("errors.attachments.notFound", "Attachment not found"),
        );
      }
      return toListItem(entity, updated.raw[0] as ListRawRow | undefined);
    });
  }

  /**
   * How much attachment storage each user is occupying, keyed by user id.
   *
   * The only cross-user read in this service, and the one method here that does
   * not take a `userId`: the caller is the admin user list, which asks about
   * everybody at once. It therefore requires an ambient **system** context --
   * under any user's own scope RLS answers with that user's rows alone, which
   * would read as "every other account stores nothing" rather than as an error.
   *
   * `byte_size` is the metadata row's record of the bytes written, so the answer
   * is the same figure whichever storage provider holds them -- `database`,
   * `local` or `s3` -- and needs no object store enumerated. It is also why this
   * is one grouped aggregate rather than a query per user.
   *
   * Every row counts, including the unprocessed original of a scan pair, which
   * `findAllFor` deliberately hides: an original the user chose to
   * keep occupies its bytes whether or not the register lists it beside the
   * visible half.
   *
   * A user with no attachments is absent from the map rather than present with
   * zero -- `GROUP BY` has no row to emit for them -- and the caller supplies
   * the zero, which is the honest figure for an account that stores nothing.
   */
  async summarizeUsageByUser(): Promise<Map<string, AttachmentStorageUsage>> {
    // The context is checked rather than assumed, because the failure it
    // prevents is silent: under a user's own scope the policy answers with that
    // user's rows and the aggregate comes back looking complete, with every
    // other account reading as zero bytes. A throw is the only way a caller
    // that forgot the system context finds out.
    if (getRequestContext()?.system !== true) {
      throw new Error(
        "summarizeUsageByUser reads every user's rows and requires an ambient system context",
      );
    }

    const rows: Array<{ user_id: string; files: string; bytes: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT user_id, COUNT(*) AS files, COALESCE(SUM(byte_size), 0) AS bytes
             FROM transaction_attachments
            GROUP BY user_id`,
        ),
      );
    // COUNT and SUM over a BIGINT both come back as strings from the pg driver
    // (numeric and bigint alike), so they are converted at the boundary rather
    // than left to concatenate somewhere downstream.
    return new Map(
      rows.map((row) => [
        row.user_id,
        { files: Number(row.files), bytes: Number(row.bytes) },
      ]),
    );
  }

  /**
   * Load one attachment's bytes and headers for streaming download.
   *
   * A delegate reaches this only through the `warranties` section (the route's
   * decorators, checked by `AccountDelegateGuard`), so the only parent they may
   * read is a warranty's: a transaction's attachment keeps the owner-only rule
   * it had before the route admitted delegates at all (design 6.5).
   */
  async getForDownload(
    userId: string,
    id: string,
    reader: AttachmentReader = {},
  ): Promise<AttachmentDownload> {
    const attachment = await withScopedDb(this.dataSource, (m) =>
      authorizedAttachment(m, userId, id),
    );
    if (!attachment) {
      throw new NotFoundException(
        tr("errors.attachments.notFound", "Attachment not found"),
      );
    }
    if (reader.isDelegate === true && attachment.warrantyId === null) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.actionNotAvailableAsDelegate",
          "This action isn't available while you're acting on behalf of another user. Only the account owner can do this.",
        ),
      );
    }

    // The row says where its bytes are, and that is not necessarily where new
    // bytes go: a provider switch is relocated in the background, so until the
    // pass reaches this row the answer is the backend it still names. Reading
    // through the active provider instead returned 404 for every attachment
    // uploaded before the switch -- metadata listed, bytes intact and unasked for.
    const source = this.registry.require(attachment.storageProvider);
    const data = await source.load(attachment.storageKey);
    return {
      data,
      contentType: attachment.contentType,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
    };
  }

  /**
   * Delete an attachment (metadata + bytes) the user owns.
   *
   * The metadata delete commits first and the object goes afterwards. That order
   * is deliberate and was previously the other way round: deleting the object
   * inside the transaction meant a commit failure left metadata pointing at bytes
   * that no longer existed -- a download that can only fail, with nothing to
   * retry (audit P4-010).
   *
   * The `AFTER DELETE` trigger records a tombstone in the same transaction, so
   * the object is deleted even if this process dies here, and even when the row
   * goes away through a path with no application code at all: a parent
   * transaction's ON DELETE CASCADE, a restore wipe, an account deletion.
   */
  async remove(userId: string, id: string): Promise<void> {
    const storageKeys = await withScopedDb(this.dataSource, async (m) => {
      const attachment = await authorizedAttachment(m, userId, id, true);
      if (attachment.sharedGroupId || attachment.sharedEntryId) {
        await recordSharedDocumentActivity(
          m,
          userId,
          attachment.sharedGroupId
            ? { kind: "shared-group", id: attachment.sharedGroupId }
            : { kind: "shared-entry", id: attachment.sharedEntryId! },
          "DOCUMENT_REMOVED",
          attachment,
        );
      }
      // A scan pair is one attachment, so deleting the visible row takes its
      // original with it. The cascade would do that anyway; naming the original
      // here is what RETURNS its storage key, so its bytes go now rather than
      // waiting for the hourly sweep to notice the tombstone.
      const deleted: unknown = await m.query(
        `DELETE FROM transaction_attachments
          WHERE (id = $1 OR original_of_attachment_id = $1) AND user_id = $2
          RETURNING storage_provider, storage_key`,
        [id, attachment.userId],
      );
      const rows = returnedRows<{
        storage_provider: string;
        storage_key: string;
      }>(deleted);
      if (rows.length === 0) {
        // "Not found" covers both never-existed and already-deleted-by-a-
        // concurrent-request. Either way there is nothing left to sweep.
        throw new NotFoundException(
          tr("errors.attachments.notFound", "Attachment not found"),
        );
      }
      // The provider comes from the row for the same reason the download does:
      // an attachment deleted before the relocation pass reached it holds its
      // bytes in the backend it names, and sweeping the active one would leave
      // them behind under a tombstone the hourly pass then has to find.
      return rows.map((row) => ({
        provider: row.storage_provider,
        key: row.storage_key,
      }));
    });

    // Committed. Now the part PostgreSQL could not have rolled back.
    for (const { provider, key } of storageKeys) {
      await this.orphanSweeper.sweepKey(key, provider);
    }
  }
}

/** One list row: the entity beside what the list's joins added. */
function toListItem(
  entity: TransactionAttachment,
  raw: ListRawRow | undefined,
): AttachmentListItem {
  return {
    ...entity,
    originalAttachmentId: raw?.orig_id ?? null,
    warrantyName: raw?.warranty_name ?? null,
  };
}
