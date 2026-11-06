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
import type { ReceiptLinkOutcome } from "../parsing/receipt-parser.types";
import { EmailReceipt } from "./email-receipt.entity";

/**
 * One part of a settlement receipt (linked receipts spec section 5): the part's
 * link value and amount, the component receipt it joined and what it became.
 * The rows of a settlement are replaced in the transaction that stores its new
 * state. `partAmount` is read through raw SQL (`Number(...)`), never through
 * this mapping. Column defaults mirror
 * `database/migrations/*_email_receipt_links.sql`: the RLS spec builds its
 * schema from these entities.
 */
@Entity("email_receipt_links")
@Unique("uq_email_receipt_links_part", ["settlementReceiptId", "partIndex"])
@Index("idx_email_receipt_links_component", ["componentReceiptId"], {
  where: "component_receipt_id IS NOT NULL",
})
@Index("idx_email_receipt_links_waiting", ["userId", "linkValue"], {
  where: "component_receipt_id IS NULL AND link_value IS NOT NULL",
})
export class EmailReceiptLink {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "settlement_receipt_id" })
  settlementReceiptId: string;

  @ManyToOne(() => EmailReceipt, { onDelete: "CASCADE" })
  @JoinColumn({ name: "settlement_receipt_id" })
  settlementReceipt?: EmailReceipt;

  @Column({ type: "int", name: "part_index", default: 0 })
  partIndex: number;

  @Column({ type: "varchar", length: 100, name: "link_value", nullable: true })
  linkValue: string | null;

  @Column({ type: "decimal", precision: 24, scale: 8, name: "part_amount" })
  partAmount: number;

  @Column({ type: "uuid", name: "component_receipt_id", nullable: true })
  componentReceiptId: string | null;

  @ManyToOne(() => EmailReceipt, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "component_receipt_id" })
  componentReceipt?: EmailReceipt | null;

  @Column({ type: "varchar", length: 30, default: "no_link" })
  outcome: ReceiptLinkOutcome;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
