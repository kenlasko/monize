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
import { BudgetPeriod } from "./budget-period.entity";
import { BudgetBucket, BudgetBucketTargetType } from "./budget-bucket.entity";

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

/**
 * One bucket's row in one budget period (docs/future-plans/bucket-budget.md
 * section 6.3): the carry it received when the period was created, and the
 * figures frozen at the close. `bucketId` is null once the bucket is deleted;
 * `bucketName` keeps the name as it was when the row was last written.
 */
@Entity("budget_period_buckets")
@Unique("uq_budget_period_buckets_period_bucket", [
  "budgetPeriodId",
  "bucketId",
])
export class BudgetPeriodBucket {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "budget_period_id" })
  budgetPeriodId: string;

  @ManyToOne(() => BudgetPeriod, (bp) => bp.periodBuckets, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "budget_period_id" })
  budgetPeriod?: BudgetPeriod;

  @Column({ type: "uuid", name: "bucket_id", nullable: true })
  bucketId: string | null;

  @ManyToOne(() => BudgetBucket, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "bucket_id" })
  bucket?: BudgetBucket | null;

  @Column({ type: "varchar", length: 50, name: "bucket_name" })
  bucketName: string;

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

  /** Bucket income at the close; null while open or when unknown. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "income_basis",
    nullable: true,
    transformer: decimalTransformer,
  })
  incomeBasis: number | null;

  /** Null while open, and when the allocation is unknown at the close. */
  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "allocated_amount",
    nullable: true,
    transformer: decimalTransformer,
  })
  allocatedAmount: number | null;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "carry_in",
    default: 0,
    transformer: decimalTransformer,
  })
  carryIn: number;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "actual_amount",
    default: 0,
    transformer: decimalTransformer,
  })
  actualAmount: number;

  @Column({
    type: "decimal",
    precision: 24,
    scale: 8,
    name: "carry_out",
    default: 0,
    transformer: decimalTransformer,
  })
  carryOut: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
