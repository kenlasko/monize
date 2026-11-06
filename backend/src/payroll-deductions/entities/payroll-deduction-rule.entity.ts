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
import { Category } from "../../categories/entities/category.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { User } from "../../users/entities/user.entity";

/** The periods a rule can reset on. Yearly only for now (spec decision 4). */
export const PAYROLL_RESET_PERIODS = ["YEARLY"] as const;
export type PayrollResetPeriod = (typeof PAYROLL_RESET_PERIODS)[number];

/** A DATE column read as `YYYY-MM-DD` text, never as an instant. */
const dateTransformer = {
  from: (value: string | Date | null): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

/**
 * A yearly maximum on one deduction category of one payroll scheduled bill
 * (docs/specs/payroll-deductions.md section 5.1). Read when the bill posts and
 * when the forecast is drawn; it never changes a posted row (INV-PAYROLL-001).
 * Declared unique here as well as in SQL because the integration suite builds
 * tables from the decorators alone.
 */
@Entity("payroll_deduction_rules")
@Unique("uq_payroll_deduction_rule_line", [
  "scheduledTransactionId",
  "categoryId",
])
export class PayrollDeductionRule {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "scheduled_transaction_id" })
  scheduledTransactionId: string;

  @ManyToOne(() => ScheduledTransaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "scheduled_transaction_id" })
  scheduledTransaction?: ScheduledTransaction;

  @Column({ type: "uuid", name: "category_id" })
  categoryId: string;

  @ManyToOne(() => Category, { onDelete: "CASCADE" })
  @JoinColumn({ name: "category_id" })
  category?: Category;

  /** A magnitude in the bill's account currency. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "yearly_maximum",
  })
  yearlyMaximum: number;

  @Column({
    type: "varchar",
    length: 20,
    name: "reset_period",
    default: "YEARLY",
  })
  resetPeriod: PayrollResetPeriod;

  @Column({ type: "date", name: "reset_date", transformer: dateTransformer })
  resetDate: string;

  /** Read only when the bill has no split line for the category. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "expected_per_paycheque",
    nullable: true,
  })
  expectedPerPaycheque: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
