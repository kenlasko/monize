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
import { User } from "../../users/entities/user.entity";
import { Payee } from "../../payees/entities/payee.entity";

export type EmailReceiptParserStatus = "draft" | "approved";
export type EmailReceiptParserSource = "manual" | "ai";

export const EMAIL_RECEIPT_PARSER_STATUSES: readonly EmailReceiptParserStatus[] =
  ["draft", "approved"];
export const EMAIL_RECEIPT_PARSER_SOURCES: readonly EmailReceiptParserSource[] =
  ["manual", "ai"];

/** The schema's bounds on the two sender-matching arrays. */
export const EMAIL_RECEIPT_PARSER_MAX_FROM_DOMAINS = 10;
export const EMAIL_RECEIPT_PARSER_MAX_SUBJECT_WORDS = 10;

/**
 * A per-merchant extraction definition (design section 5). `definition` is
 * validated by the application on write; a row restored from a support backup
 * can still hold the column default (`{}`), which a reader must treat as
 * invalid rather than throw on.
 *
 * Column defaults mirror `database/migrations/*_add_email_receipts.sql`: the
 * RLS spec builds its schema from these entities. `revision` is the
 * compare-and-swap counter for updates.
 */
@Entity("email_receipt_parsers")
@Index("idx_email_receipt_parsers_user", ["userId"])
export class EmailReceiptParser {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "uuid", name: "payee_id", nullable: true })
  payeeId: string | null;

  @ManyToOne(() => Payee, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "payee_id" })
  payee?: Payee | null;

  @Column({
    type: "text",
    array: true,
    name: "from_domains",
    default: () => "ARRAY['example.invalid']::text[]",
  })
  fromDomains: string[];

  @Column({
    type: "text",
    array: true,
    name: "subject_contains",
    default: () => "'{}'::text[]",
  })
  subjectContains: string[];

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  definition: Record<string, unknown>;

  @Column({ type: "varchar", length: 10, default: "draft" })
  status: EmailReceiptParserStatus;

  @Column({ type: "varchar", length: 10, default: "manual" })
  source: EmailReceiptParserSource;

  @Column({ type: "timestamptz", name: "approved_at", nullable: true })
  approvedAt: Date | null;

  /** Compare-and-swap counter for updates. */
  @Column({ type: "int", default: 1 })
  revision: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
