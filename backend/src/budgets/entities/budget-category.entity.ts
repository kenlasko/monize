import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Budget } from "./budget.entity";
import { Category } from "../../categories/entities/category.entity";
import { Account } from "../../accounts/entities/account.entity";

const decimalTransformer = {
  from: (value: string | null): number | null => {
    if (value === null || value === undefined) return null;
    return parseFloat(value);
  },
  to: (value: number | null): number | null => value,
};

export enum RolloverType {
  NONE = "NONE",
  MONTHLY = "MONTHLY",
  QUARTERLY = "QUARTERLY",
  ANNUAL = "ANNUAL",
}

export enum CategoryGroup {
  NEED = "NEED",
  WANT = "WANT",
  SAVING = "SAVING",
}

@Entity("budget_categories")
export class BudgetCategory {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "budget_id" })
  budgetId: string;

  @ManyToOne(() => Budget, (budget) => budget.categories)
  @JoinColumn({ name: "budget_id" })
  budget: Budget;

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

  @Column({ name: "is_transfer", default: false })
  isTransfer: boolean;

  @Column({
    type: "varchar",
    length: 20,
    name: "category_group",
    nullable: true,
  })
  categoryGroup: CategoryGroup | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    transformer: decimalTransformer,
  })
  amount: number;

  @Column({ name: "is_income", default: false })
  isIncome: boolean;

  @Column({
    type: "varchar",
    length: 20,
    name: "rollover_type",
    default: RolloverType.NONE,
  })
  rolloverType: RolloverType;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "rollover_cap",
    nullable: true,
    transformer: decimalTransformer,
  })
  rolloverCap: number | null;

  @Column({ type: "varchar", length: 100, name: "flex_group", nullable: true })
  flexGroup: string | null;

  @Column({
    type: "integer",
    name: "alert_warn_percent",
    default: 80,
  })
  alertWarnPercent: number;

  @Column({
    type: "integer",
    name: "alert_critical_percent",
    default: 95,
  })
  alertCriticalPercent: number;

  @Column({ type: "text", nullable: true })
  notes: string | null;

  @Column({ type: "integer", name: "sort_order", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
