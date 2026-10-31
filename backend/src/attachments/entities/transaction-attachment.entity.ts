import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Check,
  CreateDateColumn,
  Index,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { User } from "../../users/entities/user.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Warranty } from "../../warranties/entities/warranty.entity";
import {
  DEFAULT_DOCUMENT_KIND,
  DOCUMENT_KINDS,
  DocumentKind,
} from "../attachment-parent";

/**
 * Metadata for a file attached to a transaction, warranty, shared group or
 * shared entry. Shared publication creates an independent attachment.
 *
 * Exactly one of `transactionId`, `warrantyId`, `sharedGroupId` and
 * `sharedEntryId` is set (WTY-003, SE-011,
 * `chk_attachment_one_parent` in database/schema.sql). That CHECK is declared
 * in SQL only, as the warranty entity's cross-column rules are: the RLS spec's
 * generic row seeder leaves every nullable, non-ownership foreign key NULL and
 * could not satisfy it. The table keeps its historical name.
 *
 * Provider-agnostic: the bytes themselves live wherever `storageProvider` points
 * -- the built-in "database" provider keeps them in `attachment_blobs`, keyed by
 * `storageKey`. This table stays free of BYTEA so listing attachments never
 * pulls file bytes into memory.
 */
@Entity("transaction_attachments")
@Index(["transactionId"])
@Index(["warrantyId"])
// Declared here as well as in the migration, because the database-backed suites
// build their schema from the entities: without them a scan pair's integrity is
// a property of production alone, and the suites that exist to prove it would
// be asserting against a table that cannot break.
@Index("uq_transaction_attachments_original_of", ["originalOfAttachmentId"], {
  unique: true,
  where: "original_of_attachment_id IS NOT NULL",
})
@Check(
  "chk_attachment_not_own_original",
  "original_of_attachment_id IS NULL OR original_of_attachment_id <> id",
)
@Check(
  "chk_attachment_document_kind",
  "document_kind IN ('receipt', 'manual', 'photo', 'warranty', 'other')",
)
export class TransactionAttachment {
  @ApiProperty({ example: "c5f5d5f0-1234-4567-890a-123456789abc" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "user-uuid" })
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  /** The private parent transaction, when this is a transaction document. */
  @ApiProperty({ example: "transaction-uuid", nullable: true })
  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ManyToOne(() => Transaction, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction | null;

  /** The private parent warranty, when this is a warranty document. */
  @ApiProperty({ example: "warranty-uuid", nullable: true })
  @Column({ type: "uuid", name: "warranty_id", nullable: true })
  warrantyId: string | null;

  @ManyToOne(() => Warranty, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "warranty_id" })
  warranty?: Warranty | null;

  @Column({ type: "uuid", name: "shared_group_id", nullable: true })
  sharedGroupId: string | null;

  @Column({ type: "uuid", name: "shared_entry_id", nullable: true })
  sharedEntryId: string | null;

  @Column({
    type: "varchar",
    length: 36,
    name: "upload_request_id",
    nullable: true,
  })
  uploadRequestId: string | null;

  @Column({
    type: "varchar",
    length: 64,
    name: "upload_fingerprint",
    nullable: true,
  })
  uploadFingerprint: string | null;

  @Column({ type: "integer", name: "document_revision", default: 1 })
  documentRevision: number;

  /**
   * What a warranty's document is. A transaction's attachments always carry
   * the default: the register offers no picker (design question W4).
   */
  @ApiProperty({
    example: "receipt",
    enum: DOCUMENT_KINDS,
  })
  @Column({
    type: "varchar",
    name: "document_kind",
    length: 20,
    default: DEFAULT_DOCUMENT_KIND,
  })
  documentKind: DocumentKind;

  @ApiProperty({ example: "grocery-receipt.jpg" })
  @Column({ type: "varchar", length: 255 })
  filename: string;

  @ApiProperty({
    example: "image/jpeg",
    description: "Server-sniffed MIME type",
  })
  @Column({ type: "varchar", name: "content_type", length: 100 })
  contentType: string;

  @ApiProperty({ example: 154213, description: "File size in bytes" })
  @Column({
    type: "bigint",
    name: "byte_size",
    transformer: bigintTransformer(),
  })
  byteSize: number;

  @ApiProperty({ description: "SHA-256 hex digest of the original bytes" })
  @Column({ type: "char", length: 64 })
  sha256: string;

  @ApiProperty({ example: "database" })
  @Column({
    type: "varchar",
    name: "storage_provider",
    length: 20,
    default: "database",
  })
  storageProvider: string;

  @ApiProperty({ description: "Opaque handle the storage provider resolves" })
  @Column({ type: "varchar", name: "storage_key", length: 512 })
  storageKey: string;

  /**
   * Set on the unprocessed original of a scanned document; points at the
   * visible (enhanced) attachment. NULL for an ordinary attachment and for the
   * visible half of a scan pair -- which is what "a visible attachment" means
   * everywhere it is read (`primary-attachment.util.ts`). The link lives on the
   * original so the database cascade removes it with its visible row.
   */
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "Set on the unprocessed original of a scan pair; points at the visible attachment",
  })
  @Column({
    type: "uuid",
    name: "original_of_attachment_id",
    nullable: true,
  })
  originalOfAttachmentId: string | null;

  /**
   * The relation exists so the foreign key and its cascade are part of what
   * TypeORM builds, not only of `schema.sql` -- the database-backed suites
   * synchronize from these entities, and a bare `@Column` would give them a
   * plain uuid with nothing to violate, passing every test about the link by
   * having no link at all.
   */
  @ManyToOne(() => TransactionAttachment, {
    nullable: true,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "original_of_attachment_id" })
  originalOfAttachment?: TransactionAttachment | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}

/**
 * BIGINT columns come back from the pg driver as strings; convert to number so
 * byteSize is a plain JS number in API responses and Content-Length math.
 */
function bigintTransformer() {
  return {
    to: (value: number | null): number | null => value,
    from: (value: string | null): number | null =>
      value === null ? null : Number(value),
  };
}
