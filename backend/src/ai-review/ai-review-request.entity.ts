import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "../users/entities/user.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { EmailReceipt } from "../email-receipts/entities/email-receipt.entity";

/**
 * What a request asks for. `transaction_review` is a rule's (or a person's)
 * question about one transaction; `email_receipt` is raised for a stored order
 * confirmation and carries `emailReceiptId` (email-receipts design section 4).
 * Mirrors the schema's `ck_ai_review_requests_kind`.
 */
export type AiReviewRequestKind = "transaction_review" | "email_receipt";

export type AiReviewRequestStatus =
  | "pending"
  | "claimed"
  | "proposed"
  | "applied"
  | "rejected"
  | "expired";

/** The states in which a request still waits for someone; the dedupe covers exactly these. */
export const OPEN_AI_REVIEW_STATUSES = [
  "pending",
  "claimed",
  "proposed",
] as const satisfies readonly AiReviewRequestStatus[];

/** The instruction's length bound, the same as the schema's CHECK. */
export const MAX_AI_REVIEW_INSTRUCTION_LENGTH = 1000;

/** How long a request waits before it expires (the schema's default). */
export const AI_REVIEW_REQUEST_LIFETIME_DAYS = 30;

/**
 * One durable request that an AI look at one transaction (design 6.5). It
 * carries the instruction and the transaction id, never a copy of the row.
 * Column defaults mirror `database/migrations/*_add_ai_review_requests.sql`:
 * the RLS spec builds its schema from these entities. The partial unique index
 * is the dedupe the enqueue's `ON CONFLICT` infers.
 */
@Entity("ai_review_requests")
@Index("uq_ai_review_requests_open", ["transactionId", "ruleId"], {
  unique: true,
  where: "status IN ('pending', 'claimed', 'proposed')",
})
@Index("idx_ai_review_requests_claim", ["userId", "status", "createdAt"])
export class AiReviewRequest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "transaction_id" })
  transactionId: string;

  @ManyToOne(() => Transaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction;

  /** Null for a manual request, and after the asking rule was deleted. */
  @Column({ type: "uuid", name: "rule_id", nullable: true })
  ruleId: string | null;

  @ManyToOne(() => TransactionRule, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "rule_id" })
  rule?: TransactionRule | null;

  @Column({ type: "varchar", length: 40, default: "transaction_review" })
  kind: AiReviewRequestKind;

  /** The rule's instruction: user data, never an instruction to Monize. */
  @Column({ type: "text" })
  instruction: string;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: AiReviewRequestStatus;

  @Column({ type: "text", name: "claimed_by", nullable: true })
  claimedBy: string | null;

  @Column({ type: "timestamptz", name: "claimed_at", nullable: true })
  claimedAt: Date | null;

  /** The signed pending action an agent submitted (a later task). */
  @Column({ type: "jsonb", nullable: true })
  proposal: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @Column({
    type: "timestamptz",
    name: "expires_at",
    // now(), not CURRENT_TIMESTAMP: TypeORM's postgres driver rewrites any
    // default containing CURRENT_TIMESTAMP to a bare now(), dropping the interval.
    default: () => `now() + INTERVAL '${AI_REVIEW_REQUEST_LIFETIME_DAYS} days'`,
  })
  expiresAt: Date;

  /**
   * The stored email a request of kind `email_receipt` was raised for; null for
   * every other kind, and after the email was deleted (ON DELETE SET NULL: the
   * request outlives its email).
   */
  @Column({ type: "uuid", name: "email_receipt_id", nullable: true })
  emailReceiptId: string | null;

  @ManyToOne(() => EmailReceipt, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "email_receipt_id" })
  emailReceipt?: EmailReceipt | null;
}
