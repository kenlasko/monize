import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { BudgetPeriod } from "./budget-period.entity";
import { BudgetCategory } from "./budget-category.entity";
import { Category } from "../../categories/entities/category.entity";

@Entity("budget_period_categories")
export class BudgetPeriodCategory {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "budget_period_id" })
  budgetPeriodId: string;

  @ManyToOne(() => BudgetPeriod, (bp) => bp.periodCategories)
  @JoinColumn({ name: "budget_period_id" })
  budgetPeriod: BudgetPeriod;

  @Column({ type: "uuid", name: "budget_category_id" })
  budgetCategoryId: string;

  @ManyToOne(() => BudgetCategory)
  @JoinColumn({ name: "budget_category_id" })
  budgetCategory: BudgetCategory;

  @Column({ type: "uuid", name: "category_id", nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "category_id" })
  category: Category | null;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "budgeted_amount",
  })
  budgetedAmount: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "rollover_in",
    default: 0,
  })
  rolloverIn: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "actual_amount",
    default: 0,
  })
  actualAmount: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "effective_budget",
  })
  effectiveBudget: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 4,
    name: "rollover_out",
    default: 0,
  })
  rolloverOut: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
