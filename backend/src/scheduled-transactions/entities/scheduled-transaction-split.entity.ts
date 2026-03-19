import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
} from "typeorm";
import { ScheduledTransaction } from "./scheduled-transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { Account } from "../../accounts/entities/account.entity";
import { Tag } from "../../tags/entities/tag.entity";

@Entity("scheduled_transaction_splits")
export class ScheduledTransactionSplit {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "scheduled_transaction_id" })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, (st) => st.splits, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "scheduled_transaction_id" })
  scheduledTransaction: ScheduledTransaction;

  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @Column({ type: "uuid", name: "transfer_account_id", nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "transfer_account_id" })
  transferAccount: Account | null;

  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @Column({ type: "text", nullable: true })
  memo: string | null;

  @ManyToMany(() => Tag)
  @JoinTable({
    name: "scheduled_transaction_split_tags",
    joinColumn: {
      name: "scheduled_transaction_split_id",
      referencedColumnName: "id",
    },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags: Tag[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
