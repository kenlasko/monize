import { Entity, ManyToOne, JoinColumn, PrimaryColumn } from "typeorm";
import { TransactionSplit } from "../../transactions/entities/transaction-split.entity";
import { Tag } from "./tag.entity";

@Entity("transaction_split_tags")
export class TransactionSplitTag {
  @PrimaryColumn({ type: "uuid", name: "transaction_split_id" })
  transactionSplitId: string;

  @PrimaryColumn({ type: "uuid", name: "tag_id" })
  tagId: string;

  @ManyToOne(() => TransactionSplit, { onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_split_id" })
  transactionSplit: TransactionSplit;

  @ManyToOne(() => Tag, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tag_id" })
  tag: Tag;
}
