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
import { User } from "../../users/entities/user.entity";
import { PayrollDeductionRule } from "./payroll-deduction-rule.entity";

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
 * A rule's figures from one period start on (docs/specs/payroll-deductions.md
 * section 11): the period starting on `P` uses the row with the greatest
 * `periodStart <= P`. Declared unique here as well as in SQL because the
 * integration suite builds tables from the decorators alone.
 */
@Entity("payroll_deduction_rule_periods")
@Unique("uq_payroll_deduction_rule_period", ["ruleId", "periodStart"])
export class PayrollDeductionRulePeriod {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "rule_id" })
  ruleId: string;

  @ManyToOne(() => PayrollDeductionRule, (rule) => rule.periods, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "rule_id" })
  rule?: PayrollDeductionRule;

  @Column({
    type: "date",
    name: "period_start",
    transformer: dateTransformer,
  })
  periodStart: string;

  /** A magnitude in the bill's account currency. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "yearly_maximum",
  })
  yearlyMaximum: number;

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
