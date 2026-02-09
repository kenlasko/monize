import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Transaction } from "./transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { Account } from "../../accounts/entities/account.entity";

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

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: "linked_transaction_id" })
  linkedTransaction: Transaction | null;

  @ApiProperty({ example: -50.0, description: "Amount for this split" })
  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @ApiProperty({ example: "Groceries portion", required: false })
  @Column({ type: "text", nullable: true })
  memo: string | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
