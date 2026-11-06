import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Account } from "../../accounts/entities/account.entity";
import { Category } from "../../categories/entities/category.entity";
import { User } from "../../users/entities/user.entity";
import {
  LoanFeeBasis,
  LoanFeeCalculation,
} from "../../loan-installments/loan-fees";

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * A fee collected with a mortgage payment (docs/specs/mortgage-fees.md
 * section 2): a category line of the payment template, priced per installment
 * by `priceLoanFee` (INV-LOAN-011). Declared unique here as well as in SQL
 * because the integration suite builds tables from the decorators alone.
 */
@Entity("loan_fees")
@Unique("uq_loan_fees_account_category", ["accountId", "categoryId"])
export class LoanFee {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "account_id" })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account?: Account;

  @Column({ type: "uuid", name: "category_id" })
  categoryId: string;

  @ManyToOne(() => Category, { onDelete: "CASCADE" })
  @JoinColumn({ name: "category_id" })
  category?: Category;

  @Column({ type: "varchar", length: 100 })
  name: string;

  @Column({ type: "varchar", length: 30 })
  calculation: LoanFeeCalculation;

  @Column({ type: "varchar", length: 20, default: "PER_PAYMENT" })
  basis: LoanFeeBasis;

  /** A FIXED fee's money; null for a percentage. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    nullable: true,
    transformer: numericTransformer,
  })
  amount: number | null;

  /** A percentage fee's rate, in percent; null for a FIXED fee. */
  @Column({
    type: "decimal",
    precision: 10,
    scale: 6,
    nullable: true,
    transformer: numericTransformer,
  })
  rate: number | null;

  @Column({ type: "integer", name: "sort_order", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
