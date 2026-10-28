/** Read-only relation mapping. Column parity with the source entity is checked by integration tests. */
import type { ReportingProvenance } from "../../accruals/reporting-provenance";
import {
  ViewEntity,
  Index,
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
import { ReportingTransaction } from "./reporting-transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { Tag } from "../../tags/entities/tag.entity";
import { Account } from "../../accounts/entities/account.entity";
import { ReportingInvestment } from "./reporting-investment.entity";
import { SplitKind } from "../../transactions/entities/split-kind.enum";

@ViewEntity({
  name: "accrual_reporting_transaction_splits",
  synchronize: false,
})
@Index("uq_accrual_split_parent", ["id", "transactionId"], { unique: true })
export class ReportingSplit {
  /** Reporting copies only; never persisted. */
  reportingProvenance?: ReportingProvenance;
  @ApiProperty({ example: "split-uuid" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "transaction-uuid" })
  @Column({ type: "uuid", name: "transaction_id" })
  transactionId: string;

  // `database/schema.sql` declares ON DELETE CASCADE; stated here so the
  // entity-built integration schema deletes a parent the way production does.
  @ManyToOne(() => ReportingTransaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_id" })
  transaction: ReportingTransaction;

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

  @ManyToOne(() => Category, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @ApiProperty({
    example: "account-uuid",
    required: false,
    description: "Target account for transfer splits",
  })
  @Column({ type: "uuid", name: "transfer_account_id", nullable: true })
  transferAccountId: string | null;

  @ManyToOne(() => Account, { nullable: true, onDelete: "CASCADE" })
  @JoinColumn({ name: "transfer_account_id" })
  transferAccount: Account | null;

  @ApiProperty({
    example: "linked-transaction-uuid",
    required: false,
    description: "Linked transaction in target account for transfer splits",
  })
  @Column({ type: "uuid", name: "linked_transaction_id", nullable: true })
  linkedTransactionId: string | null;

  @ManyToOne(() => ReportingTransaction, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "linked_transaction_id" })
  linkedTransaction: ReportingTransaction | null;

  @ApiProperty({ example: -50.0, description: "Amount for this split" })
  @Column({ type: "decimal", precision: 20, scale: 4 })
  amount: number;

  @ApiProperty({ example: "Groceries portion", required: false })
  @Column({ type: "text", nullable: true })
  memo: string | null;

  @ManyToMany(() => Tag)
  @JoinTable({
    name: "accrual_reporting_transaction_split_tags",
    synchronize: false,
    joinColumn: { name: "transaction_split_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "tag_id", referencedColumnName: "id" },
  })
  tags: Tag[];

  @OneToOne(
    () => ReportingInvestment,
    (investmentTransaction) => investmentTransaction.transactionSplit,
    { nullable: true },
  )
  investmentTransaction: ReportingInvestment | null;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
