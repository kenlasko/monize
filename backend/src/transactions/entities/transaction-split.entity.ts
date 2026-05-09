import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  OneToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Transaction } from "./transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { Tag } from "../../tags/entities/tag.entity";
import { Account } from "../../accounts/entities/account.entity";
import { InvestmentTransaction } from "../../securities/entities/investment-transaction.entity";
import { SplitKind } from "./split-kind.enum";

@Entity("transaction_splits")
export class TransactionSplit {
  @ApiProperty({ example: "split-uuid" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "transaction-uuid" })
  @Column({ type: "uuid", name: "transaction_id" })
  transactionId: string;

  @ManyToOne(() => Transaction)
  @JoinColumn({ name: "transaction_id" })
  transaction: Transaction;

  @ApiProperty({
    enum: SplitKind,
    description:
      "Discriminator for the split type. 'category' assigns the split to a category, 'transfer' moves cash to another account, 'investment' embeds an investment action (BUY/SELL/etc) whose cash impact is this split's amount.",
  })
  @Column({ type: "varchar", length: 20, default: SplitKind.CATEGORY })
  kind: SplitKind;

  @ApiProperty({ example: "category-uuid", required: false })
  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @ApiProperty({
    example: "account-uuid",
    required: false,
    description: "Target account for transfer splits",
  })
  @Column({ type: "uuid", name: "transfer_account_id", nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: "transfer_account_id" })
  transferAccount: Account | null;

  @ApiProperty({
    example: "linked-transaction-uuid",
    required: false,
    description: "Linked transaction in target account for transfer splits",
  })
  @Column({ type: "uuid", name: "linked_transaction_id", nullable: true })
  linkedTransactionId: string | null;

  @ManyToOne(() => Transaction, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "linked_transaction_id" })
  linkedTransaction: Transaction | null;

  @ApiProperty({ example: -50.0, description: "Amount for this split" })
  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @ApiProperty({ example: "Groceries portion", required: false })
  @Column({ type: "text", nullable: true })
  memo: string | null;

  @ManyToMany(() => Tag)
  @JoinTable({
    name: "transaction_split_tags",
    joinColumn: { name: "transaction_split_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags: Tag[];

  @OneToOne(
    () => InvestmentTransaction,
    (investmentTransaction) => investmentTransaction.transactionSplit,
    { nullable: true },
  )
  investmentTransaction: InvestmentTransaction | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
