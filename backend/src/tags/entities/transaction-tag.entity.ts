import { Entity, ManyToOne, JoinColumn, PrimaryColumn } from "typeorm";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Tag } from "./tag.entity";

@Entity("transaction_tags")
export class TransactionTag {
  @PrimaryColumn({ type: "uuid", name: "transaction_id" })
  transactionId: string;

  @PrimaryColumn({ type: "uuid", name: "tag_id" })
  tagId: string;

  @ManyToOne(() => Transaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_id" })
  transaction: Transaction;

  @ManyToOne(() => Tag, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tag_id" })
  tag: Tag;
}
