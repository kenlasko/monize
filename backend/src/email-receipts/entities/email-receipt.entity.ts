import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { EmailReceiptMailbox } from "./email-receipt-mailbox.entity";
import { EmailReceiptParser } from "./email-receipt-parser.entity";

/** Where a stored email stands in the pipeline (design section 6). */
export type EmailReceiptStatus =
  | "pending"
  | "skipped"
  | "no_parser"
  | "parse_failed"
  | "unmatched"
  | "ambiguous"
  | "review_conflict"
  | "review"
  | "ignored";

export const EMAIL_RECEIPT_STATUSES: readonly EmailReceiptStatus[] = [
  "pending",
  "skipped",
  "no_parser",
  "parse_failed",
  "unmatched",
  "ambiguous",
  "review_conflict",
  "review",
  "ignored",
];

/** How the receipt was tied to its transaction (the schema's match_kind CHECK). */
export type EmailReceiptMatchKind =
  | "order_id"
  | "amount_payee"
  | "amount_only"
  | "manual";

export const EMAIL_RECEIPT_MATCH_KINDS: readonly EmailReceiptMatchKind[] = [
  "order_id",
  "amount_payee",
  "amount_only",
  "manual",
];

/** The schema's bounds on a stored email and on the candidate list. */
export const EMAIL_RECEIPT_MAX_BODY_CHARS = 100_000;
export const EMAIL_RECEIPT_MAX_CANDIDATES = 10;

/**
 * One stored order-confirmation email (design sections 3.9, 4 and 6). The raw
 * MIME source and the HTML are not stored: `bodyText` is the converted text.
 * `(mailboxId, uidValidity, uid)` is the ingestion idempotency, and
 * `aiReviewRequestId` carries no foreign key because `ai_review_requests`
 * references this table.
 *
 * `uidValidity` and `uid` are bigint columns, so strings here. Column defaults
 * mirror `database/migrations/*_add_email_receipts.sql`: the RLS spec builds
 * its schema from these entities.
 */
@Entity("email_receipts")
@Unique("uq_email_receipts_message", ["mailboxId", "uidValidity", "uid"])
@Index("idx_email_receipts_user_status", ["userId", "status", "receivedAt"])
export class EmailReceipt {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "mailbox_id" })
  mailboxId: string;

  @ManyToOne(() => EmailReceiptMailbox, { onDelete: "CASCADE" })
  @JoinColumn({ name: "mailbox_id" })
  mailbox?: EmailReceiptMailbox;

  @Column({ type: "bigint", name: "uid_validity" })
  uidValidity: string;

  @Column({ type: "bigint" })
  uid: string;

  @Column({ type: "varchar", length: 500, name: "message_id", nullable: true })
  messageId: string | null;

  @Column({ type: "varchar", length: 320, name: "from_address" })
  fromAddress: string;

  @Column({ type: "varchar", length: 255, name: "from_domain" })
  fromDomain: string;

  @Column({ type: "varchar", length: 500 })
  subject: string;

  @Column({ type: "timestamptz", name: "received_at" })
  receivedAt: Date;

  @Column({ type: "text", name: "body_text" })
  bodyText: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: EmailReceiptStatus;

  @Column({
    type: "varchar",
    length: 40,
    name: "status_reason",
    nullable: true,
  })
  statusReason: string | null;

  @Column({ type: "uuid", name: "parser_id", nullable: true })
  parserId: string | null;

  @ManyToOne(() => EmailReceiptParser, {
    onDelete: "SET NULL",
    nullable: true,
  })
  @JoinColumn({ name: "parser_id" })
  parser?: EmailReceiptParser | null;

  /** The parser's `ParsedReceipt` (design 5.3), or null before a parse. */
  @Column({ type: "jsonb", nullable: true })
  parsed: Record<string, unknown> | null;

  @Column({ type: "uuid", name: "transaction_id", nullable: true })
  transactionId: string | null;

  @ManyToOne(() => Transaction, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction | null;

  @Column({
    type: "uuid",
    array: true,
    name: "candidate_transaction_ids",
    default: () => "'{}'::uuid[]",
  })
  candidateTransactionIds: string[];

  @Column({
    type: "varchar",
    length: 20,
    name: "match_kind",
    nullable: true,
  })
  matchKind: EmailReceiptMatchKind | null;

  @Column({ type: "uuid", name: "ai_review_request_id", nullable: true })
  aiReviewRequestId: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
