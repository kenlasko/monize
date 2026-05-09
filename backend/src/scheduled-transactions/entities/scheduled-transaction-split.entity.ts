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
import { Security } from "../../securities/entities/security.entity";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../transactions/entities/split-kind.enum";

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

  @Column({ type: "varchar", length: 20, default: SplitKind.CATEGORY })
  kind: SplitKind;

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

  // Investment-split fields (populated when kind === SplitKind.INVESTMENT)

  @Column({
    type: "varchar",
    length: 50,
    name: "investment_action",
    nullable: true,
  })
  investmentAction: InvestmentAction | null;

  @Column({ type: "uuid", name: "investment_security_id", nullable: true })
  investmentSecurityId: string | null;

  @ManyToOne(() => Security, { nullable: true })
  @JoinColumn({ name: "investment_security_id" })
  investmentSecurity: Security | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 8,
    name: "investment_quantity",
    nullable: true,
  })
  investmentQuantity: number | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 6,
    name: "investment_price",
    nullable: true,
  })
  investmentPrice: number | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "investment_commission",
    nullable: true,
  })
  investmentCommission: number | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "investment_exchange_rate",
    nullable: true,
  })
  investmentExchangeRate: number | null;

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
