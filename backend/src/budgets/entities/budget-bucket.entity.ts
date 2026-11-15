import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { Budget } from "./budget.entity";

export enum BudgetBucketTargetType {
  PERCENT = "PERCENT",
  AMOUNT = "AMOUNT",
}

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

/**
 * One named pot of a Bucket-strategy budget
 * (docs/future-plans/bucket-budget.md section 6.1). The target is a percent of
 * bucket income (`PERCENT`) or an amount in the budget's currency per period
 * (`AMOUNT`). Declared unique here as well as in SQL because the integration
 * suite builds tables from the decorators alone; the case-insensitive name
 * rule is the service's.
 */
@Entity("budget_buckets")
@Unique("uq_budget_buckets_budget_name", ["budgetId", "name"])
export class BudgetBucket {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "budget_id" })
  budgetId: string;

  @ManyToOne(() => Budget, (budget) => budget.buckets, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "budget_id" })
  budget?: Budget;

  @Column({ type: "varchar", length: 50 })
  name: string;

  @Column({ type: "varchar", length: 10, name: "target_type" })
  targetType: BudgetBucketTargetType;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "target_value",
    transformer: decimalTransformer,
  })
  targetValue: number;

  @Column({ name: "carry_over", default: false })
  carryOver: boolean;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "carry_cap",
    nullable: true,
    transformer: decimalTransformer,
  })
  carryCap: number | null;

  @Column({ type: "integer", name: "sort_order", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
